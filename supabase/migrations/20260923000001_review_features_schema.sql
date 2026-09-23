-- Schema for the OmniFocus-style features: Planned dates, estimates, project types,
-- complete-with-last-action, action groups, project flags/tags, and Review.
-- Rules live in triggers so the app, the MCP server and SQL all behave the same.

-- ---------- columns ----------
alter table public.tasks
  add column planned_at timestamptz,
  add column estimate_minutes int check (estimate_minutes is null or estimate_minutes between 0 and 100000);

alter table public.projects
  add column complete_with_last boolean not null default false,
  add column flagged boolean not null default false,
  add column last_reviewed_at timestamptz,
  add column completed_at timestamptz;

alter table public.projects
  add constraint projects_review_every_days_positive check (review_every_days between 1 and 3650);

create index tasks_planned_idx on public.tasks (user_id, planned_at) where planned_at is not null and completed_at is null and dropped_at is null;
create index tasks_due_idx on public.tasks (user_id, due_at) where due_at is not null and completed_at is null and dropped_at is null;
create index projects_review_idx on public.projects (user_id, next_review_at) where status in ('active', 'on_hold');

-- ---------- project tags ----------
create table public.project_tags (
  project_id uuid not null references public.projects(id) on delete cascade,
  tag_id uuid not null references public.tags(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  primary key (project_id, tag_id)
);
create index on public.project_tags (tag_id);
create index on public.project_tags (user_id);
alter table public.project_tags enable row level security;
create policy "owner select" on public.project_tags for select to authenticated using ((select auth.uid()) = user_id);
create policy "owner insert" on public.project_tags for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "owner delete" on public.project_tags for delete to authenticated using ((select auth.uid()) = user_id);

-- ---------- review schedule ----------
-- next_review_at is derived: last review (or creation) + interval.
create or replace function public.projects_review_schedule() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.next_review_at := coalesce(new.last_reviewed_at, new.created_at, now()) + make_interval(days => new.review_every_days);
  -- Record when a project was finished; clear it if reopened.
  if new.status in ('completed', 'dropped') and (tg_op = 'INSERT' or old.status not in ('completed', 'dropped')) then
    new.completed_at := now();
  elsif new.status in ('active', 'on_hold') then
    new.completed_at := null;
  end if;
  return new;
end $$;

create trigger projects_review_schedule before insert or update on public.projects
  for each row execute function public.projects_review_schedule();

update public.projects set review_every_days = review_every_days; -- backfill next_review_at

-- ---------- action groups ----------
-- A task with children is a group:
--   completing/dropping the group closes its open children;
--   when the last open child closes (and at least one completed), the group completes;
--   reopening a child, or adding an open child, reopens a completed group.
create or replace function public.tasks_group_rules() returns trigger
language plpgsql set search_path = '' as $$
declare
  was_open boolean := tg_op = 'INSERT' or (old.completed_at is null and old.dropped_at is null);
  is_open boolean := new.completed_at is null and new.dropped_at is null;
begin
  if pg_trigger_depth() > 3 then return null; end if;

  -- Group closed: close its open children the same way.
  if was_open and not is_open then
    update public.tasks c
       set completed_at = coalesce(c.completed_at, new.completed_at),
           dropped_at = case when new.completed_at is null then coalesce(c.dropped_at, new.dropped_at) else c.dropped_at end
     where c.parent_id = new.id and c.completed_at is null and c.dropped_at is null;
  end if;

  if new.parent_id is not null then
    if not is_open and not exists (
         select 1 from public.tasks s where s.parent_id = new.parent_id and s.completed_at is null and s.dropped_at is null)
       and exists (select 1 from public.tasks s where s.parent_id = new.parent_id and s.completed_at is not null) then
      update public.tasks p set completed_at = now()
       where p.id = new.parent_id and p.completed_at is null and p.dropped_at is null;
    elsif is_open then
      update public.tasks p set completed_at = null
       where p.id = new.parent_id and p.completed_at is not null;
    end if;
  end if;
  return null;
end $$;

create trigger tasks_group_rules after insert or update of completed_at, dropped_at, parent_id on public.tasks
  for each row execute function public.tasks_group_rules();

-- ---------- complete with last action ----------
create or replace function public.tasks_complete_project() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.project_id is not null and new.completed_at is not null and old.completed_at is null
     and not exists (select 1 from public.tasks t where t.project_id = new.project_id and t.completed_at is null and t.dropped_at is null) then
    update public.projects p set status = 'completed'
     where p.id = new.project_id and p.complete_with_last and p.status in ('active', 'on_hold');
  end if;
  return null;
end $$;

create trigger tasks_complete_project after update of completed_at on public.tasks
  for each row execute function public.tasks_complete_project();
