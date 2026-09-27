-- Full Review suggestions with a checklist (migration 20261030000001). One rolled-back transaction; every row ok = true.
begin;
insert into auth.users (id, instance_id, aud, role, email) values ('00000000-0000-0000-0000-0000000000ff','00000000-0000-0000-0000-000000000000','authenticated','authenticated','rc@test.invalid');
create temp table r (n int generated always as identity, test text, ok boolean, detail text); grant all on r to authenticated;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000ff","role":"authenticated"}', true);
insert into public.tasks (id, title) values ('00000000-0000-0000-0000-00000000f101', 'Are my companies on track?');
insert into public.checklists (id, name, items) values ('00000000-0000-0000-0000-00000000f501', 'Old list', '[{"id":"x","text":"Old"}]');
update public.tasks set checklist_id = '00000000-0000-0000-0000-00000000f501' where id = '00000000-0000-0000-0000-00000000f101';
insert into public.review_sessions (id) values ('00000000-0000-0000-0000-00000000f201');
insert into public.review_items (id, session_id, sort, kind, task_id, suggestion) values
 ('00000000-0000-0000-0000-00000000f301', '00000000-0000-0000-0000-00000000f201', 1, 'task', '00000000-0000-0000-0000-00000000f101',
  '{"decision": "keep", "checklist": {"name": "Companies check-in", "items": [{"id":"a","text":"ARC Equity","section":"Active"},{"id":"b","text":"WYHF","section":"On hold"}], "reflect": true, "complete_action": false}}');
select public.review_apply('00000000-0000-0000-0000-00000000f301');
insert into r (test, ok, detail) select 'submit: a new checklist, made as suggested, attached to the action',
  c.name = 'Companies check-in' and c.reflect and not c.complete_action and jsonb_array_length(c.items) = 2 and c.items->0->>'section' = 'Active', c.name
  from public.tasks t join public.checklists c on c.id = t.checklist_id where t.id = '00000000-0000-0000-0000-00000000f101';
select public.review_undo('00000000-0000-0000-0000-00000000f301');
insert into r (test, ok, detail) select 'undo: the old checklist is back on the action',
  checklist_id = '00000000-0000-0000-0000-00000000f501', '' from public.tasks where id = '00000000-0000-0000-0000-00000000f101';
insert into r (test, ok, detail) select 'undo: the checklist it made is archived, not deleted',
  count(*) = 1 and bool_and(archived_at is not null), '' from public.checklists where name = 'Companies check-in';
update public.review_items set suggestion = '{"decision": "keep", "checklist": {"id": "00000000-0000-0000-0000-00000000f501"}}' where id = '00000000-0000-0000-0000-00000000f301';
update public.tasks set checklist_id = null where id = '00000000-0000-0000-0000-00000000f101';
select public.review_apply('00000000-0000-0000-0000-00000000f301');
insert into r (test, ok, detail) select 'an existing checklist is attached, nothing new made',
  (select checklist_id = '00000000-0000-0000-0000-00000000f501' from public.tasks where id = '00000000-0000-0000-0000-00000000f101')
  and (select count(*) = 2 from public.checklists), '';
select public.review_undo('00000000-0000-0000-0000-00000000f301');
insert into r (test, ok, detail) select 'undo leaves an existing checklist alone', archived_at is null, '' from public.checklists where id = '00000000-0000-0000-0000-00000000f501';
update public.review_items set suggestion = '{"decision": "drop", "checklist": {"name": "Ignored", "items": []}}' where id = '00000000-0000-0000-0000-00000000f301';
select public.review_apply('00000000-0000-0000-0000-00000000f301');
insert into r (test, ok, detail) select 'drop with a checklist: nothing made', not exists (select 1 from public.checklists where name = 'Ignored'), '';
reset role;
select test, ok, detail from r order by n;
rollback;
