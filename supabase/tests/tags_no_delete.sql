-- Tags are never deleted (migration 20261114000001). One rolled-back transaction; every row should be ok = true.
begin;
insert into auth.users (id, instance_id, aud, role, email) values ('00000000-0000-0000-0000-0000000000da','00000000-0000-0000-0000-000000000000','authenticated','authenticated','tagkeep@test.invalid');
create temp table r (n int generated always as identity, test text, ok boolean, detail text); grant all on r to authenticated, service_role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000da","role":"authenticated"}', true);
insert into public.tags (id, name) values ('00000000-0000-0000-0000-0000000da001', 'Errands');
insert into public.tags (id, name, parent_id) values ('00000000-0000-0000-0000-0000000da002', 'Shops', '00000000-0000-0000-0000-0000000da001');
insert into public.tasks (id, title) values ('00000000-0000-0000-0000-0000000da011', 'Buy stamps');
insert into public.task_tags (task_id, tag_id) values ('00000000-0000-0000-0000-0000000da011', '00000000-0000-0000-0000-0000000da002');
-- The app's key: no delete policy, so the owner's delete removes nothing.
delete from public.tags where id in ('00000000-0000-0000-0000-0000000da001', '00000000-0000-0000-0000-0000000da002');
insert into r (test, ok, detail) select 'the owner cannot delete a tag', count(*) = 2, count(*)::text || ' left' from public.tags where user_id = '00000000-0000-0000-0000-0000000000da';
update public.tags set status = 'dropped' where id = '00000000-0000-0000-0000-0000000da002';
insert into r (test, ok, detail) select 'a tag is dropped instead', status = 'dropped', status from public.tags where id = '00000000-0000-0000-0000-0000000da002';
delete from public.task_tags where task_id = '00000000-0000-0000-0000-0000000da011';
insert into r (test, ok, detail) select 'a tag link can still be removed', count(*) = 0, '' from public.task_tags where task_id = '00000000-0000-0000-0000-0000000da011';
-- The MCP's key bypasses RLS; the trigger refuses it.
reset role;
set local role service_role;
do $$ begin delete from public.tags where id = '00000000-0000-0000-0000-0000000da002'; insert into r (test, ok, detail) values ('the server key cannot delete a tag', false, '');
exception when insufficient_privilege then insert into r (test, ok, detail) values ('the server key cannot delete a tag', true, sqlerrm); end $$;
reset role;
do $$ begin delete from public.tags where id = '00000000-0000-0000-0000-0000000da001'; insert into r (test, ok, detail) values ('SQL cannot delete a tag (nor its sub-tag by cascade)', false, '');
exception when insufficient_privilege then insert into r (test, ok, detail) values ('SQL cannot delete a tag (nor its sub-tag by cascade)', true, sqlerrm); end $$;
-- Closing the account still takes its tags with it.
delete from auth.users where id = '00000000-0000-0000-0000-0000000000da';
insert into r (test, ok, detail) select 'deleting the account removes its tags', count(*) = 0, count(*)::text || ' left' from public.tags where user_id = '00000000-0000-0000-0000-0000000000da';
select n, test, ok, detail from r order by n;
rollback;
