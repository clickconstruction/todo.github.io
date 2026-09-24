-- Full Review suggestions with steps (migration 20261020000001). One rolled-back transaction; every row ok = true.
begin;
insert into auth.users (id, instance_id, aud, role, email) values ('00000000-0000-0000-0000-0000000000fc','00000000-0000-0000-0000-000000000000','authenticated','authenticated','rs@test.invalid');
create temp table r (n int generated always as identity, test text, ok boolean, detail text); grant all on r to authenticated;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000fc","role":"authenticated"}', true);
insert into public.projects (id, name) values ('00000000-0000-0000-0000-00000000c001', 'Housing Feeder');
insert into public.tasks (id, title, project_id, in_inbox, created_at, updated_at) values
 ('00000000-0000-0000-0000-00000000c101', 'Start this when I can afford it: Housing Feeder', '00000000-0000-0000-0000-00000000c001', false, '2024-01-07', '2024-01-07');
-- an earlier step, already done (so dropping the new ones would normally complete the parent)
select set_config('app.importing', 'on', true);
insert into public.tasks (id, title, project_id, parent_id, in_inbox, sort, completed_at) values
 ('00000000-0000-0000-0000-00000000c102', 'Pick the first spot', '00000000-0000-0000-0000-00000000c001', '00000000-0000-0000-0000-00000000c101', false, 0, now());
select set_config('app.importing', 'off', true);
insert into public.review_sessions (id) values ('00000000-0000-0000-0000-00000000c201');
insert into public.review_items (id, session_id, sort, kind, task_id, suggestion) values
 ('00000000-0000-0000-0000-00000000c301', '00000000-0000-0000-0000-00000000c201', 1, 'task', '00000000-0000-0000-0000-00000000c101',
  '{"decision": "keep", "title": "Build container site A", "steps": ["Cut out the spot", "Run power", "  ", "Run water", "Run sewage", "Place the containers", "Put them together", "Frame the inside", "Insulate"], "steps_in_order": true}');
select public.review_apply('00000000-0000-0000-0000-00000000c301');
insert into r (test, ok, detail) select 'submit: 8 steps (blank skipped), in order, after the existing one, in the project',
  count(*) = 8 and bool_and(project_id = '00000000-0000-0000-0000-00000000c001' and not in_inbox) and min(sort) = 1
  and string_agg(title, '|' order by sort) = 'Cut out the spot|Run power|Run water|Run sewage|Place the containers|Put them together|Frame the inside|Insulate', string_agg(title, '|' order by sort)
  from public.tasks where parent_id = '00000000-0000-0000-0000-00000000c101' and completed_at is null;
insert into r (test, ok, detail) select 'submit: renamed, do steps in order, card reviewed', t.title = 'Build container site A' and t.steps_in_order
  and (select status = 'reviewed' from public.review_items where id = '00000000-0000-0000-0000-00000000c301'), '' from public.tasks t where t.id = '00000000-0000-0000-0000-00000000c101';
select public.review_undo('00000000-0000-0000-0000-00000000c301');
insert into r (test, ok, detail) select 'undo: steps dropped (not deleted), title and order back, action still open',
  (select count(*) = 8 from public.tasks where parent_id = '00000000-0000-0000-0000-00000000c101' and dropped_at is not null)
  and (select count(*) = 9 from public.tasks where parent_id = '00000000-0000-0000-0000-00000000c101')
  and (select title = 'Start this when I can afford it: Housing Feeder' and not steps_in_order and completed_at is null and dropped_at is null from public.tasks where id = '00000000-0000-0000-0000-00000000c101')
  and (select status = 'pending' from public.review_items where id = '00000000-0000-0000-0000-00000000c301'), '';
-- steps are ignored for done / drop
update public.review_items set suggestion = '{"decision": "drop", "steps": ["x"]}' where id = '00000000-0000-0000-0000-00000000c301';
select public.review_apply('00000000-0000-0000-0000-00000000c301');
insert into r (test, ok, detail) select 'drop with steps: no steps added', not exists (select 1 from public.tasks where parent_id = '00000000-0000-0000-0000-00000000c101' and title = 'x'), '';
reset role;
select count(*) filter (where ok) as passed, count(*) as total, string_agg(case when not ok then test || ': ' || coalesce(detail, '') end, '; ') as failed from r;
rollback;
