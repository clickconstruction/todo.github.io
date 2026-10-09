-- Quarterly checks: a checkbox ticked once per quarterly check-in (Horizons), for the questions the user
-- asks themselves every quarter ("Am I making businesses?"). It is the weekly check (20261107000001) with
-- every = 'quarter':
--   tasks.daily = {tier, every: 'quarter', since}
-- Everything a daily one has holds for it (no dates or repeat, never "available", ticks in daily_ticks,
-- un-ticking keeps the row), and like a weekly check it is never asked for on a day. It is listed on the
-- quarterly check-in page, where it counts as ticked if it was ticked since the last "Quarterly check-in
-- done" (user_settings.horizons_quarter_at; a tick that day counts when it came after the click). The
-- rules are in js/daily-rules.js; review_apply already carries every through, so a Full Review suggestion
-- {daily: {tier, every: 'quarter'}} needs nothing more here.
alter table public.tasks drop constraint if exists tasks_daily_every;
alter table public.tasks add constraint tasks_daily_every check (daily is null or not daily ? 'every' or daily->>'every' in ('week', 'quarter'));
