-- Events: things on the user's own calendar (an airshow, a trip, an appointment) that Todo Tooling
-- holds itself, next to the read-only calendars it subscribes to. They show in Forecast on every day
-- they cover, go out in the private calendar feed (so they reach Apple or Google Calendar), and are
-- added in the app (Forecast → + Event) or by an agent (the `events` MCP tool).
--
-- Timed events: starts_at / ends_at are instants. All-day events: starts_at is local midnight of the
-- first day and ends_at is local midnight of the day AFTER the last day (exclusive, as iCalendar does
-- it), in the user's time zone. Not actions: nothing to tick off. Archived, never deleted.

create table public.events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title text not null check (length(trim(title)) between 1 and 200),
  notes text not null default '',
  location text not null default '' check (length(location) <= 500),
  url text not null default '' check (url = '' or (url ~ '^https?://' and length(url) <= 2000)),
  all_day boolean not null default false,
  starts_at timestamptz not null,
  ends_at timestamptz not null check (ends_at >= starts_at),
  project_id uuid references public.projects(id),
  place_id uuid references public.places(id),
  source text not null default 'app',
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.events (user_id, starts_at);

alter table public.events enable row level security;
create policy "owner select" on public.events for select to authenticated using ((select auth.uid()) = user_id);
create policy "owner insert" on public.events for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "owner update" on public.events for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

create trigger events_touch before update on public.events for each row execute function public.touch_updated_at();
create trigger events_no_delete before delete on public.events for each row execute function public.forbid_delete();
