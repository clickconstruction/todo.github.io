-- Tech tree grown from a review (migration 20261105000001). One rolled-back transaction; every row ok = true.
begin;
insert into auth.users (id, instance_id, aud, role, email) values ('00000000-0000-0000-0000-0000001b0001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','tr1@test.invalid'),('00000000-0000-0000-0000-0000001b0002','00000000-0000-0000-0000-000000000000','authenticated','authenticated','tr2@test.invalid');
create temp table r (n int generated always as identity, test text, ok boolean, detail text); grant all on r to authenticated;
insert into public.projects (id, user_id, name) values ('00000000-0000-0000-0000-0000001b00f1', '00000000-0000-0000-0000-0000001b0002', 'Theirs');
insert into public.tasks (user_id, title, in_inbox, project_id, completed_at) values ('00000000-0000-0000-0000-0000001b0002', 'Their done card', false, '00000000-0000-0000-0000-0000001b00f1', now());
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000001b0001","role":"authenticated"}', true);
insert into public.projects (id, name) values ('00000000-0000-0000-0000-0000001b0011', 'Life Goals'), ('00000000-0000-0000-0000-0000001b0012', 'Farm 1');
insert into public.goals (id, title, kind) values ('00000000-0000-0000-0000-0000001b0021', 'Astronaut', 'destination');
insert into public.tasks (id, title, in_inbox, project_id) values ('00000000-0000-0000-0000-0000001b0031', 'Check my Life Flowchart', false, '00000000-0000-0000-0000-0000001b0011');
insert into public.tasks (title, in_inbox, project_id, completed_at) values ('Done lately', false, '00000000-0000-0000-0000-0000001b0012', now() - interval '3 days'), ('Done lately too', false, '00000000-0000-0000-0000-0000001b0012', now() - interval '10 days'), ('Done long ago', false, '00000000-0000-0000-0000-0000001b0012', now() - interval '200 days');
insert into public.review_sessions (id, title) values ('00000000-0000-0000-0000-0000001b00b1', 'Tree review test');
insert into public.review_items (id, session_id, kind, task_id, sort, suggestion) values ('00000000-0000-0000-0000-0000001b00c1', '00000000-0000-0000-0000-0000001b00b1', 'task', '00000000-0000-0000-0000-0000001b0031', 1,
  '{"decision":"keep","title":"Yearly: check my tech tree","tree":{"items":[
     {"kind":"destination","title":"Astronaut","exists":{"kind":"goal","id":"00000000-0000-0000-0000-0000001b0021"}},
     {"kind":"destination","title":"Significant physical assets (homes)"},
     {"kind":"card","title":"Map the path to astronaut","project_id":"00000000-0000-0000-0000-0000001b0011"},
     {"kind":"milestone","title":"Farm 1 paid for"},
     {"kind":"project","title":"Farm 1","exists":{"kind":"project","id":"00000000-0000-0000-0000-0000001b0012"}}],
   "links":[{"node":1,"requires":3},{"node":3,"requires":4}]}}');
select public.review_apply('00000000-0000-0000-0000-0000001b00c1');
insert into r (test, ok, detail) select 'Submit makes what is new and reuses what is there', (select count(*) from public.goals where title = 'Astronaut') = 1 and (select kind from public.goals where title = 'Significant physical assets (homes)') = 'destination'
  and (select kind from public.goals where title = 'Farm 1 paid for') = 'milestone' and (select project_id = '00000000-0000-0000-0000-0000001b0011' and not in_inbox from public.tasks where title = 'Map the path to astronaut'), (select count(*)::text from public.goals);
insert into r (test, ok, detail) select 'and links them, accepted', count(*) = 2 and bool_and(l.state = 'accepted'), count(*)::text from public.tree_links l where l.archived_at is null;
insert into r (test, ok, detail) select 'the homes destination rests on the milestone, which rests on Farm 1', exists (select 1 from public.tree_links l join public.goals g on g.id = l.node_id join public.goals m on m.id = l.requires_id where g.title like 'Significant%' and m.title = 'Farm 1 paid for')
  and exists (select 1 from public.tree_links l join public.goals m on m.id = l.node_id where m.title = 'Farm 1 paid for' and l.requires_kind = 'project' and l.requires_id = '00000000-0000-0000-0000-0000001b0012'), '';
insert into r (test, ok, detail) select 'the card itself took the suggestion', title = 'Yearly: check my tech tree', title from public.tasks where id = '00000000-0000-0000-0000-0000001b0031';
select public.review_undo('00000000-0000-0000-0000-0000001b00c1');
insert into r (test, ok, detail) select 'Undo takes back what was made: goals and the card dropped, links archived, nothing deleted',
  (select status from public.goals where title like 'Significant%') = 'dropped' and (select status from public.goals where title = 'Farm 1 paid for') = 'dropped' and (select dropped_at is not null from public.tasks where title = 'Map the path to astronaut')
  and (select count(*) from public.tree_links where archived_at is null) = 0 and (select count(*) from public.tree_links) = 2, '';
insert into r (test, ok, detail) select 'and leaves what was already there', (select status from public.goals where title = 'Astronaut') = 'active' and (select status from public.projects where id = '00000000-0000-0000-0000-0000001b0012') = 'active' and (select title from public.tasks where id = '00000000-0000-0000-0000-0000001b0031') = 'Check my Life Flowchart', '';
update public.review_items set suggestion = '{"decision":"keep","tree":{"items":[{"kind":"destination","title":"Homes","exists":{"kind":"project","id":"00000000-0000-0000-0000-0000001b00f1"}}],"links":[]}}' where id = '00000000-0000-0000-0000-0000001b00c1';
do $$ begin perform public.review_apply('00000000-0000-0000-0000-0000001b00c1'); insert into r (test, ok, detail) values ('a suggestion can''t build on another user''s project', false, '');
exception when others then insert into r (test, ok, detail) values ('a suggestion can''t build on another user''s project', sqlerrm like '%is gone%', sqlerrm); end $$;
update public.review_items set suggestion = '{"decision":"keep","tree":{"items":[{"kind":"destination","title":"A"},{"kind":"destination","title":"B"}],"links":[{"node":0,"requires":1},{"node":1,"requires":0}]}}' where id = '00000000-0000-0000-0000-0000001b00c1';
do $$ begin perform public.review_apply('00000000-0000-0000-0000-0000001b00c1'); insert into r (test, ok, detail) values ('a loop in a suggestion fails the whole Submit', false, '');
exception when check_violation then insert into r (test, ok, detail) values ('a loop in a suggestion fails the whole Submit', sqlerrm like '%loop%', sqlerrm); end $$;
insert into r (test, ok, detail) select 'and leaves nothing half made', not exists (select 1 from public.goals where title in ('A', 'B')) and (select status from public.review_items where id = '00000000-0000-0000-0000-0000001b00c1') = 'pending', '';

insert into r (test, ok, detail) select 'activity: what was finished in each project since a day and what is open in it, the owner''s only',
  (select (e->>'done')::int = 2 and (e->>'open')::int = 0 from jsonb_array_elements(a) e where e->>'project_id' = '00000000-0000-0000-0000-0000001b0012')
  and (select (e->>'done')::int = 0 and (e->>'open')::int >= 1 from jsonb_array_elements(a) e where e->>'project_id' = '00000000-0000-0000-0000-0000001b0011')
  and not exists (select 1 from jsonb_array_elements(a) e where e->>'project_id' = '00000000-0000-0000-0000-0000001b00f1'), a::text
  from (select public.tree_activity(now() - interval '60 days') as a) x;
update public.user_settings set tree_reviewed_at = now();
insert into public.user_settings (tree_reviewed_at) select now() where not exists (select 1 from public.user_settings);
insert into r (test, ok, detail) select 'the review date is kept', tree_reviewed_at is not null, '' from public.user_settings;
select test, ok, detail from r order by n;
rollback;
