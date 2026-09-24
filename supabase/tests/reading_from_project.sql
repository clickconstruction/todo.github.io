-- A project onto Reading & watching (migration 20261019000001). One rolled-back transaction; every row ok = true.
begin;
insert into auth.users (id, instance_id, aud, role, email) values ('00000000-0000-0000-0000-0000000000fb','00000000-0000-0000-0000-000000000000','authenticated','authenticated','rp@test.invalid');
create temp table r (n int generated always as identity, test text, ok boolean, detail text); grant all on r to authenticated;
create temp table res (k text, v jsonb); grant all on res to authenticated;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000fb","role":"authenticated"}', true);
insert into public.projects (id, name) values ('00000000-0000-0000-0000-00000000f001', 'Books (Priority)'), ('00000000-0000-0000-0000-00000000f002', 'Movies');
insert into public.tasks (id, title, notes, project_id, parent_id, flagged, in_inbox, created_at, updated_at) values
 ('00000000-0000-0000-0000-00000000f101', 'Read Books', '', '00000000-0000-0000-0000-00000000f001', null, false, false, '2022-01-01', '2022-01-01'),
 ('00000000-0000-0000-0000-00000000f102', 'Read Freakonomics', '', '00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000f101', false, false, '2022-01-01', '2022-01-01'),
 ('00000000-0000-0000-0000-00000000f103', 'Listen to extreme ownership audiobook', 'https://example.com/eo', '00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000f101', false, false, '2022-01-01', '2022-01-01'),
 ('00000000-0000-0000-0000-00000000f104', 'Listen to the genius zone', '', '00000000-0000-0000-0000-00000000f001', null, true, false, '2022-01-01', '2022-01-01'),
 ('00000000-0000-0000-0000-00000000f201', 'Watch Star Trek the next generation', '', '00000000-0000-0000-0000-00000000f002', null, true, false, '2024-02-09', '2024-02-09'),
 ('00000000-0000-0000-0000-00000000f202', 'Arrival', '', '00000000-0000-0000-0000-00000000f002', null, false, false, '2024-02-09', '2024-02-09');
insert into public.review_sessions (id) values ('00000000-0000-0000-0000-00000000f301');
insert into public.review_items (id, session_id, sort, kind, task_id, grp) values
 ('00000000-0000-0000-0000-00000000f401', '00000000-0000-0000-0000-00000000f301', 1, 'task', '00000000-0000-0000-0000-00000000f201', null),
 ('00000000-0000-0000-0000-00000000f402', '00000000-0000-0000-0000-00000000f301', 2, 'group', null, '{"task_ids": ["00000000-0000-0000-0000-00000000f102", "00000000-0000-0000-0000-00000000f103"]}');
insert into res select 'b', public.reading_from_project('00000000-0000-0000-0000-00000000f001', 'book', true);
insert into r (test, ok, detail) select 'books: 3 leaves moved, 1 container', (v->>'moved')::int = 3 and (v->>'containers')::int = 1 and (v->>'review_cards')::int = 1, v::text from res where k = 'b';
insert into r (test, ok, detail) select 'books: up next, typed book, flagged, out of project and group, in Someday',
  bool_and(reading_state = 'up_next' and reading_type = 'book' and flagged and project_id is null and parent_id is null
    and exists (select 1 from public.task_tags tt join public.tags g on g.id = tt.tag_id where tt.task_id = t.id and g.name = 'Someday')), ''
  from public.tasks t where id in ('00000000-0000-0000-0000-00000000f102', '00000000-0000-0000-0000-00000000f103', '00000000-0000-0000-0000-00000000f104');
insert into r (test, ok, detail) select 'link kept from the notes', reading_url = 'https://example.com/eo', coalesce(reading_url, '∅') from public.tasks where id = '00000000-0000-0000-0000-00000000f103';
insert into r (test, ok, detail) select 'container completed, project completed, group card voided',
  (select completed_at is not null from public.tasks where id = '00000000-0000-0000-0000-00000000f101')
  and (select status = 'completed' from public.projects where id = '00000000-0000-0000-0000-00000000f001')
  and (select status = 'void' from public.review_items where id = '00000000-0000-0000-0000-00000000f402'), '';
insert into res select 'm', public.reading_from_project('00000000-0000-0000-0000-00000000f002', 'video', false);
insert into r (test, ok, detail) select 'movies: videos, unflagged; card voided', bool_and(reading_type = 'video' and not flagged) and (select status = 'void' from public.review_items where id = '00000000-0000-0000-0000-00000000f401'), ''
  from public.tasks where project_id is null and id in ('00000000-0000-0000-0000-00000000f201', '00000000-0000-0000-0000-00000000f202');
select public.bulk_undo((select (v->>'op_id')::uuid from res where k = 'b'));
insert into r (test, ok, detail) select 'undo: books back in their project and group, as they were',
  (select bool_and(reading_state is null and project_id = '00000000-0000-0000-0000-00000000f001' and updated_at = '2022-01-01') from public.tasks where id in ('00000000-0000-0000-0000-00000000f101', '00000000-0000-0000-0000-00000000f102', '00000000-0000-0000-0000-00000000f103', '00000000-0000-0000-0000-00000000f104'))
  and (select parent_id = '00000000-0000-0000-0000-00000000f101' and not flagged from public.tasks where id = '00000000-0000-0000-0000-00000000f102')
  and (select flagged from public.tasks where id = '00000000-0000-0000-0000-00000000f104')
  and (select completed_at is null from public.tasks where id = '00000000-0000-0000-0000-00000000f101')
  and (select status = 'active' from public.projects where id = '00000000-0000-0000-0000-00000000f001')
  and (select status = 'pending' from public.review_items where id = '00000000-0000-0000-0000-00000000f402')
  and not exists (select 1 from public.task_tags where task_id in ('00000000-0000-0000-0000-00000000f102', '00000000-0000-0000-0000-00000000f103', '00000000-0000-0000-0000-00000000f104')), '';
do $$ begin perform public.bulk_undo((select (v->>'op_id')::uuid from res where k = 'b')); insert into r (test, ok) values ('undo twice refused', false);
exception when others then insert into r (test, ok, detail) values ('undo twice refused', true, sqlerrm); end $$;
do $$ begin delete from public.bulk_ops; insert into r (test, ok) values ('bulk ops are never deleted', (select count(*) from public.bulk_ops) = 2);
exception when others then insert into r (test, ok, detail) values ('bulk ops are never deleted', true, sqlerrm); end $$;
reset role;
select count(*) filter (where ok) as passed, count(*) as total, string_agg(case when not ok then test || ': ' || coalesce(detail, '') end, '; ') as failed from r;
rollback;
