-- Repeating actions and projects (OmniFocus-style).
--
-- repeat_rule (jsonb, null = doesn't repeat):
--   every     int >= 1                  e.g. 2
--   unit      day | week | month | year
--   weekdays  [0..6] (Sun=0), unit=week  e.g. [1,4] = Mon and Thu
--   from      assigned | completion     fixed schedule, or N units after you complete it
--   end_count int (optional)            stop after this many occurrences
--   end_until YYYY-MM-DD (optional)     no occurrence after this date
--   n         int                       this occurrence's number (starts at 1)
--   tz        IANA zone                  local-day math (e.g. America/Chicago)
--
-- Completing a repeating item creates the next occurrence (same title, notes, tags, place,
-- flag, estimate, sub-actions; all dates moved together) and the completed one stops
-- repeating, so it stays in history. Dropping it ends the series. repeat_skip() moves an
-- item to its next occurrence without completing it.

alter table public.tasks add column repeat_rule jsonb check (repeat_rule is null or jsonb_typeof(repeat_rule) = 'object');
alter table public.projects add column repeat_rule jsonb check (repeat_rule is null or jsonb_typeof(repeat_rule) = 'object');

-- Next scheduled occurrence after d, keeping d's local time of day.
create or replace function public.repeat_step(rule jsonb, d timestamptz) returns timestamptz
language plpgsql stable set search_path = '' as $$
declare
  tz text := coalesce(rule->>'tz', 'UTC');
  n int := greatest(1, coalesce((rule->>'every')::int, 1));
  unit text := coalesce(rule->>'unit', 'day');
  loc timestamp := d at time zone tz;
  days int[];
  dow int;
  best int;
begin
  if unit = 'week' and jsonb_typeof(rule->'weekdays') = 'array' and jsonb_array_length(rule->'weekdays') > 0 then
    select array_agg(x::int order by x::int) into days from jsonb_array_elements_text(rule->'weekdays') x;
    dow := extract(dow from loc)::int;
    select min(x) into best from unnest(days) x where x > dow;
    if best is not null then return (loc + make_interval(days => best - dow)) at time zone tz; end if;
    return (loc + make_interval(days => 7 * n - dow + days[1])) at time zone tz; -- first chosen day, N weeks on
  end if;
  return (loc + public.review_interval(n, unit)) at time zone tz;
end $$;

-- Where the next occurrence's anchor date lands. anchor = the item's due, else planned, else defer.
-- Fixed schedules catch up past today (a daily habit completed a week late comes back tomorrow, not 6 times).
create or replace function public.repeat_next_anchor(rule jsonb, anchor timestamptz, completed timestamptz) returns timestamptz
language plpgsql stable set search_path = '' as $$
declare
  tz text := coalesce(rule->>'tz', 'UTC');
  n int := greatest(1, coalesce((rule->>'every')::int, 1));
  unit text := coalesce(rule->>'unit', 'day');
  nxt timestamptz;
  guard int := 0;
begin
  if coalesce(rule->>'from', 'assigned') = 'completion' or anchor is null then
    -- N units after the day it was completed, at the anchor's time of day (midnight if no dates).
    return (((completed at time zone tz)::date + public.review_interval(n, unit))::date
            + coalesce((anchor at time zone tz)::time, time '00:00')) at time zone tz;
  end if;
  nxt := public.repeat_step(rule, anchor);
  while nxt < date_trunc('day', now() at time zone tz) at time zone tz and guard < 1000 loop
    nxt := public.repeat_step(rule, nxt);
    guard := guard + 1;
  end loop;
  return nxt;
end $$;

-- Has the series ended at this occurrence?
create or replace function public.repeat_ended(rule jsonb, next_anchor timestamptz) returns boolean
language sql stable set search_path = '' as $$
  select (rule ? 'end_count' and coalesce((rule->>'n')::int, 1) >= (rule->>'end_count')::int)
      or (rule ? 'end_until' and (next_anchor at time zone coalesce(rule->>'tz', 'UTC'))::date > (rule->>'end_until')::date)
$$;

-- Copy one task (and its tags) with dates moved by `shift`; returns the new id.
create or replace function public.repeat_clone_task(t public.tasks, shift interval, new_parent uuid, new_project uuid, rule jsonb) returns uuid
language plpgsql set search_path = '' as $$
declare new_id uuid := gen_random_uuid();
begin
  insert into public.tasks (id, user_id, project_id, parent_id, in_inbox, title, notes, flagged, defer_at, planned_at, due_at,
                            estimate_minutes, place_id, location_trigger, location_radius_m, sort, source, repeat_rule)
  values (new_id, t.user_id, new_project, new_parent, t.in_inbox, t.title, t.notes, t.flagged,
          t.defer_at + shift, t.planned_at + shift, t.due_at + shift,
          t.estimate_minutes, t.place_id, t.location_trigger, t.location_radius_m, t.sort, 'repeat', rule);
  insert into public.task_tags (task_id, tag_id, user_id) select new_id, tag_id, user_id from public.task_tags where task_id = t.id;
  return new_id;
end $$;

-- ---------- tasks ----------
-- Named tasks_0_repeat so it runs before complete-with-last-action: the next occurrence
-- exists before the project checks whether any action is left.
create or replace function public.tasks_repeat() returns trigger
language plpgsql set search_path = '' as $$
declare
  anchor timestamptz := coalesce(new.due_at, new.planned_at, new.defer_at);
  nxt timestamptz;
  shift interval;
  rule jsonb;
  new_id uuid;
  c public.tasks;
begin
  if new.repeat_rule is null or old.completed_at is not null or new.completed_at is null or new.dropped_at is not null then return null; end if;
  if pg_trigger_depth() > 4 then return null; end if;
  -- A sub-action closed because its repeating group completed: the group's next occurrence
  -- already brought it back, so don't make a second copy (that would reopen the old group).
  if new.parent_id is not null and exists (select 1 from public.tasks p where p.id = new.parent_id and p.completed_at is not null) then
    update public.tasks set repeat_rule = null where id = new.id;
    return null;
  end if;
  nxt := public.repeat_next_anchor(new.repeat_rule, anchor, new.completed_at);
  if not public.repeat_ended(new.repeat_rule, nxt) then
    rule := jsonb_set(new.repeat_rule, '{n}', to_jsonb(coalesce((new.repeat_rule->>'n')::int, 1) + 1));
    if anchor is null then
      new_id := public.repeat_clone_task(new, interval '0', new.parent_id, new.project_id, rule);
      update public.tasks set defer_at = nxt where id = new_id; -- dateless: comes back (deferred) on the next day
    else
      shift := nxt - anchor;
      new_id := public.repeat_clone_task(new, shift, new.parent_id, new.project_id, rule);
    end if;
    -- A repeating group brings back all its sub-actions, open.
    for c in select * from public.tasks where parent_id = new.id and dropped_at is null order by sort loop
      perform public.repeat_clone_task(c, coalesce(shift, interval '0'), new_id, c.project_id, c.repeat_rule);
    end loop;
  end if;
  update public.tasks set repeat_rule = null where id = new.id; -- the completed one is history
  return null;
end $$;

create trigger tasks_0_repeat after update of completed_at on public.tasks
  for each row execute function public.tasks_repeat();

-- ---------- projects ----------
-- Completing a repeating project starts a fresh copy with all its (non-dropped) actions open.
create or replace function public.projects_repeat() returns trigger
language plpgsql set search_path = '' as $$
declare
  anchor timestamptz := coalesce(new.due_at, new.planned_at, new.defer_at);
  nxt timestamptz;
  shift interval;
  rule jsonb;
  new_pid uuid := gen_random_uuid();
  t public.tasks;
  map jsonb := '{}';
  new_tid uuid;
begin
  if new.repeat_rule is null or new.status <> 'completed' or old.status = 'completed' then return null; end if;
  if pg_trigger_depth() > 4 then return null; end if;
  nxt := public.repeat_next_anchor(new.repeat_rule, anchor, coalesce(new.completed_at, now()));
  if not public.repeat_ended(new.repeat_rule, nxt) then
    rule := jsonb_set(new.repeat_rule, '{n}', to_jsonb(coalesce((new.repeat_rule->>'n')::int, 1) + 1));
    shift := nxt - coalesce(anchor, new.created_at);
    insert into public.projects (id, user_id, folder_id, name, notes, status, kind, complete_with_last, flagged, review_every, review_unit,
                                 defer_at, planned_at, due_at, estimate_minutes, place_id, location_trigger, location_radius_m, sort, repeat_rule)
    values (new_pid, new.user_id, new.folder_id, new.name, new.notes, 'active', new.kind, new.complete_with_last, new.flagged, new.review_every, new.review_unit,
            case when anchor is null then nxt else new.defer_at + shift end, new.planned_at + shift, new.due_at + shift,
            new.estimate_minutes, new.place_id, new.location_trigger, new.location_radius_m, new.sort, rule);
    insert into public.project_tags (project_id, tag_id, user_id) select new_pid, tag_id, user_id from public.project_tags where project_id = new.id;
    for t in select * from public.tasks where project_id = new.id and parent_id is null and dropped_at is null order by sort loop
      new_tid := public.repeat_clone_task(t, shift, null, new_pid, t.repeat_rule);
      map := map || jsonb_build_object(t.id::text, new_tid);
    end loop;
    for t in select * from public.tasks where project_id = new.id and parent_id is not null and dropped_at is null order by sort loop
      if map ? t.parent_id::text then
        perform public.repeat_clone_task(t, shift, (map->>t.parent_id::text)::uuid, new_pid, t.repeat_rule);
      end if;
    end loop;
  end if;
  update public.projects set repeat_rule = null where id = new.id;
  return null;
end $$;

create trigger projects_repeat after update of status on public.projects
  for each row execute function public.projects_repeat();

-- ---------- skip ----------
-- Move an open repeating item to its next occurrence without completing it (like "Skip" in OmniFocus).
-- Signed-in users skip their own items; the MCP server (service role, no auth.uid()) passes the owner.
create or replace function public.repeat_skip(task_id uuid, owner uuid default null) returns public.tasks
language plpgsql set search_path = '' as $$
declare
  t public.tasks;
  anchor timestamptz;
  shift interval;
  nxt timestamptz;
begin
  select * into t from public.tasks where id = task_id and user_id = coalesce((select auth.uid()), owner);
  if t.id is null or t.repeat_rule is null then raise exception 'Not a repeating action you own.'; end if;
  anchor := coalesce(t.due_at, t.planned_at, t.defer_at);
  nxt := public.repeat_next_anchor(t.repeat_rule || '{"from":"assigned"}', coalesce(anchor, now()), now());
  shift := nxt - coalesce(anchor, now());
  update public.tasks set
    defer_at = case when anchor is null then nxt else defer_at + shift end,
    planned_at = planned_at + shift, due_at = due_at + shift,
    repeat_rule = jsonb_set(repeat_rule, '{n}', to_jsonb(coalesce((repeat_rule->>'n')::int, 1) + 1))
  where id = t.id
  returning * into t;
  return t;
end $$;
revoke execute on function public.repeat_skip(uuid, uuid) from public, anon;
grant execute on function public.repeat_skip(uuid, uuid) to authenticated, service_role;
