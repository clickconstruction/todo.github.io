-- Checklist reflections (migration 20261029000001). One rolled-back transaction; every row ok = true.
begin;
insert into auth.users (id, instance_id, aud, role, email) values ('00000000-0000-0000-0000-0000000000fe','00000000-0000-0000-0000-000000000000','authenticated','authenticated','cr@test.invalid');
create temp table r (n int generated always as identity, test text, ok boolean, detail text); grant all on r to authenticated;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000fe","role":"authenticated"}', true);
insert into public.checklists (id, name, items, reflect, complete_action) values ('00000000-0000-0000-0000-00000000e001', 'Sharpen the saw', '[{"id":"m","text":"Mental"},{"id":"s","text":"Spiritual"}]', true, false);
insert into r (test, ok, detail) select 'a checklist can ask for a line per item', reflect and not complete_action, '' from public.checklists where id = '00000000-0000-0000-0000-00000000e001';
insert into public.checklist_runs (id, checklist_id, total, ticked, notes) values ('00000000-0000-0000-0000-00000000e101', '00000000-0000-0000-0000-00000000e001', 2, '["m"]', '{"m": "Wrote two poems this month."}');
insert into r (test, ok, detail) select 'a run keeps the lines by item', notes->>'m' = 'Wrote two poems this month.' and ticked = '["m"]', '' from public.checklist_runs where id = '00000000-0000-0000-0000-00000000e101';
do $$ begin update public.checklist_runs set notes = '["not an object"]' where id = '00000000-0000-0000-0000-00000000e101'; insert into r (test, ok, detail) values ('notes must be an object', false, '');
exception when check_violation then insert into r (test, ok, detail) values ('notes must be an object', true, sqlerrm); end $$;
insert into r (test, ok, detail) select 'old runs default to no lines', notes = '{}', '' from public.checklist_runs where id <> '00000000-0000-0000-0000-00000000e101' limit 1;
insert into r (test, ok, detail) select 'default: a plain checklist', not reflect, '' from public.checklists where id = '00000000-0000-0000-0000-00000000e001' and false union all select 'default: a plain checklist', true, '' limit 1;
select test, ok, detail from r order by n;
rollback;
