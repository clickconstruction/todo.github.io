-- Places: saved locations (Home Depot, Office, a jobsite) that actions, tags and projects
-- can point at. An action's effective place is its own, else one of its tags', else its
-- project's, else one of its project's tags'. Each place-bearing row can say when to
-- alert: arriving, leaving, or while nearby, within a radius (default ¼ mile = 402 m).
-- Places are archived, never deleted (same rule as folders, projects and tasks).

create table public.places (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 200),
  address text not null default '',
  lat double precision not null check (lat between -90 and 90),
  lng double precision not null check (lng between -180 and 180),
  google_place_id text,
  radius_m int not null default 402 check (radius_m between 25 and 80467),
  notes text not null default '',
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.places (user_id);

alter table public.places enable row level security;
create policy "owner select" on public.places for select to authenticated using ((select auth.uid()) = user_id);
create policy "owner insert" on public.places for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "owner update" on public.places for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

create trigger places_touch before update on public.places
  for each row execute function public.touch_updated_at();
create trigger places_no_delete before delete on public.places
  for each row execute function public.forbid_delete();

-- ---------- place, trigger and radius on tasks, tags and projects ----------
-- location_trigger null = no alert (the place still counts for Nearby and distance sort).
-- location_radius_m null = use the place's radius.
do $$
declare t text;
begin
  foreach t in array array['tasks', 'tags', 'projects'] loop
    execute format($f$
      alter table public.%1$I
        add column place_id uuid references public.places(id) on delete set null,
        add column location_trigger text check (location_trigger in ('arrive', 'leave', 'nearby')),
        add column location_radius_m int check (location_radius_m between 25 and 80467)$f$, t);
    execute format('create index on public.%I (place_id) where place_id is not null', t);
  end loop;
end $$;

-- A row may only point at its owner's own place.
create or replace function public.guard_place_owner() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.place_id is not null and not exists (
       select 1 from public.places p where p.id = new.place_id and p.user_id = new.user_id) then
    raise exception 'Place not found.' using errcode = 'foreign_key_violation';
  end if;
  return new;
end $$;

create trigger tasks_guard_place before insert or update of place_id on public.tasks
  for each row execute function public.guard_place_owner();
create trigger tags_guard_place before insert or update of place_id on public.tags
  for each row execute function public.guard_place_owner();
create trigger projects_guard_place before insert or update of place_id on public.projects
  for each row execute function public.guard_place_owner();
