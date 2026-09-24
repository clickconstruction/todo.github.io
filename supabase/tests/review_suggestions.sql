-- Full Review suggestions (migration 20261016000001): Submit applies every field and decides; Undo
-- restores fields, tags and the suggestion. One rolled-back transaction; every row should be ok = true.
begin;
insert into auth.users (id, instance_id, aud, role, email) values ('00000000-0000-0000-0000-0000000000f7','00000000-0000-0000-0000-000000000000','authenticated','authenticated','sg@test.invalid');
create temp table r (n int generated always as identity, test text, ok boolean, detail text); grant all on r to authenticated;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000f7","role":"authenticated"}', true);
insert into public.projects (id, name) values ('00000000-0000-0000-0000-00000000e501', 'RE Mortgage');
insert into public.tags (id, name) values ('00000000-0000-0000-0000-00000000e601', 'Laptop');
insert into public.tasks (id, title, project_id, in_inbox, flagged, created_at, updated_at) values ('00000000-0000-0000-0000-00000000e701', 'I can autonomyous mortgage', null, true, true, '2025-01-28', '2025-01-28');
insert into public.task_tags (task_id, tag_id) values ('00000000-0000-0000-0000-00000000e701', '00000000-0000-0000-0000-00000000e601');
insert into public.review_sessions (id) values ('00000000-0000-0000-0000-00000000e801');
insert into public.review_items (id, session_id, sort, kind, task_id, suggestion) values ('00000000-0000-0000-0000-00000000e901', '00000000-0000-0000-0000-00000000e801', 1, 'task', '00000000-0000-0000-0000-00000000e701',
  '{"decision":"keep","title":"Build the mortgage flow","gain":"Close loans without a developer","project_id":"00000000-0000-0000-0000-00000000e501","planned":"2026-09-28T14:00:00Z","flagged":false,"add_tag_names":["Deep work"],"remove_tag_ids":["00000000-0000-0000-0000-00000000e601"],"note":"Planned Monday"}');
update public.review_sessions set current_item = '00000000-0000-0000-0000-00000000e901' where id = '00000000-0000-0000-0000-00000000e801';
select public.review_apply('00000000-0000-0000-0000-00000000e901');
insert into r (test, ok, detail) select 'Submit applies every field', title = 'Build the mortgage flow' and gain = 'Close loans without a developer' and gain_by is null and project_id = '00000000-0000-0000-0000-00000000e501' and not in_inbox and planned_at = '2026-09-28T14:00:00Z' and not flagged, title from public.tasks where id = '00000000-0000-0000-0000-00000000e701';
insert into r (test, ok, detail) select 'tags: new one created and added, removed one gone', (select array_agg(g.name order by g.name) from public.task_tags tt join public.tags g on g.id = tt.tag_id where tt.task_id = '00000000-0000-0000-0000-00000000e701') = array['Deep work'], '';
insert into r (test, ok, detail) select 'and decides: reviewed by you, note kept, marked applied', status = 'reviewed' and decision = 'keep' and decided_by = 'user' and note = 'Planned Monday' and suggestion ? 'applied_at', '' from public.review_items where id = '00000000-0000-0000-0000-00000000e901';
select public.review_undo('00000000-0000-0000-0000-00000000e901');
insert into r (test, ok, detail) select 'Undo puts every field back', title = 'I can autonomyous mortgage' and gain = '' and project_id is null and in_inbox and planned_at is null and flagged and updated_at = '2025-01-28', title from public.tasks where id = '00000000-0000-0000-0000-00000000e701';
insert into r (test, ok, detail) select 'and the tags', (select array_agg(g.name) from public.task_tags tt join public.tags g on g.id = tt.tag_id where tt.task_id = '00000000-0000-0000-0000-00000000e701') = array['Laptop'], '';
insert into r (test, ok, detail) select 'the suggestion is back, ready to Submit again', status = 'pending' and suggestion is not null and not (suggestion ? 'applied_at'), '' from public.review_items where id = '00000000-0000-0000-0000-00000000e901';
update public.review_items set suggestion = null where id = '00000000-0000-0000-0000-00000000e901';
do $$ begin perform public.review_apply('00000000-0000-0000-0000-00000000e901'); insert into r (test, ok) values ('no suggestion: refused', false);
exception when others then insert into r (test, ok, detail) values ('no suggestion: refused', sqlerrm like 'No suggestion%', sqlerrm); end $$;
reset role;
select count(*) filter (where ok) as passed, count(*) as total, string_agg(case when not ok then test || ': ' || coalesce(detail, '') end, '; ') as failed from r;
rollback;
