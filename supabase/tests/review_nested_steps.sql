-- Full Review suggestions with nested steps (migration 20261028000001). One rolled-back transaction; every row ok = true.
begin;
insert into auth.users (id, instance_id, aud, role, email) values ('00000000-0000-0000-0000-0000000000fd','00000000-0000-0000-0000-000000000000','authenticated','authenticated','rn@test.invalid');
create temp table r (n int generated always as identity, test text, ok boolean, detail text); grant all on r to authenticated;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000fd","role":"authenticated"}', true);
insert into public.projects (id, name) values ('00000000-0000-0000-0000-00000000d001', 'Adventure');
insert into public.tasks (id, title, project_id, in_inbox) values ('00000000-0000-0000-0000-00000000d101', 'Complete the Explorers Grand Slam', '00000000-0000-0000-0000-00000000d001', false);
insert into public.review_sessions (id) values ('00000000-0000-0000-0000-00000000d201');
insert into public.review_items (id, session_id, sort, kind, task_id, suggestion) values
 ('00000000-0000-0000-0000-00000000d301', '00000000-0000-0000-0000-00000000d201', 1, 'task', '00000000-0000-0000-0000-00000000d101',
  '{"decision": "keep", "steps": ["North Pole", {"title": "Kilimanjaro", "in_order": true, "steps": ["Book the guide", {"title": "Train", "steps": ["Weekly long hike", " "]}, "Fly to Tanzania"]}, {"title": "Everest"}]}');
select public.review_apply('00000000-0000-0000-0000-00000000d301');
insert into r (test, ok, detail) select 'submit: three steps under the card, in order given',
  string_agg(title, '|' order by sort) = 'North Pole|Kilimanjaro|Everest' and bool_and(project_id = '00000000-0000-0000-0000-00000000d001'), string_agg(title, '|' order by sort)
  from public.tasks where parent_id = '00000000-0000-0000-0000-00000000d101';
insert into r (test, ok, detail) select 'a step with its own steps: three under Kilimanjaro, in order, blank skipped',
  string_agg(c.title, '|' order by c.sort) = 'Book the guide|Train|Fly to Tanzania' and bool_and(p.steps_in_order), string_agg(c.title, '|' order by c.sort)
  from public.tasks c join public.tasks p on p.id = c.parent_id where p.title = 'Kilimanjaro';
insert into r (test, ok, detail) select 'three levels down: the hike under Train, in its project',
  count(*) = 1 and bool_and(c.project_id = '00000000-0000-0000-0000-00000000d001' and not c.in_inbox), ''
  from public.tasks c join public.tasks p on p.id = c.parent_id where p.title = 'Train' and c.title = 'Weekly long hike';
insert into r (test, ok, detail) select 'undo lists every step added (7)',
  jsonb_array_length((select value->'ids' from public.review_items, jsonb_array_elements(before) where id = '00000000-0000-0000-0000-00000000d301' and value->>'t' = 'steps')) = 7, '';
select public.review_undo('00000000-0000-0000-0000-00000000d301');
insert into r (test, ok, detail) select 'undo: the whole tree dropped (not deleted), card pending again',
  (select count(*) = 7 from public.tasks where dropped_at is not null and id <> '00000000-0000-0000-0000-00000000d101')
  and (select dropped_at is null from public.tasks where id = '00000000-0000-0000-0000-00000000d101')
  and (select status = 'pending' from public.review_items where id = '00000000-0000-0000-0000-00000000d301'), '';
-- too deep: the tree's four-level rule still holds
update public.review_items set suggestion = '{"decision": "keep", "steps": [{"title": "A", "steps": [{"title": "B", "steps": [{"title": "C", "steps": ["D"]}]}]}]}' where id = '00000000-0000-0000-0000-00000000d301';
do $$ begin perform public.review_apply('00000000-0000-0000-0000-00000000d301'); insert into r (test, ok, detail) values ('a fifth level is refused', false, '');
exception when others then insert into r (test, ok, detail) values ('a fifth level is refused', sqlerrm like '%4 levels%', sqlerrm); end $$;
reset role;
select test, ok, detail from r order by n;
rollback;
