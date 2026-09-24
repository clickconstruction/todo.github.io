-- Schedule it (time blocks) and checklists.
--   * tasks.scheduled_at / scheduled_minutes: a time block on the calendar (Forecast's day view, the
--     private calendar feed, "Add to calendar").
--   * api_tokens scope 'feed': a secret calendar-feed address (read-only: scheduled actions as events).
--   * checklists: reusable lists (items: [{id, text, section?}]); runs record each time through.
--     An action can carry a checklist (tasks.checklist_id); the next occurrence of a repeating
--     action keeps it and starts fresh. complete_action: ticking the last item completes the action.
-- Nothing is deleted: checklists are archived, runs are kept.

alter table public.tasks
  add column scheduled_at timestamptz,
  add column scheduled_minutes int check (scheduled_minutes between 5 and 720);
create index tasks_scheduled on public.tasks (user_id, scheduled_at) where scheduled_at is not null;

alter table public.api_tokens drop constraint api_tokens_scope_check;
alter table public.api_tokens add constraint api_tokens_scope_check check (scope in ('full', 'geo', 'capture', 'feed'));

create table public.checklists (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 200),
  items jsonb not null default '[]' check (jsonb_typeof(items) = 'array' and jsonb_array_length(items) <= 300),
  complete_action boolean not null default true,
  sort double precision not null default 0,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.checklists (user_id);
alter table public.checklists enable row level security;
create policy "owner select" on public.checklists for select to authenticated using ((select auth.uid()) = user_id);
create policy "owner insert" on public.checklists for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "owner update" on public.checklists for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create trigger checklists_touch before update on public.checklists for each row execute function public.touch_updated_at();
create trigger checklists_no_delete before delete on public.checklists for each row execute function public.forbid_delete();

alter table public.tasks add column checklist_id uuid references public.checklists(id) on delete set null;
create index on public.tasks (checklist_id) where checklist_id is not null;

create table public.checklist_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  checklist_id uuid not null references public.checklists(id) on delete cascade,
  task_id uuid references public.tasks(id) on delete set null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  ticked jsonb not null default '[]' check (jsonb_typeof(ticked) = 'array'),
  total int not null default 0 check (total >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.checklist_runs (checklist_id, started_at desc);
create index on public.checklist_runs (task_id) where task_id is not null;
-- One run in progress per checklist (per action it's attached to).
create unique index checklist_runs_one_open on public.checklist_runs (checklist_id, coalesce(task_id, '00000000-0000-0000-0000-000000000000'::uuid)) where finished_at is null;
alter table public.checklist_runs enable row level security;
create policy "owner select" on public.checklist_runs for select to authenticated using ((select auth.uid()) = user_id);
create policy "owner insert" on public.checklist_runs for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "owner update" on public.checklist_runs for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create trigger checklist_runs_touch before update on public.checklist_runs for each row execute function public.touch_updated_at();
create trigger checklist_runs_no_delete before delete on public.checklist_runs for each row execute function public.forbid_delete();

-- A task's checklist, and a run's checklist and task, must be the owner's own.
create or replace function public.checklist_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_table_name = 'tasks' then
    if new.checklist_id is not null and not exists (select 1 from public.checklists c where c.id = new.checklist_id and c.user_id = new.user_id) then
      raise exception 'Checklist not found.' using errcode = 'foreign_key_violation';
    end if;
  else
    if not exists (select 1 from public.checklists c where c.id = new.checklist_id and c.user_id = new.user_id)
       or (new.task_id is not null and not exists (select 1 from public.tasks t where t.id = new.task_id and t.user_id = new.user_id)) then
      raise exception 'Checklist or action not found.' using errcode = 'foreign_key_violation';
    end if;
  end if;
  return new;
end $$;
create trigger tasks_checklist_guard before insert or update of checklist_id on public.tasks for each row execute function public.checklist_guard();
create trigger checklist_runs_guard before insert or update of checklist_id, task_id on public.checklist_runs for each row execute function public.checklist_guard();

-- The next occurrence of a repeating action keeps its checklist, energy and time block (shifted).
create or replace function public.repeat_clone_task(t public.tasks, shift interval, new_parent uuid, new_project uuid, rule jsonb)
returns uuid language plpgsql set search_path = '' as $$
declare new_id uuid := gen_random_uuid();
begin
  insert into public.tasks (id, user_id, project_id, parent_id, in_inbox, title, notes, flagged, defer_at, planned_at, due_at,
                            estimate_minutes, place_id, location_trigger, location_radius_m, sort, source, repeat_rule, steps_in_order,
                            energy, checklist_id, scheduled_at, scheduled_minutes)
  values (new_id, t.user_id, new_project, new_parent, t.in_inbox, t.title, t.notes, t.flagged,
          t.defer_at + shift, t.planned_at + shift, t.due_at + shift,
          t.estimate_minutes, t.place_id, t.location_trigger, t.location_radius_m, t.sort, 'repeat', rule, t.steps_in_order,
          t.energy, t.checklist_id, t.scheduled_at + shift, t.scheduled_minutes);
  insert into public.task_tags (task_id, tag_id, user_id) select new_id, tag_id, user_id from public.task_tags where task_id = t.id;
  insert into public.notifications (user_id, task_id, kind, offset_minutes, at)
    select user_id, new_id, kind, offset_minutes, at + coalesce(shift, interval '0') from public.notifications where task_id = t.id;
  return new_id;
end $$;
