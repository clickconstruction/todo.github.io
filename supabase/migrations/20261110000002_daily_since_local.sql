-- A daily's since (the day it became daily, 20261101000001) is stamped in the user's time zone
-- (user_settings.timezone, UTC when none), not the server's: stamped in UTC, a daily made after 7 pm
-- Central got tomorrow's date and stayed out of Today until the next day.
create or replace function public.tasks_daily_guard() returns trigger language plpgsql set search_path = '' as $$
declare tz text;
begin
  if new.daily is not null then
    new.repeat_rule := null; new.due_at := null; new.planned_at := null; new.defer_at := null;
    -- since: the day it became daily (kept through later edits), so earlier days never count as missed.
    if not new.daily ? 'since' then
      select coalesce(nullif(s.timezone, ''), 'UTC') into tz from public.user_settings s where s.user_id = new.user_id;
      new.daily := new.daily || jsonb_build_object('since', case when tg_op = 'UPDATE' and old.daily ? 'since' then old.daily->>'since' else to_char(now() at time zone coalesce(tz, 'UTC'), 'YYYY-MM-DD') end);
    end if;
  end if;
  return new;
end $$;
