-- Yearly checks: a checkbox ticked once per yearly review (Horizons), the quarterly check (20261108000001)
-- with every = 'year'. The yearly review's "Yearly review done" is user_settings.horizons_year_at, like the
-- quarterly check-in's horizons_quarter_at. The rules (a tick holds half the cycle, then lapses; the done
-- click starts the checks fresh) are in js/daily-rules.js and need nothing here.
alter table public.tasks drop constraint if exists tasks_daily_every;
alter table public.tasks add constraint tasks_daily_every check (daily is null or not daily ? 'every' or daily->>'every' in ('week', 'quarter', 'year'));
alter table public.user_settings add column if not exists horizons_year_at timestamptz;
