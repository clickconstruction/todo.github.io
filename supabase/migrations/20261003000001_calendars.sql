-- Calendars shown in Forecast: a private iCal link per calendar (Google "secret address",
-- iCloud or Outlook published links). The link is a secret: only its owner can read it, the
-- app shows it masked, and the MCP server never returns it. Events aren't stored: the MCP Worker
-- fetches the feed (cached ~10 minutes) and the app reads it. Archived, never deleted.
create table public.calendars (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 100),
  url text not null check (url ~ '^(https|webcal)://' and length(url) <= 2000),
  color text not null default '#1D9E75' check (color ~ '^#[0-9A-Fa-f]{6}$'),
  enabled boolean not null default true,
  sort double precision not null default 0,
  last_ok_at timestamptz,
  last_error text,
  event_count int,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.calendars (user_id);
alter table public.calendars enable row level security;
create policy "owner select" on public.calendars for select to authenticated using ((select auth.uid()) = user_id);
create policy "owner insert" on public.calendars for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "owner update" on public.calendars for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create trigger calendars_touch before update on public.calendars for each row execute function public.touch_updated_at();
create trigger calendars_no_delete before delete on public.calendars for each row execute function public.forbid_delete();
