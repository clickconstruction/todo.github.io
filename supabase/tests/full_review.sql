-- Full Review (migrations 20261015000001/2). One rolled-back transaction; every row should be ok = true.
begin;
insert into auth.users (id, instance_id, aud, role, email) values ('00000000-0000-0000-0000-0000000000f5','00000000-0000-0000-0000-000000000000','authenticated','authenticated','fr@test.invalid');
insert into auth.users (id, instance_id, aud, role, email) values ('00000000-0000-0000-0000-0000000000f6','00000000-0000-0000-0000-000000000000','authenticated','authenticated','fr2@test.invalid');
create temp table r (n int generated always as identity, test text, ok boolean, detail text); grant all on r to authenticated;
create temp table res (k text, v jsonb); grant all on res to authenticated;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000f5","role":"authenticated"}', true);
insert into public.tasks (id, title, in_inbox, created_at, updated_at) values
 ('00000000-0000-0000-0000-00000000f101', 'Update my will', false, '2020-01-01', '2020-01-01'),
 ('00000000-0000-0000-0000-00000000f102', 'Movie A', false, '2021-01-01', '2021-01-01'),
 ('00000000-0000-0000-0000-00000000f103', 'Movie B', false, '2022-01-01', '2022-01-01'),
 ('00000000-0000-0000-0000-00000000f104', 'Movie C', false, '2023-01-01', '2023-01-01');
insert into public.review_sessions (id, title) values ('00000000-0000-0000-0000-00000000f201', 'Test');
insert into public.review_items (id, session_id, sort, kind, task_id, priority) values ('00000000-0000-0000-0000-00000000f301', '00000000-0000-0000-0000-00000000f201', 1, 'task', '00000000-0000-0000-0000-00000000f101', true);
insert into public.review_items (id, session_id, sort, kind, grp) values ('00000000-0000-0000-0000-00000000f302', '00000000-0000-0000-0000-00000000f201', 2, 'group', '{"label":"Movies","task_ids":["00000000-0000-0000-0000-00000000f102","00000000-0000-0000-0000-00000000f103","00000000-0000-0000-0000-00000000f104"],"proposal":{"op":"keep_newest","keep":1}}');
update public.review_sessions set current_item = '00000000-0000-0000-0000-00000000f301' where id = '00000000-0000-0000-0000-00000000f201';
insert into res select 'd1', public.review_decide('00000000-0000-0000-0000-00000000f301', 'someday', 'agent', 'Parked for now');
insert into r (test, ok, detail) select 'someday: tagged, card reviewed by the agent, note kept, next card current',
  exists (select 1 from public.task_tags tt join public.tags g on g.id = tt.tag_id where tt.task_id = '00000000-0000-0000-0000-00000000f101' and g.name = 'Someday')
  and (select status = 'reviewed' and decided_by = 'agent' and note = 'Parked for now' from public.review_items where id = '00000000-0000-0000-0000-00000000f301')
  and (select current_item = '00000000-0000-0000-0000-00000000f302' and agent_seen_at is not null from public.review_sessions where id = '00000000-0000-0000-0000-00000000f201'), (select v::text from res where k = 'd1');
do $$ begin perform public.review_decide('00000000-0000-0000-0000-00000000f301', 'keep'); insert into r (test, ok) values ('deciding twice refused', false);
exception when others then insert into r (test, ok, detail) values ('deciding twice refused', sqlerrm like '%already decided%', sqlerrm); end $$;
do $$ begin perform public.review_decide('00000000-0000-0000-0000-00000000f302', 'someday'); insert into r (test, ok) values ('a group takes group decisions only', false);
exception when others then insert into r (test, ok, detail) values ('a group takes group decisions only', sqlerrm like 'For a group%', sqlerrm); end $$;
insert into res select 'u1', public.review_undo('00000000-0000-0000-0000-00000000f301');
insert into r (test, ok, detail) select 'undo: Someday removed, card pending and current again',
  not exists (select 1 from public.task_tags where task_id = '00000000-0000-0000-0000-00000000f101')
  and (select status = 'pending' from public.review_items where id = '00000000-0000-0000-0000-00000000f301')
  and (select current_item = '00000000-0000-0000-0000-00000000f301' from public.review_sessions where id = '00000000-0000-0000-0000-00000000f201'), '';
insert into res select 'd2', public.review_decide('00000000-0000-0000-0000-00000000f301', 'keep');
insert into res select 'd3', public.review_decide('00000000-0000-0000-0000-00000000f302', 'one_by_one');
insert into r (test, ok, detail) select 'one by one: three cards right after the group, the first is current',
  (select count(*) from public.review_items where session_id = '00000000-0000-0000-0000-00000000f201' and kind = 'task' and sort > 2 and sort < 3) = 3
  and (select i.task_id = '00000000-0000-0000-0000-00000000f102' from public.review_sessions s join public.review_items i on i.id = s.current_item where s.id = '00000000-0000-0000-0000-00000000f201'), '';
insert into res select 'u2', public.review_undo('00000000-0000-0000-0000-00000000f302');
insert into r (test, ok, detail) select 'undo one by one: those cards are void, the group is back', (select count(*) from public.review_items where session_id = '00000000-0000-0000-0000-00000000f201' and status = 'void') = 3
  and (select status = 'pending' from public.review_items where id = '00000000-0000-0000-0000-00000000f302'), '';
insert into res select 'd4', public.review_decide('00000000-0000-0000-0000-00000000f302', 'accept');
insert into r (test, ok, detail) select 'accept keep_newest 1: the two older → Someday, newest stays; review done',
  (select count(*) from public.task_tags tt join public.tags g on g.id = tt.tag_id where g.name = 'Someday' and tt.task_id in ('00000000-0000-0000-0000-00000000f102','00000000-0000-0000-0000-00000000f103')) = 2
  and not exists (select 1 from public.task_tags where task_id = '00000000-0000-0000-0000-00000000f104')
  and (select status = 'done' and current_item is null from public.review_sessions where id = '00000000-0000-0000-0000-00000000f201'), (select v::text from res where k = 'd4');
do $$ begin delete from public.review_items where session_id = '00000000-0000-0000-0000-00000000f201'; insert into r (test, ok) values ('cards are never deleted', (select count(*) from public.review_items where session_id = '00000000-0000-0000-0000-00000000f201') = 5);
exception when others then insert into r (test, ok, detail) values ('cards are never deleted', true, sqlerrm); end $$;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000f6","role":"authenticated"}', true);
do $$ begin perform public.review_undo('00000000-0000-0000-0000-00000000f302'); insert into r (test, ok) values ('another user: not found', false);
exception when others then insert into r (test, ok, detail) values ('another user: not found', sqlerrm like 'Card not found%', sqlerrm); end $$;
insert into r (test, ok, detail) select 'another user sees no sessions', count(*) = 0, '' from public.review_sessions;
reset role;
select count(*) filter (where ok) as passed, count(*) as total, string_agg(case when not ok then test || ': ' || coalesce(detail, '') end, '; ') as failed from r;
rollback;
