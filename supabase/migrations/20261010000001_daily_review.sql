-- Daily review: "Start your day" (calendar, must-dos, up to 3 focus items) and "Shut down"
-- (capture, carry over what didn't happen, glance at tomorrow). One row per day; nothing deleted.
--   * user_settings: an optional morning notification (off by default), its time and weekdays only.
--   * push_log.kind 'daily' for that notification.
create table public.daily_reviews (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  day date not null,
  started_at timestamptz,
  shutdown_at timestamptz,
  focus jsonb not null default '[]' check (jsonb_typeof(focus) = 'array' and jsonb_array_length(focus) <= 5),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, day)
);
alter table public.daily_reviews enable row level security;
create policy "owner select" on public.daily_reviews for select to authenticated using ((select auth.uid()) = user_id);
create policy "owner insert" on public.daily_reviews for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "owner update" on public.daily_reviews for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create trigger daily_reviews_touch before update on public.daily_reviews for each row execute function public.touch_updated_at();
create trigger daily_reviews_no_delete before delete on public.daily_reviews for each row execute function public.forbid_delete();

alter table public.user_settings
  add column daily_notify boolean not null default false,
  add column daily_minutes int not null default 420 check (daily_minutes between 0 and 1439),
  add column daily_weekdays_only boolean not null default true,
  add column daily_notified_at timestamptz;

alter table public.push_log drop constraint push_log_kind_check;
alter table public.push_log add constraint push_log_kind_check check (kind in ('test', 'reminder', 'place', 'review', 'daily'));
