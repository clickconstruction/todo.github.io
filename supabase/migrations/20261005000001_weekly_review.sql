-- The GTD Weekly Review (Get Clear, Get Current, Get Creative), the mind sweep trigger list and
-- Someday/Maybe.
--   * weekly_reviews: one row per review. steps = {step key: {done_at, n}} so a review started on
--     one device can be finished on another. At most one open review per user; an abandoned one is
--     set aside (abandoned_at), never deleted.
--   * user_settings: review day and time (local), whether to send a reminder, and the mind sweep
--     prompts the user hid or added.
--   * task_tags.created_at: when a tag was put on (how long an item has been parked in Someday).
--   * push_log.kind 'review': the weekly review reminder.

create table public.weekly_reviews (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  abandoned_at timestamptz,
  steps jsonb not null default '{}' check (jsonb_typeof(steps) = 'object'),
  stats jsonb not null default '{}' check (jsonb_typeof(stats) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.weekly_reviews (user_id, started_at desc);
create unique index weekly_reviews_one_open on public.weekly_reviews (user_id) where completed_at is null and abandoned_at is null;
alter table public.weekly_reviews enable row level security;
create policy "owner select" on public.weekly_reviews for select to authenticated using ((select auth.uid()) = user_id);
create policy "owner insert" on public.weekly_reviews for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "owner update" on public.weekly_reviews for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create trigger weekly_reviews_touch before update on public.weekly_reviews for each row execute function public.touch_updated_at();
create trigger weekly_reviews_no_delete before delete on public.weekly_reviews for each row execute function public.forbid_delete();

alter table public.user_settings
  add column review_day int not null default 5 check (review_day between 0 and 6),          -- 0 = Sunday; Friday by default
  add column review_minutes int not null default 900 check (review_minutes between 0 and 1439), -- 3pm
  add column review_notify boolean not null default true,
  add column review_notified_at timestamptz,
  add column trigger_hidden jsonb not null default '[]' check (jsonb_typeof(trigger_hidden) = 'array' and jsonb_array_length(trigger_hidden) <= 500),
  add column trigger_custom jsonb not null default '[]' check (jsonb_typeof(trigger_custom) = 'array' and jsonb_array_length(trigger_custom) <= 200);

alter table public.task_tags add column created_at timestamptz not null default now();

alter table public.push_log drop constraint push_log_kind_check;
alter table public.push_log add constraint push_log_kind_check check (kind in ('test', 'reminder', 'place', 'review'));
