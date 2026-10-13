-- People groups (what someone is to you: Crew, Suppliers, Family) and who is on which project.
-- A person is in one group or none; a person can be on several projects, with a role word.
-- Groups are archived, never deleted; archiving one files its people under "no group".
-- project_people rows are links (like tag links) and may be removed.

create table public.people_groups (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 60),
  sort double precision not null default 0,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.people_groups (user_id);
alter table public.people_groups enable row level security;
create policy "owner select" on public.people_groups for select to authenticated using ((select auth.uid()) = user_id);
create policy "owner insert" on public.people_groups for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "owner update" on public.people_groups for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create trigger people_groups_touch before update on public.people_groups for each row execute function public.touch_updated_at();
create trigger people_groups_no_delete before delete on public.people_groups for each row execute function public.forbid_delete();

alter table public.people add column group_id uuid references public.people_groups(id) on delete set null;
create index on public.people (group_id);

-- A person's group is one of their owner's, and not an archived one.
create or replace function public.people_group_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.group_id is not null and not exists (select 1 from public.people_groups g where g.id = new.group_id and g.user_id = new.user_id and g.archived_at is null) then
    raise exception 'A person''s group must be one of your own, and not archived.' using errcode = 'foreign_key_violation';
  end if;
  return new;
end $$;
create trigger people_group_guard before insert or update of group_id on public.people
  for each row execute function public.people_group_guard();

-- Archiving a group files its people under "no group" (restoring it later does not put them back).
create or replace function public.people_groups_archive() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.archived_at is not null and old.archived_at is null then
    update public.people set group_id = null where group_id = new.id;
  end if;
  return new;
end $$;
create trigger people_groups_archive after update of archived_at on public.people_groups
  for each row execute function public.people_groups_archive();

create table public.project_people (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  person_id uuid not null references public.people(id) on delete cascade,
  role text not null default '' check (length(role) <= 40),
  created_at timestamptz not null default now(),
  unique (project_id, person_id)
);
create index on public.project_people (user_id);
create index on public.project_people (person_id);
alter table public.project_people enable row level security;
create policy "owner select" on public.project_people for select to authenticated using ((select auth.uid()) = user_id);
create policy "owner insert" on public.project_people for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "owner update" on public.project_people for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "owner delete" on public.project_people for delete to authenticated using ((select auth.uid()) = user_id);

-- Both ends of a link are the owner's.
create or replace function public.project_people_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if not exists (select 1 from public.projects p where p.id = new.project_id and p.user_id = new.user_id)
     or not exists (select 1 from public.people p where p.id = new.person_id and p.user_id = new.user_id) then
    raise exception 'The project and the person must both be yours.' using errcode = 'foreign_key_violation';
  end if;
  return new;
end $$;
create trigger project_people_guard before insert or update of project_id, person_id on public.project_people
  for each row execute function public.project_people_guard();
