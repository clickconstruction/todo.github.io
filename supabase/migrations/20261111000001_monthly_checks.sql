-- Monthly checks: a checkbox ticked once per monthly review (Horizons), the quarterly / yearly check
-- (20261108000001, 20261109000001) with every = 'month'. The monthly review's "Monthly review done" is
-- user_settings.horizons_month_at. A tick holds 15 days (js/daily-rules.js).
alter table public.tasks drop constraint if exists tasks_daily_every;
alter table public.tasks add constraint tasks_daily_every check (daily is null or not daily ? 'every' or daily->>'every' in ('week', 'month', 'quarter', 'year'));
alter table public.user_settings add column if not exists horizons_month_at timestamptz;
