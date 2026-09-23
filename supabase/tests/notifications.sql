-- Custom notifications (migration 20260925000003). One rolled-back transaction; every row should be ok = true.
begin;
insert into auth.users (id, instance_id, aud, role, email) values ('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-000000000000','authenticated','authenticated','t7@test.invalid');
insert into auth.users (id, instance_id, aud, role, email) values ('00000000-0000-0000-0000-0000000000b2','00000000-0000-0000-0000-000000000000','authenticated','authenticated','t8@test.invalid');
create temp table r (n int generated always as identity, test text, ok boolean, detail text); grant all on r to authenticated;
insert into public.tasks (id, user_id, title) values ('00000000-0000-0000-0000-0000000b0009', '00000000-0000-0000-0000-0000000000b2', 'someone else');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
insert into public.tasks (id, title, due_at, planned_at, repeat_rule) values ('00000000-0000-0000-0000-0000000b0001', 'Call GVEC', '2026-10-01T22:00:00Z', '2026-10-01T14:00:00Z', '{"every":1,"unit":"week","tz":"America/Chicago"}');
insert into public.notifications (id, task_id, kind, offset_minutes) values ('00000000-0000-0000-0000-0000000bb001', '00000000-0000-0000-0000-0000000b0001', 'before_due', 60);
insert into public.notifications (id, task_id, kind, offset_minutes) values ('00000000-0000-0000-0000-0000000bb002', '00000000-0000-0000-0000-0000000b0001', 'before_planned', 0);
insert into public.notifications (id, task_id, kind, at) values ('00000000-0000-0000-0000-0000000bb003', '00000000-0000-0000-0000-0000000b0001', 'at', '2026-09-30T15:00:00Z');
insert into r (test, ok, detail) select '1 hour before due', fire_at = '2026-10-01T21:00:00Z', '' from public.notifications where id = '00000000-0000-0000-0000-0000000bb001';
insert into r (test, ok, detail) select 'at planned time', fire_at = '2026-10-01T14:00:00Z', '' from public.notifications where id = '00000000-0000-0000-0000-0000000bb002';
insert into r (test, ok, detail) select 'absolute time', fire_at = '2026-09-30T15:00:00Z', '' from public.notifications where id = '00000000-0000-0000-0000-0000000bb003';
update public.notifications set sent_at = now() where id = '00000000-0000-0000-0000-0000000bb001';
update public.tasks set due_at = '2026-10-02T22:00:00Z' where id = '00000000-0000-0000-0000-0000000b0001';
insert into r (test, ok, detail) select 'moving the due date moves and re-arms the reminder', fire_at = '2026-10-02T21:00:00Z' and sent_at is null, '' from public.notifications where id = '00000000-0000-0000-0000-0000000bb001';
update public.notifications set sent_at = now() where id = '00000000-0000-0000-0000-0000000bb002';
update public.tasks set title = 'Call GVEC (renamed)' where id = '00000000-0000-0000-0000-0000000b0001';
insert into r (test, ok, detail) select 'unrelated edits keep sent reminders sent', sent_at is not null, '' from public.notifications where id = '00000000-0000-0000-0000-0000000bb002';
update public.tasks set completed_at = now() where id = '00000000-0000-0000-0000-0000000b0001';
insert into r (test, ok, detail) select 'next occurrence brings its reminders (moved a week)',
  (select count(*) from public.notifications n join public.tasks t on t.id = n.task_id where t.title = 'Call GVEC (renamed)' and t.completed_at is null) = 3
  and exists (select 1 from public.notifications n join public.tasks t on t.id = n.task_id where t.completed_at is null and n.kind = 'at' and n.fire_at = '2026-10-07T15:00:00Z'), '';
do $$ begin
  insert into public.notifications (task_id, kind) values ('00000000-0000-0000-0000-0000000b0009', 'at_defer');
  insert into r (test, ok, detail) values ('cannot add a reminder to someone else''s task', false, 'inserted');
exception when others then insert into r (test, ok, detail) values ('cannot add a reminder to someone else''s task', true, sqlerrm); end $$;
do $$ begin
  insert into public.notifications (task_id, kind) values ('00000000-0000-0000-0000-0000000b0001', 'at');
  insert into r (test, ok, detail) values ('an "at" reminder needs a time', false, '');
exception when check_violation then insert into r (test, ok, detail) values ('an "at" reminder needs a time', true, ''); end $$;
delete from public.notifications where id = '00000000-0000-0000-0000-0000000bb003';
insert into r (test, ok, detail) select 'reminders can be removed', not exists (select 1 from public.notifications where id = '00000000-0000-0000-0000-0000000bb003'), '';
select test, ok, detail from r order by n;
rollback;
