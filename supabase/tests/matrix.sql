-- Matrix (migration 20261018000001). One rolled-back transaction; every row should be ok = true.
begin;
insert into auth.users (id, instance_id, aud, role, email) values
 ('00000000-0000-0000-0000-0000000000f9','00000000-0000-0000-0000-000000000000','authenticated','authenticated','mx@test.invalid'),
 ('00000000-0000-0000-0000-0000000000fa','00000000-0000-0000-0000-000000000000','authenticated','authenticated','mx2@test.invalid');
create temp table r (n int generated always as identity, test text, ok boolean, detail text); grant all on r to authenticated;
create temp table res (k text, v jsonb); grant all on res to authenticated;
-- someone else's action: must be untouchable
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000fa","role":"authenticated"}', true);
insert into public.tasks (id, title) values ('00000000-0000-0000-0000-00000000e109', 'Not yours');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000f9","role":"authenticated"}', true);
insert into public.tasks (id, title, in_inbox, created_at, updated_at) values
 ('00000000-0000-0000-0000-00000000e101', 'Frog pond', false, '2022-01-01', '2022-01-01'),
 ('00000000-0000-0000-0000-00000000e102', 'Build a 2m telescope', false, '2021-01-01', '2021-01-01'),
 ('00000000-0000-0000-0000-00000000e103', 'Sort the garage shelves', true, '2023-01-01', '2023-01-01');
insert into public.tasks (id, title, completed_at) values ('00000000-0000-0000-0000-00000000e104', 'Already done', now());
update public.tasks set important = true where id = '00000000-0000-0000-0000-00000000e101';
insert into r (test, ok, detail) select 'important: null by default, settable', (select important from public.tasks where id = '00000000-0000-0000-0000-00000000e101') and (select important is null from public.tasks where id = '00000000-0000-0000-0000-00000000e102'), '';
insert into public.user_settings (matrix_urgent_days) values (7);
insert into r (test, ok, detail) select 'urgent window: default 7', (select matrix_urgent_days = 7 from public.user_settings), '';
do $$ begin update public.user_settings set matrix_urgent_days = 0; insert into r (test, ok) values ('urgent window: at least 1 day', false);
exception when others then insert into r (test, ok, detail) values ('urgent window: at least 1 day', true, sqlerrm); end $$;
insert into res select 'p', public.matrix_park(array['00000000-0000-0000-0000-00000000e101','00000000-0000-0000-0000-00000000e102','00000000-0000-0000-0000-00000000e103','00000000-0000-0000-0000-00000000e104','00000000-0000-0000-0000-00000000e109']::uuid[]);
insert into r (test, ok, detail) select 'park: only your open actions get the Someday tag', jsonb_array_length((select v->'parked' from res where k = 'p')) = 3
  and (select count(*) from public.task_tags tt join public.tags g on g.id = tt.tag_id where g.name = 'Someday') = 3, (select v::text from res where k = 'p');
insert into r (test, ok, detail) select 'park: Someday tag is on hold, inbox item leaves the Inbox', (select status = 'on_hold' from public.tags where name = 'Someday') and (select not in_inbox from public.tasks where id = '00000000-0000-0000-0000-00000000e103'), '';
insert into res select 'p2', public.matrix_park(array['00000000-0000-0000-0000-00000000e101']::uuid[]);
insert into r (test, ok, detail) select 'park again: already parked is left alone', jsonb_array_length((select v->'parked' from res where k = 'p2')) = 0, '';
select public.matrix_unpark(array['00000000-0000-0000-0000-00000000e101','00000000-0000-0000-0000-00000000e102']::uuid[]);
insert into r (test, ok, detail) select 'undo: tags off again, tasks untouched', (select count(*) from public.task_tags) = 1 and (select count(*) from public.tasks where dropped_at is null) = 4, '';
reset role;
insert into r (test, ok, detail) select 'someone else''s action untouched', not exists (select 1 from public.task_tags where task_id = '00000000-0000-0000-0000-00000000e109'), '';
select count(*) filter (where ok) as passed, count(*) as total, string_agg(case when not ok then test || ': ' || coalesce(detail, '') end, '; ') as failed from r;
rollback;
