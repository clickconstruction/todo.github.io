-- Plan it (migration 20261007000001): apply_project_plan / undo_project_plan.
-- One rolled-back transaction; every row should be ok = true.
begin;
insert into auth.users (id, instance_id, aud, role, email) values ('00000000-0000-0000-0000-0000000000d7','00000000-0000-0000-0000-000000000000','authenticated','authenticated','plan1@test.invalid'),('00000000-0000-0000-0000-0000000000d8','00000000-0000-0000-0000-000000000000','authenticated','authenticated','plan2@test.invalid');
create temp table r (n int generated always as identity, test text, ok boolean, detail text); grant all on r to authenticated;
insert into public.projects (id, user_id, name) values ('00000000-0000-0000-0000-0000000000e9', '00000000-0000-0000-0000-0000000000d8', 'Theirs');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000d7","role":"authenticated"}', true);
insert into public.projects (id, name, purpose, principles, outcome) values ('00000000-0000-0000-0000-0000000000ea', 'Smith bathroom', 'So they can use it by the holidays', 'Under $18k', 'Final inspection passed');
insert into public.tasks (title, project_id, in_inbox, sort) values ('Site visit', '00000000-0000-0000-0000-0000000000ea', false, 0);
update public.projects set plan = '{"mode":"full","ideas":[{"id":"i1","text":"Book the tile sub","bucket":"action"},{"id":"i2","text":"Order vanity","bucket":"g:m"},{"id":"i3","text":"Tile samples","bucket":"g:m"},{"id":"i4","text":"Pull permit","bucket":"g:p"},{"id":"i5","text":"Rough-in inspection","bucket":"g:p"},{"id":"i6","text":"Heated floor","bucket":"someday"},{"id":"i7","text":"Tile: Daltile 12x24 gray","bucket":"reference"},{"id":"i8","text":"Old idea","bucket":"drop"},{"id":"i9","text":"Call Smith","bucket":null}],"groups":[{"id":"p","name":"Permits","in_order":true},{"id":"m","name":"Materials"},{"id":"e","name":"Empty"}],"next":{"project":"i9","m":"i3"}}' where id = '00000000-0000-0000-0000-0000000000ea';
select public.apply_project_plan('00000000-0000-0000-0000-0000000000ea') into temp res;
insert into r (test, ok, detail) select 'apply returns counts', (x->>'tasks')::int = 9 and (x->>'references')::int = 1, x::text from res t(x);
insert into r (test, ok, detail) select 'groups are action groups with steps (in order kept), empty group skipped',
  (select count(*) from public.tasks where parent_id is null and title in ('Permits','Materials') and project_id = '00000000-0000-0000-0000-0000000000ea') = 2
  and (select steps_in_order from public.tasks where title = 'Permits') and not exists (select 1 from public.tasks where title = 'Empty')
  and (select count(*) from public.tasks c join public.tasks g on g.id = c.parent_id where g.title = 'Permits') = 2, '';
insert into r (test, ok, detail) select 'next actions lead: project and group', (select title from public.tasks where project_id = '00000000-0000-0000-0000-0000000000ea' and parent_id is null and sort = 1) = 'Call Smith'
  and (select c.title from public.tasks c join public.tasks g on g.id = c.parent_id where g.title = 'Materials' order by c.sort limit 1) = 'Tile samples', '';
insert into r (test, ok, detail) select 'existing actions stay first', (select sort from public.tasks where title = 'Site visit') = 0, '';
insert into r (test, ok, detail) select 'someday idea: in the project, on-hold Someday tag', exists (select 1 from public.tasks t join public.task_tags x on x.task_id = t.id join public.tags g on g.id = x.tag_id where t.title = 'Heated floor' and g.name = 'Someday' and g.status = 'on_hold'), '';
insert into r (test, ok, detail) select 'reference idea filed with the project', exists (select 1 from public.reference_items where title like 'Tile: Daltile%' and project_id = '00000000-0000-0000-0000-0000000000ea'), '';
insert into r (test, ok, detail) select 'dropped idea not created', not exists (select 1 from public.tasks where title = 'Old idea'), '';
do $$ begin perform public.apply_project_plan('00000000-0000-0000-0000-0000000000ea'); insert into r (test, ok, detail) values ('can''t apply twice', false, '');
exception when others then insert into r (test, ok, detail) values ('can''t apply twice', sqlerrm like '%already created%', sqlerrm); end $$;
do $$ begin perform public.apply_project_plan('00000000-0000-0000-0000-0000000000e9'); insert into r (test, ok, detail) values ('can''t plan another user''s project', false, '');
exception when others then insert into r (test, ok, detail) values ('can''t plan another user''s project', sqlerrm = 'Project not found.', sqlerrm); end $$;
select public.undo_project_plan('00000000-0000-0000-0000-0000000000ea') into temp und;
insert into r (test, ok, detail) select 'undo drops what it made, keeps what was there', (x->>'tasks_dropped')::int >= 7 and (select count(*) from public.tasks where project_id = '00000000-0000-0000-0000-0000000000ea' and dropped_at is null) = 1 and (select dropped_at is null from public.tasks where title = 'Site visit'), x::text from und t(x);
insert into r (test, ok, detail) select 'undo archives the reference item, clears applied', (select archived_at is not null from public.reference_items where title like 'Tile: Daltile%') and not (select plan ? 'applied' from public.projects where id = '00000000-0000-0000-0000-0000000000ea'), '';
select test, ok, detail from r order by n;
rollback;
