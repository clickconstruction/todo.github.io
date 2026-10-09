-- Dailies (migration 20261101000001), weekly checks (20261107000001) and quarterly checks (20261108000001). One rolled-back transaction; every row ok = true.
begin;
insert into auth.users (id, instance_id, aud, role, email) values ('00000000-0000-0000-0000-0000000d0001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','dy1@test.invalid'),('00000000-0000-0000-0000-0000000d0002','00000000-0000-0000-0000-000000000000','authenticated','authenticated','dy2@test.invalid');
create temp table r (n int generated always as identity, test text, ok boolean, detail text); grant all on r to authenticated;
insert into public.tasks (id, user_id, title, in_inbox, daily) values ('00000000-0000-0000-0000-0000000d00f1', '00000000-0000-0000-0000-0000000d0002', 'Theirs', false, '{"tier":"must"}');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000d0001","role":"authenticated"}', true);
insert into public.projects (id, name, kind) values ('00000000-0000-0000-0000-0000000d00a1', 'In order', 'sequential');
insert into public.tasks (id, title, in_inbox, repeat_rule, due_at, planned_at, defer_at) values
  ('00000000-0000-0000-0000-0000000d0011', 'Walk for 30 min', false, '{"every":1,"unit":"day","from":"assigned"}', now() - interval '3 days', now(), now() - interval '5 days');
insert into public.tasks (id, title, in_inbox) values ('00000000-0000-0000-0000-0000000d0012', 'An ordinary action', false);
insert into public.tasks (id, title, in_inbox, project_id, sort, daily) values ('00000000-0000-0000-0000-0000000d0013', 'Daily, first in an ordered project', false, '00000000-0000-0000-0000-0000000d00a1', 0, '{"tier":"must"}');
insert into public.tasks (id, title, in_inbox, project_id, sort) values ('00000000-0000-0000-0000-0000000d0014', 'Second in the ordered project', false, '00000000-0000-0000-0000-0000000d00a1', 1);

update public.tasks set daily = '{"tier":"should","weekdays":[1,3,5]}' where id = '00000000-0000-0000-0000-0000000d0011';
insert into r (test, ok, detail) select 'making it daily clears its repeat and dates', daily->>'tier' = 'should' and repeat_rule is null and due_at is null and planned_at is null and defer_at is null, coalesce(due_at::text, 'no due') from public.tasks where id = '00000000-0000-0000-0000-0000000d0011';
update public.tasks set due_at = now() where id = '00000000-0000-0000-0000-0000000d0011';
update public.tasks set daily = '{"tier":"must"}' where id = '00000000-0000-0000-0000-0000000d0011';
insert into r (test, ok, detail) select 'since is set once and kept when the tier changes', daily->>'tier' = 'must' and daily->>'since' = to_char(now(), 'YYYY-MM-DD'), daily::text from public.tasks where id = '00000000-0000-0000-0000-0000000d0011';
insert into r (test, ok, detail) select 'a daily action takes no due date', due_at is null, '' from public.tasks where id = '00000000-0000-0000-0000-0000000d0011';
do $$ begin update public.tasks set daily = '{"tier":"sometimes"}' where id = '00000000-0000-0000-0000-0000000d0012'; insert into r (test, ok, detail) values ('the tier is must or should', false, '');
exception when check_violation then insert into r (test, ok, detail) values ('the tier is must or should', true, sqlerrm); end $$;

insert into public.daily_ticks (task_id, day) values ('00000000-0000-0000-0000-0000000d0011', current_date);
insert into public.daily_ticks (task_id, day) values ('00000000-0000-0000-0000-0000000d0011', current_date - 1);
insert into r (test, ok, detail) select 'ticks: one a day, the action stays open', count(*) = 2 and (select completed_at is null from public.tasks where id = '00000000-0000-0000-0000-0000000d0011'), count(*)::text from public.daily_ticks;
do $$ begin insert into public.daily_ticks (task_id, day) values ('00000000-0000-0000-0000-0000000d0011', current_date); insert into r (test, ok, detail) values ('one tick per action per day', false, '');
exception when unique_violation then insert into r (test, ok, detail) values ('one tick per action per day', true, sqlerrm); end $$;
do $$ begin insert into public.daily_ticks (task_id, day) values ('00000000-0000-0000-0000-0000000d0012', current_date); insert into r (test, ok, detail) values ('only a daily action can be ticked', false, '');
exception when check_violation then insert into r (test, ok, detail) values ('only a daily action can be ticked', true, sqlerrm); end $$;
do $$ begin insert into public.daily_ticks (task_id, day) values ('00000000-0000-0000-0000-0000000d0011', current_date + 3); insert into r (test, ok, detail) values ('a day that hasn''t come can''t be ticked', false, '');
exception when check_violation then insert into r (test, ok, detail) values ('a day that hasn''t come can''t be ticked', true, sqlerrm); end $$;
do $$ begin insert into public.daily_ticks (task_id, day) values ('00000000-0000-0000-0000-0000000d00f1', current_date); insert into r (test, ok, detail) values ('can''t tick another user''s action', false, '');
exception when foreign_key_violation then insert into r (test, ok, detail) values ('can''t tick another user''s action', true, sqlerrm); end $$;
update public.daily_ticks set state = 'cleared' where task_id = '00000000-0000-0000-0000-0000000d0011' and day = current_date;
delete from public.daily_ticks;
insert into r (test, ok, detail) select 'un-ticking keeps the row; ticks can''t be deleted', count(*) = 2 and count(*) filter (where state = 'cleared') = 1, count(*)::text from public.daily_ticks;
insert into r (test, ok, detail) select 'owner only: no ticks of other users', not exists (select 1 from public.daily_ticks where user_id <> '00000000-0000-0000-0000-0000000d0001'), '';
reset role;
insert into r (test, ok, detail) select 'available: not the daily ones; a daily action doesn''t hold the turn in an ordered project',
  ids @> array['00000000-0000-0000-0000-0000000d0012', '00000000-0000-0000-0000-0000000d0014']::uuid[] and not ids && array['00000000-0000-0000-0000-0000000d0011', '00000000-0000-0000-0000-0000000d0013']::uuid[], array_length(ids, 1)::text
  from (select public.available_task_ids('00000000-0000-0000-0000-0000000d0001') as ids) x;
insert into r (test, ok, detail) select 'the MCP snapshot carries daily', s->'tasks'->'cols' ? 'daily' and jsonb_array_length(s->'tasks'->'cols') = jsonb_array_length(s->'tasks'->'rows'->0), ''
  from (select public.mcp_snapshot('00000000-0000-0000-0000-0000000d0001') as s) x;

-- Full Review: a suggestion makes it daily on Submit; Undo puts the repeat and dates back.
insert into public.tasks (id, user_id, title, in_inbox, repeat_rule, due_at) values ('00000000-0000-0000-0000-0000000d0015', '00000000-0000-0000-0000-0000000d0001', 'Stretch', false, '{"every":1,"unit":"day","from":"assigned"}', '2026-10-07 22:00+00');
insert into public.review_sessions (id, user_id, title) values ('00000000-0000-0000-0000-0000000d00b1', '00000000-0000-0000-0000-0000000d0001', 'Dailies test');
insert into public.review_items (id, user_id, session_id, kind, task_id, sort, suggestion) values ('00000000-0000-0000-0000-0000000d00c1', '00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-0000000d00b1', 'task', '00000000-0000-0000-0000-0000000d0015', 1, '{"decision":"keep","daily":{"tier":"should"}}');
select public.review_apply('00000000-0000-0000-0000-0000000d00c1', '00000000-0000-0000-0000-0000000d0001');
insert into r (test, ok, detail) select 'Full Review submit: the action is daily (since today), its repeat and due date gone', daily->>'tier' = 'should' and daily ? 'since' and repeat_rule is null and due_at is null, coalesce(daily::text, 'null') from public.tasks where id = '00000000-0000-0000-0000-0000000d0015';
select public.review_undo('00000000-0000-0000-0000-0000000d00c1', '00000000-0000-0000-0000-0000000d0001');
insert into r (test, ok, detail) select 'Full Review undo: not daily, its repeat and due date back', daily is null and repeat_rule->>'unit' = 'day' and due_at = '2026-10-07 22:00+00', coalesce(due_at::text, 'no due') from public.tasks where id = '00000000-0000-0000-0000-0000000d0015';

-- Weekly checks: daily with every = 'week'. Same guard (no dates or repeat), ticks in the same table, never available.
insert into public.tasks (id, user_id, title, in_inbox, repeat_rule, due_at) values ('00000000-0000-0000-0000-0000000d0016', '00000000-0000-0000-0000-0000000d0001', 'Am I reviewing?', false, '{"every":1,"unit":"week","from":"completion"}', '2026-10-04 22:00+00');
update public.tasks set daily = '{"tier":"should","every":"week"}' where id = '00000000-0000-0000-0000-0000000d0016';
insert into r (test, ok, detail) select 'a weekly check: every = week is kept, its repeat and due date are cleared, since is set', daily->>'every' = 'week' and daily ? 'since' and repeat_rule is null and due_at is null, coalesce(daily::text, 'null') from public.tasks where id = '00000000-0000-0000-0000-0000000d0016';
do $$ begin update public.tasks set daily = '{"tier":"should","every":"month"}' where id = '00000000-0000-0000-0000-0000000d0016'; insert into r (test, ok, detail) values ('every is week, quarter or nothing', false, '');
exception when check_violation then insert into r (test, ok, detail) values ('every is week, quarter or nothing', true, sqlerrm); end $$;
insert into public.daily_ticks (user_id, task_id, day) values ('00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-0000000d0016', current_date);
insert into r (test, ok, detail) select 'a weekly check is ticked like a daily one, and is never available', count(*) = 1 and not (public.available_task_ids('00000000-0000-0000-0000-0000000d0001') && array['00000000-0000-0000-0000-0000000d0016']::uuid[]), count(*)::text from public.daily_ticks where task_id = '00000000-0000-0000-0000-0000000d0016';
insert into public.tasks (id, user_id, title, in_inbox, repeat_rule, due_at) values ('00000000-0000-0000-0000-0000000d0017', '00000000-0000-0000-0000-0000000d0001', 'Does my routine support good work?', false, '{"every":1,"unit":"week","from":"completion"}', '2026-10-07 22:00+00');
insert into public.review_items (id, user_id, session_id, kind, task_id, sort, suggestion) values ('00000000-0000-0000-0000-0000000d00c2', '00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-0000000d00b1', 'task', '00000000-0000-0000-0000-0000000d0017', 2, '{"decision":"keep","daily":{"tier":"should","every":"week"}}');
select public.review_apply('00000000-0000-0000-0000-0000000d00c2', '00000000-0000-0000-0000-0000000d0001');
insert into r (test, ok, detail) select 'Full Review submit: the action is a weekly check, its repeat and due date gone', daily->>'every' = 'week' and daily->>'tier' = 'should' and not daily ? 'weekdays' and repeat_rule is null and due_at is null, coalesce(daily::text, 'null') from public.tasks where id = '00000000-0000-0000-0000-0000000d0017';
select public.review_undo('00000000-0000-0000-0000-0000000d00c2', '00000000-0000-0000-0000-0000000d0001');
insert into r (test, ok, detail) select 'Full Review undo: not a weekly check, its repeat and due date back', daily is null and repeat_rule->>'unit' = 'week' and due_at = '2026-10-07 22:00+00', coalesce(due_at::text, 'no due') from public.tasks where id = '00000000-0000-0000-0000-0000000d0017';

-- Quarterly checks (20261108000001): daily with every = 'quarter'. The same guard, the same ticks, never available.
insert into public.tasks (id, user_id, title, in_inbox, repeat_rule, due_at) values ('00000000-0000-0000-0000-0000000d0018', '00000000-0000-0000-0000-0000000d0001', 'Am I making businesses?', false, '{"every":3,"unit":"month","from":"completion"}', '2026-11-01 21:00+00');
update public.tasks set daily = '{"tier":"should","every":"quarter"}' where id = '00000000-0000-0000-0000-0000000d0018';
insert into r (test, ok, detail) select 'a quarterly check: every = quarter is kept, its repeat and due date are cleared, since is set', daily->>'every' = 'quarter' and daily ? 'since' and repeat_rule is null and due_at is null, coalesce(daily::text, 'null') from public.tasks where id = '00000000-0000-0000-0000-0000000d0018';
insert into public.daily_ticks (user_id, task_id, day) values ('00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-0000000d0018', current_date);
insert into r (test, ok, detail) select 'a quarterly check is ticked like a daily one, and is never available', count(*) = 1 and not (public.available_task_ids('00000000-0000-0000-0000-0000000d0001') && array['00000000-0000-0000-0000-0000000d0018']::uuid[]), count(*)::text from public.daily_ticks where task_id = '00000000-0000-0000-0000-0000000d0018';
insert into public.tasks (id, user_id, title, in_inbox, repeat_rule, due_at) values ('00000000-0000-0000-0000-0000000d0019', '00000000-0000-0000-0000-0000000d0001', 'Am I prioritizing and executing?', false, '{"every":3,"unit":"month","from":"completion"}', '2026-11-01 21:00+00');
insert into public.review_items (id, user_id, session_id, kind, task_id, sort, suggestion) values ('00000000-0000-0000-0000-0000000d00c3', '00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-0000000d00b1', 'task', '00000000-0000-0000-0000-0000000d0019', 3, '{"decision":"keep","daily":{"tier":"should","every":"quarter"}}');
select public.review_apply('00000000-0000-0000-0000-0000000d00c3', '00000000-0000-0000-0000-0000000d0001');
insert into r (test, ok, detail) select 'Full Review submit: the action is a quarterly check, its repeat and due date gone', daily->>'every' = 'quarter' and daily->>'tier' = 'should' and repeat_rule is null and due_at is null, coalesce(daily::text, 'null') from public.tasks where id = '00000000-0000-0000-0000-0000000d0019';
select public.review_undo('00000000-0000-0000-0000-0000000d00c3', '00000000-0000-0000-0000-0000000d0001');
insert into r (test, ok, detail) select 'Full Review undo: not a quarterly check, its repeat and due date back', daily is null and repeat_rule->>'unit' = 'month' and due_at = '2026-11-01 21:00+00', coalesce(due_at::text, 'no due') from public.tasks where id = '00000000-0000-0000-0000-0000000d0019';
select test, ok, detail from r order by n;
rollback;
