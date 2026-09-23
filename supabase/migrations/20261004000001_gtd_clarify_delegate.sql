-- GTD practices: Tickler, Reference, People (Waiting For + Agendas) and Energy.
--   * Tickler: an Inbox item held until a day (defer_at, 6am local), then it's back in the Inbox.
--   * Reference: non-actionable information, filed by topic, optionally project support material,
--     with an optional hidden value (codes) and attachments. Never in action lists.
--   * People: who you delegate to / meet with. A person can be linked to an existing tag
--     ("Waiting : Hiro"), so items with that tag count as waiting on them.
--   * Tasks: waiting_on (delegated to), delegated_at, follow_up_at; agenda_for (discuss with);
--     energy (low/medium/high). Waiting and agenda items aren't "available" next actions.
-- Nothing is deleted: people and reference items are archived.

create table public.people (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 100),
  email text check (email is null or length(email) <= 200),
  phone text check (phone is null or length(phone) <= 40),
  notes text not null default '',
  tag_id uuid references public.tags(id) on delete set null,
  sort double precision not null default 0,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.people (user_id);
alter table public.people enable row level security;
create policy "owner select" on public.people for select to authenticated using ((select auth.uid()) = user_id);
create policy "owner insert" on public.people for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "owner update" on public.people for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create trigger people_touch before update on public.people for each row execute function public.touch_updated_at();
create trigger people_no_delete before delete on public.people for each row execute function public.forbid_delete();

create table public.reference_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title text not null check (length(trim(title)) between 1 and 300),
  body text not null default '' check (length(body) <= 100000),
  topic text not null default '' check (length(topic) <= 200),
  secret_value text check (secret_value is null or length(secret_value) <= 2000),
  project_id uuid references public.projects(id) on delete set null,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.reference_items (user_id);
create index on public.reference_items (project_id) where project_id is not null;
alter table public.reference_items enable row level security;
create policy "owner select" on public.reference_items for select to authenticated using ((select auth.uid()) = user_id);
create policy "owner insert" on public.reference_items for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "owner update" on public.reference_items for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create trigger reference_items_touch before update on public.reference_items for each row execute function public.touch_updated_at();
create trigger reference_items_no_delete before delete on public.reference_items for each row execute function public.forbid_delete();

alter table public.tasks
  add column energy text check (energy in ('low', 'medium', 'high')),
  add column waiting_on uuid references public.people(id) on delete set null,
  add column delegated_at timestamptz,
  add column follow_up_at timestamptz,
  add column agenda_for uuid references public.people(id) on delete set null,
  add column tickler boolean not null default false,
  add column reference_id uuid references public.reference_items(id) on delete set null;
create index tasks_waiting_on on public.tasks (waiting_on) where waiting_on is not null;
create index tasks_agenda_for on public.tasks (agenda_for) where agenda_for is not null;

-- A task's person and reference must be the owner's own.
create or replace function public.tasks_people_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (new.waiting_on is not null and not exists (select 1 from public.people p where p.id = new.waiting_on and p.user_id = new.user_id))
     or (new.agenda_for is not null and not exists (select 1 from public.people p where p.id = new.agenda_for and p.user_id = new.user_id))
     or (new.reference_id is not null and not exists (select 1 from public.reference_items r where r.id = new.reference_id and r.user_id = new.user_id)) then
    raise exception 'Person or reference not found.' using errcode = 'foreign_key_violation';
  end if;
  if new.waiting_on is not null and (tg_op = 'INSERT' or old.waiting_on is distinct from new.waiting_on) and new.delegated_at is null then
    new.delegated_at := now();
  end if;
  if new.waiting_on is null then new.follow_up_at := null; end if;
  return new;
end $$;
create trigger tasks_people_guard before insert or update of waiting_on, agenda_for, reference_id, follow_up_at on public.tasks
  for each row execute function public.tasks_people_guard();

-- Attachments can also belong to a reference item.
alter table public.attachments add column reference_id uuid references public.reference_items(id) on delete cascade;
alter table public.attachments drop constraint attachments_check;
alter table public.attachments add constraint attachments_one_owner check (num_nonnulls(task_id, project_id, reference_id) = 1);
create index on public.attachments (reference_id) where reference_id is not null;
create or replace function public.attachments_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (new.task_id is not null and not exists (select 1 from public.tasks t where t.id = new.task_id and t.user_id = new.user_id))
     or (new.project_id is not null and not exists (select 1 from public.projects p where p.id = new.project_id and p.user_id = new.user_id))
     or (new.reference_id is not null and not exists (select 1 from public.reference_items r where r.id = new.reference_id and r.user_id = new.user_id)) then
    raise exception 'Item not found.' using errcode = 'foreign_key_violation';
  end if;
  if split_part(new.path, '/', 1) <> new.user_id::text then
    raise exception 'Attachment path must be inside your folder.' using errcode = 'check_violation';
  end if;
  return new;
end $$;
drop trigger attachments_guard on public.attachments;
create trigger attachments_guard before insert or update of task_id, project_id, reference_id, path on public.attachments
  for each row execute function public.attachments_guard();
