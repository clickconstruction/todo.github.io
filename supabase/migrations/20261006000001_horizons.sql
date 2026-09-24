-- Horizons of Focus: purpose and principles, vision, goals, areas of focus, and project outcomes.
--   * areas: ongoing responsibilities (Click Plumbing, Health, Family), each with "standards"
--     (what good looks like) and a review interval. Separate from folders (filing).
--   * goals: 1-2 year objectives, optionally in an area; projects link to the goal they serve.
--   * user_settings: purpose/principles and vision text, with when each was last read.
--   * projects: outcome ("done looks like…"), area_id, goal_id.
-- Nothing is deleted: areas are archived, goals are achieved or dropped.

create table public.areas (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 100),
  standards text not null default '' check (length(standards) <= 5000),
  review_every_days int not null default 30 check (review_every_days between 1 and 366),
  last_reviewed_at timestamptz,
  sort double precision not null default 0,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.areas (user_id);
alter table public.areas enable row level security;
create policy "owner select" on public.areas for select to authenticated using ((select auth.uid()) = user_id);
create policy "owner insert" on public.areas for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "owner update" on public.areas for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create trigger areas_touch before update on public.areas for each row execute function public.touch_updated_at();
create trigger areas_no_delete before delete on public.areas for each row execute function public.forbid_delete();

create table public.goals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title text not null check (length(trim(title)) between 1 and 300),
  why text not null default '' check (length(why) <= 5000),
  area_id uuid references public.areas(id) on delete set null,
  target_date date,
  status text not null default 'active' check (status in ('active', 'achieved', 'dropped')),
  achieved_at timestamptz,
  review_every_days int not null default 30 check (review_every_days between 1 and 366),
  last_reviewed_at timestamptz,
  sort double precision not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.goals (user_id);
alter table public.goals enable row level security;
create policy "owner select" on public.goals for select to authenticated using ((select auth.uid()) = user_id);
create policy "owner insert" on public.goals for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "owner update" on public.goals for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create trigger goals_touch before update on public.goals for each row execute function public.touch_updated_at();
create trigger goals_no_delete before delete on public.goals for each row execute function public.forbid_delete();

-- A goal's area must be the owner's; achieved_at follows the status.
create or replace function public.goals_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.area_id is not null and not exists (select 1 from public.areas a where a.id = new.area_id and a.user_id = new.user_id) then
    raise exception 'Area not found.' using errcode = 'foreign_key_violation';
  end if;
  if new.status = 'achieved' and new.achieved_at is null then new.achieved_at := now(); end if;
  if new.status <> 'achieved' then new.achieved_at := null; end if;
  return new;
end $$;
create trigger goals_guard before insert or update on public.goals for each row execute function public.goals_guard();

alter table public.projects
  add column outcome text not null default '' check (length(outcome) <= 1000),
  add column area_id uuid references public.areas(id) on delete set null,
  add column goal_id uuid references public.goals(id) on delete set null;
create index on public.projects (area_id) where area_id is not null;
create index on public.projects (goal_id) where goal_id is not null;

create or replace function public.projects_horizons_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (new.area_id is not null and not exists (select 1 from public.areas a where a.id = new.area_id and a.user_id = new.user_id))
     or (new.goal_id is not null and not exists (select 1 from public.goals g where g.id = new.goal_id and g.user_id = new.user_id)) then
    raise exception 'Area or goal not found.' using errcode = 'foreign_key_violation';
  end if;
  return new;
end $$;
create trigger projects_horizons_guard before insert or update of area_id, goal_id on public.projects
  for each row execute function public.projects_horizons_guard();

alter table public.user_settings
  add column purpose text not null default '' check (length(purpose) <= 20000),
  add column purpose_read_at timestamptz,
  add column vision text not null default '' check (length(vision) <= 20000),
  add column vision_year int check (vision_year between 2000 and 2200),
  add column vision_read_at timestamptz;
