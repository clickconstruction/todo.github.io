-- Steps tree (migration 20260927000001). One rolled-back transaction; every row should be ok = true.
-- Inbox steps, project follow, depth 4, loops, cascade completion up and down, convert_to_project,
-- repeat copies the whole tree.
begin;
insert into auth.users (id, instance_id, aud, role, email) values ('00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-000000000000','authenticated','authenticated','steps@test.invalid');
create temp table r (n int generated always as identity, test text, ok boolean, detail text); grant all on r to authenticated;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000d1","role":"authenticated"}', true);

insert into public.projects (id, name) values ('00000000-0000-0000-0000-0000000d0f01', 'Shop'), ('00000000-0000-0000-0000-0000000d0f02', 'Garage');
-- An Inbox elephant with steps.
insert into public.tasks (id, title, in_inbox) values ('00000000-0000-0000-0000-0000000d0001', 'Build a telescope', true);
insert into public.tasks (id, title, parent_id, project_id, in_inbox, sort) values
  ('00000000-0000-0000-0000-0000000d0002', 'Research', '00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-0000000d0f02', true, 0),
  ('00000000-0000-0000-0000-0000000d0003', 'Grind', '00000000-0000-0000-0000-0000000d0001', null, false, 1);
insert into r (test, ok, detail) select 'steps live where the parent lives, not in the Inbox', bool_and(project_id is null and not in_inbox), '' from public.tasks where parent_id = '00000000-0000-0000-0000-0000000d0001';

-- Four levels deep is fine; a fifth is refused.
insert into public.tasks (id, title, parent_id) values ('00000000-0000-0000-0000-0000000d0004', 'Rough grind', '00000000-0000-0000-0000-0000000d0003');
insert into public.tasks (id, title, parent_id) values ('00000000-0000-0000-0000-0000000d0005', 'Buy grit', '00000000-0000-0000-0000-0000000d0004');
insert into r (test, ok, detail) values ('four levels allowed', true, '');
do $$ begin
  insert into public.tasks (title, parent_id) values ('Too deep', '00000000-0000-0000-0000-0000000d0005');
  insert into r (test, ok, detail) values ('fifth level refused', false, '');
exception when check_violation then insert into r (test, ok, detail) values ('fifth level refused', true, sqlerrm); end $$;
-- Moving a 2-level subtree under a level-3 task would make 5 levels.
insert into public.tasks (id, title) values ('00000000-0000-0000-0000-0000000d0006', 'Loose'), ('00000000-0000-0000-0000-0000000d0007', 'Loose child');
update public.tasks set parent_id = '00000000-0000-0000-0000-0000000d0006' where id = '00000000-0000-0000-0000-0000000d0007';
do $$ begin
  update public.tasks set parent_id = '00000000-0000-0000-0000-0000000d0004' where id = '00000000-0000-0000-0000-0000000d0006';
  insert into r (test, ok, detail) values ('moving a subtree counts its own depth', false, '');
exception when check_violation then insert into r (test, ok, detail) values ('moving a subtree counts its own depth', true, sqlerrm); end $$;

-- No loops.
do $$ begin
  update public.tasks set parent_id = '00000000-0000-0000-0000-0000000d0004' where id = '00000000-0000-0000-0000-0000000d0003';
  insert into r (test, ok, detail) values ('no loops', false, '');
exception when check_violation then insert into r (test, ok, detail) values ('no loops', true, sqlerrm); end $$;
do $$ begin
  update public.tasks set parent_id = id where id = '00000000-0000-0000-0000-0000000d0003';
  insert into r (test, ok, detail) values ('not its own step', false, '');
exception when check_violation then insert into r (test, ok, detail) values ('not its own step', true, sqlerrm); end $$;

-- Moving the elephant into a project takes every step along.
update public.tasks set project_id = '00000000-0000-0000-0000-0000000d0f01', in_inbox = false where id = '00000000-0000-0000-0000-0000000d0001';
insert into r (test, ok, detail) select 'whole tree follows its project', count(*) = 4, count(*)::text from public.tasks
  where id in ('00000000-0000-0000-0000-0000000d0002','00000000-0000-0000-0000-0000000d0003','00000000-0000-0000-0000-0000000d0004','00000000-0000-0000-0000-0000000d0005')
    and project_id = '00000000-0000-0000-0000-0000000d0f01';
-- A step can't be filed into another project on its own.
update public.tasks set project_id = '00000000-0000-0000-0000-0000000d0f02' where id = '00000000-0000-0000-0000-0000000d0002';
insert into r (test, ok, detail) select 'a step stays in its parent''s project', project_id = '00000000-0000-0000-0000-0000000d0f01', '' from public.tasks where id = '00000000-0000-0000-0000-0000000d0002';

-- Completing the deepest last step completes every level above it.
update public.tasks set completed_at = now() where id = '00000000-0000-0000-0000-0000000d0002';
update public.tasks set completed_at = now() where id = '00000000-0000-0000-0000-0000000d0005';
insert into r (test, ok, detail) select 'last step completes all levels above', count(*) = 3, count(*)::text from public.tasks
  where id in ('00000000-0000-0000-0000-0000000d0001','00000000-0000-0000-0000-0000000d0003','00000000-0000-0000-0000-0000000d0004') and completed_at is not null;
-- Reopening it reopens them.
update public.tasks set completed_at = null where id = '00000000-0000-0000-0000-0000000d0005';
insert into r (test, ok, detail) select 'reopening a step reopens all levels above', count(*) = 3, count(*)::text from public.tasks
  where id in ('00000000-0000-0000-0000-0000000d0001','00000000-0000-0000-0000-0000000d0003','00000000-0000-0000-0000-0000000d0004') and completed_at is null;
-- Dropping a task drops its open steps, all levels down.
update public.tasks set dropped_at = now() where id = '00000000-0000-0000-0000-0000000d0003';
insert into r (test, ok, detail) select 'closing a task closes its steps all the way down', count(*) = 2, count(*)::text from public.tasks
  where id in ('00000000-0000-0000-0000-0000000d0004','00000000-0000-0000-0000-0000000d0005') and dropped_at is not null;
update public.tasks set dropped_at = null where id in ('00000000-0000-0000-0000-0000000d0003','00000000-0000-0000-0000-0000000d0004','00000000-0000-0000-0000-0000000d0005');

-- Turn it into a project.
update public.tasks set steps_in_order = true where id = '00000000-0000-0000-0000-0000000d0001';
insert into r (test, ok, detail) select 'convert_to_project', true, public.convert_to_project('00000000-0000-0000-0000-0000000d0001')::text;
insert into r (test, ok, detail) select 'new project is sequential (steps were in order)', kind = 'sequential', kind from public.projects where name = 'Build a telescope';
insert into r (test, ok, detail) select 'steps are now its top-level actions', count(*) = 2, count(*)::text from public.tasks t join public.projects p on p.id = t.project_id
  where p.name = 'Build a telescope' and t.parent_id is null;
insert into r (test, ok, detail) select 'deeper steps came along', project_id = (select id from public.projects where name = 'Build a telescope'), '' from public.tasks where id = '00000000-0000-0000-0000-0000000d0005';
insert into r (test, ok, detail) select 'the task is dropped with a note, not deleted', dropped_at is not null and completion_note like 'Became the project%', completion_note from public.tasks where id = '00000000-0000-0000-0000-0000000d0001';

-- A repeating task brings its whole tree back.
insert into public.tasks (id, title, project_id, due_at, repeat_rule, steps_in_order) values ('00000000-0000-0000-0000-0000000d0010', 'Monthly close', '00000000-0000-0000-0000-0000000d0f02', now(), '{"every":1,"unit":"month"}', true);
insert into public.tasks (id, title, parent_id, sort) values ('00000000-0000-0000-0000-0000000d0011', 'Reconcile', '00000000-0000-0000-0000-0000000d0010', 0), ('00000000-0000-0000-0000-0000000d0012', 'Report', '00000000-0000-0000-0000-0000000d0010', 1);
insert into public.tasks (id, title, parent_id) values ('00000000-0000-0000-0000-0000000d0013', 'Bank A', '00000000-0000-0000-0000-0000000d0011');
update public.tasks set completed_at = now() where id = '00000000-0000-0000-0000-0000000d0010';
insert into r (test, ok, detail) select 'repeat: next occurrence with steps in order', count(*) = 1 and bool_and(steps_in_order), count(*)::text from public.tasks
  where title = 'Monthly close' and completed_at is null;
insert into r (test, ok, detail) select 'repeat: all levels of steps copied, open', count(*) = 3, count(*)::text from public.tasks s
  where s.completed_at is null and s.title in ('Reconcile','Report','Bank A') and s.id not in ('00000000-0000-0000-0000-0000000d0011','00000000-0000-0000-0000-0000000d0012','00000000-0000-0000-0000-0000000d0013');

select test, ok, detail from r order by n;
rollback;
