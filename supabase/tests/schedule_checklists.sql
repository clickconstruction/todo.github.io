-- Schedule it and checklists (migration 20261009000001). One rolled-back transaction; every row ok = true.
begin;
insert into auth.users (id, instance_id, aud, role, email) values ('00000000-0000-0000-0000-0000000000b7','00000000-0000-0000-0000-000000000000','authenticated','authenticated','ck1@test.invalid'),('00000000-0000-0000-0000-0000000000b8','00000000-0000-0000-0000-000000000000','authenticated','authenticated','ck2@test.invalid');
create temp table r (n int generated always as identity, test text, ok boolean, detail text); grant all on r to authenticated;
insert into public.checklists (id, user_id, name) values ('00000000-0000-0000-0000-0000000000f7', '00000000-0000-0000-0000-0000000000b8', 'Theirs');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b7","role":"authenticated"}', true);
insert into public.checklists (id, name, items) values ('00000000-0000-0000-0000-0000000000c1', 'Month-end close', '[{"id":"a","text":"Invoice"},{"id":"b","text":"Reconcile"}]');
insert into r (test, ok, detail) select 'owner makes a checklist; can''t see others', count(*) = 1 and bool_and(complete_action), '' from public.checklists;
insert into public.tasks (id, title, in_inbox, checklist_id, repeat_rule, due_at, scheduled_at, scheduled_minutes, energy)
  values ('00000000-0000-0000-0000-0000000000c2', 'Month-end close', false, '00000000-0000-0000-0000-0000000000c1', '{"every":1,"unit":"month","from":"assigned"}', '2026-10-31 22:00+00', '2026-10-31 15:00+00', 60, 'low');
do $$ begin update public.tasks set checklist_id = '00000000-0000-0000-0000-0000000000f7' where id = '00000000-0000-0000-0000-0000000000c2'; insert into r (test, ok, detail) values ('can''t attach another user''s checklist', false, '');
exception when foreign_key_violation then insert into r (test, ok, detail) values ('can''t attach another user''s checklist', true, sqlerrm); end $$;
insert into public.checklist_runs (checklist_id, task_id, total, ticked) values ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c2', 2, '["a"]');
do $$ begin insert into public.checklist_runs (checklist_id, task_id, total) values ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c2', 2); insert into r (test, ok, detail) values ('one run in progress per checklist and action', false, '');
exception when unique_violation then insert into r (test, ok, detail) values ('one run in progress per checklist and action', true, sqlerrm); end $$;
do $$ begin insert into public.checklist_runs (checklist_id, total) values ('00000000-0000-0000-0000-0000000000f7', 1); insert into r (test, ok, detail) values ('can''t run another user''s checklist', false, '');
exception when foreign_key_violation then insert into r (test, ok, detail) values ('can''t run another user''s checklist', true, sqlerrm); end $$;
update public.tasks set completed_at = now() where id = '00000000-0000-0000-0000-0000000000c2';
insert into r (test, ok, detail) select 'repeat: the next occurrence keeps the checklist, energy and the time block (shifted a month)',
  checklist_id = '00000000-0000-0000-0000-0000000000c1' and energy = 'low' and scheduled_minutes = 60 and scheduled_at = '2026-11-30 15:00+00', coalesce(scheduled_at::text, 'none')
  from public.tasks where title = 'Month-end close' and completed_at is null;
do $$ begin update public.tasks set scheduled_minutes = 1 where title = 'Month-end close' and completed_at is null; insert into r (test, ok, detail) values ('time blocks are 5 min to 12 h', false, '');
exception when check_violation then insert into r (test, ok, detail) values ('time blocks are 5 min to 12 h', true, sqlerrm); end $$;
insert into public.api_tokens (name, token_hash, token_hint, scope) values ('Calendar feed', repeat('e', 64), 'eeee', 'feed');
insert into r (test, ok, detail) values ('feed keys are allowed', true, '');
delete from public.checklists; delete from public.checklist_runs;
insert into r (test, ok, detail) select 'checklists and runs can''t be deleted', (select count(*) from public.checklists) = 1 and (select count(*) from public.checklist_runs) = 1, '';
select test, ok, detail from r order by n;
rollback;
