-- Tag status (migration 20260930000001). One rolled-back transaction; every row should be ok = true.
begin;
insert into auth.users (id, instance_id, aud, role, email) values ('00000000-0000-0000-0000-0000000000f3','00000000-0000-0000-0000-000000000000','authenticated','authenticated','hold@test.invalid');
create temp table r (n int generated always as identity, test text, ok boolean, detail text); grant all on r to authenticated;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000f3","role":"authenticated"}', true);
insert into public.tags (name) values ('Plain');
insert into r (test, ok, detail) select 'new tags are active', status = 'active', status from public.tags where name = 'Plain';
update public.tags set status = 'on_hold' where name = 'Plain';
insert into r (test, ok, detail) select 'owner can put a tag on hold', status = 'on_hold', status from public.tags where name = 'Plain';
do $$ begin update public.tags set status = 'paused' where name = 'Plain'; insert into r (test, ok, detail) values ('unknown status refused', false, '');
exception when check_violation then insert into r (test, ok, detail) values ('unknown status refused', true, sqlerrm); end $$;
select public.import_omnifocus('{"source":"omnifocus","folders":[],"tags":[{"ref":"of:S","name":"Someday","depth":1,"status":"on_hold"},{"ref":"of:O","name":"Old","depth":1,"status":"dropped"},{"ref":"of:X","name":"Weird","depth":1,"status":"sleepy"}],"projects":[],"tasks":[]}'::jsonb);
insert into r (test, ok, detail) select 'import keeps tag status', (select status from public.tags where name = 'Someday') = 'on_hold' and (select status from public.tags where name = 'Old') = 'dropped' and (select status from public.tags where name = 'Weird') = 'active', '';
select test, ok, detail from r order by n;
rollback;
