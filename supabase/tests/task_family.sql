-- task_family (migration 20261022000001). One rolled-back transaction; every row should be ok = true.
-- The task, every step below it (all levels, closed too), every task above it; nobody else's rows.
begin;
insert into auth.users (id, instance_id, aud, role, email) values
  ('00000000-0000-0000-0000-0000000000f1','00000000-0000-0000-0000-000000000000','authenticated','authenticated','family@test.invalid'),
  ('00000000-0000-0000-0000-0000000000f2','00000000-0000-0000-0000-000000000000','authenticated','authenticated','other@test.invalid');
create temp table r (n int generated always as identity, test text, ok boolean, detail text); grant all on r to authenticated;

-- Root > A > A1 > A1a (closed), Root > B; a sibling tree that is not family.
insert into public.tasks (id, user_id, title) values
  ('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-0000000000f1', 'Root'),
  ('00000000-0000-0000-0000-00000000f009', '00000000-0000-0000-0000-0000000000f1', 'Stranger');
insert into public.tasks (id, user_id, title, parent_id) values
  ('00000000-0000-0000-0000-00000000f002', '00000000-0000-0000-0000-0000000000f1', 'A', '00000000-0000-0000-0000-00000000f001'),
  ('00000000-0000-0000-0000-00000000f003', '00000000-0000-0000-0000-0000000000f1', 'B', '00000000-0000-0000-0000-00000000f001');
insert into public.tasks (id, user_id, title, parent_id) values
  ('00000000-0000-0000-0000-00000000f004', '00000000-0000-0000-0000-0000000000f1', 'A1', '00000000-0000-0000-0000-00000000f002');
insert into public.tasks (id, user_id, title, parent_id, completed_at) values
  ('00000000-0000-0000-0000-00000000f005', '00000000-0000-0000-0000-0000000000f1', 'A1a', '00000000-0000-0000-0000-00000000f004', now());

-- As the service role, with owner.
insert into r (test, ok, detail) select 'root: itself and all its steps', string_agg(title, ',' order by title) = 'A,A1,A1a,B,Root', string_agg(title, ',' order by title)
  from public.task_family('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-0000000000f1');
insert into r (test, ok, detail) select 'middle: its steps and what it is part of', string_agg(title, ',' order by title) = 'A,A1,A1a,Root', string_agg(title, ',' order by title)
  from public.task_family('00000000-0000-0000-0000-00000000f004', '00000000-0000-0000-0000-0000000000f1');
insert into r (test, ok, detail) select 'wrong owner sees nothing', count(*) = 0, count(*)::text
  from public.task_family('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-0000000000f2');

-- As a signed-in user: their own id wins over owner.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000f2","role":"authenticated"}', true);
insert into r (test, ok, detail) select 'another user cannot read the tree', count(*) = 0, count(*)::text
  from public.task_family('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-0000000000f1');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000f1","role":"authenticated"}', true);
insert into r (test, ok, detail) select 'the owner signed in reads it', count(*) = 5, count(*)::text
  from public.task_family('00000000-0000-0000-0000-00000000f001');

select test, ok, detail from r order by n;
rollback;
