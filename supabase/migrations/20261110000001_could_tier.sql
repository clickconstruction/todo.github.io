-- A third daily tier, could ("Could, if I feel like it"): a menu of options folded away at the bottom of
-- Today. Ticked on the days the user picks it; never a miss, never a must-do. Same column, same ticks, same
-- guards as must and should (20261101000001); only the tier check widens. The rules are in js/daily-rules.js.
alter table public.tasks drop constraint if exists tasks_daily_check;
alter table public.tasks add constraint tasks_daily_check
  check (daily is null or (jsonb_typeof(daily) = 'object' and daily->>'tier' in ('must', 'should', 'could')
    and (not daily ? 'weekdays' or (jsonb_typeof(daily->'weekdays') = 'array' and jsonb_array_length(daily->'weekdays') between 1 and 7))));
