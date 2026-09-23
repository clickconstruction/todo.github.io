-- Attachments (migration 20260925000004). One rolled-back transaction; every row should be ok = true.
begin;
insert into auth.users (id, instance_id, aud, role, email) values ('00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-000000000000','authenticated','authenticated','t9@test.invalid');
insert into auth.users (id, instance_id, aud, role, email) values ('00000000-0000-0000-0000-0000000000c2','00000000-0000-0000-0000-000000000000','authenticated','authenticated','t10@test.invalid');
create temp table r (n int generated always as identity, test text, ok boolean, detail text); grant all on r to authenticated;
insert into public.tasks (id, user_id, title) values ('00000000-0000-0000-0000-0000000c0009', '00000000-0000-0000-0000-0000000000c2', 'theirs');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}', true);
insert into public.tasks (id, title) values ('00000000-0000-0000-0000-0000000c0001', 'Mine');
insert into public.attachments (id, task_id, path, name, size, mime) values ('00000000-0000-0000-0000-0000000ca001', '00000000-0000-0000-0000-0000000c0001', '00000000-0000-0000-0000-0000000000c1/x/plans.pdf', 'plans.pdf', 1234, 'application/pdf');
insert into r (test, ok, detail) select 'attach to my own task', count(*) = 1, '' from public.attachments;
do $$ begin
  insert into public.attachments (task_id, path, name) values ('00000000-0000-0000-0000-0000000c0001', '00000000-0000-0000-0000-0000000000c2/x/a.pdf', 'a.pdf');
  insert into r (test, ok, detail) values ('path must be in my folder', false, '');
exception when others then insert into r (test, ok, detail) values ('path must be in my folder', true, sqlerrm); end $$;
do $$ begin
  insert into public.attachments (task_id, path, name) values ('00000000-0000-0000-0000-0000000c0009', '00000000-0000-0000-0000-0000000000c1/y/a.pdf', 'a.pdf');
  insert into r (test, ok, detail) values ('cannot attach to someone else''s task', false, '');
exception when others then insert into r (test, ok, detail) values ('cannot attach to someone else''s task', true, sqlerrm); end $$;
update public.attachments set archived_at = now() where id = '00000000-0000-0000-0000-0000000ca001';
insert into r (test, ok, detail) select 'archive instead of delete', archived_at is not null, '' from public.attachments where id = '00000000-0000-0000-0000-0000000ca001';
delete from public.attachments where id = '00000000-0000-0000-0000-0000000ca001';
insert into r (test, ok, detail) select 'delete is a no-op (no delete policy)', count(*) = 1, '' from public.attachments where id = '00000000-0000-0000-0000-0000000ca001';
select test, ok, detail from r order by n;
rollback;
