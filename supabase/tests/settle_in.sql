-- Settle in (migrations 20261012000001/2/3). One rolled-back transaction; every row should be ok = true.
begin;
insert into auth.users (id, instance_id, aud, role, email) values ('00000000-0000-0000-0000-0000000000f2','00000000-0000-0000-0000-000000000000','authenticated','authenticated','settle@test.invalid');
insert into auth.users (id, instance_id, aud, role, email) values ('00000000-0000-0000-0000-0000000000f3','00000000-0000-0000-0000-000000000000','authenticated','authenticated','other@test.invalid');
create temp table r (n int generated always as identity, test text, ok boolean, detail text); grant all on r to authenticated;
create temp table res (k text, v jsonb); grant all on res to authenticated;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000f2","role":"authenticated"}', true);
insert into public.imports (id, source) values ('00000000-0000-0000-0000-00000000a001', 'omnifocus');
insert into public.projects (id, name, import_id) values ('00000000-0000-0000-0000-00000000b001', 'Imported', '00000000-0000-0000-0000-00000000a001');
insert into public.projects (id, name) values ('00000000-0000-0000-0000-00000000b002', 'Mine already');
insert into public.tasks (id, title, project_id, in_inbox, import_id, created_at, updated_at) values
  ('00000000-0000-0000-0000-00000000c001', 'Old one', '00000000-0000-0000-0000-00000000b001', false, '00000000-0000-0000-0000-00000000a001', '2020-01-01', '2021-01-01'),
  ('00000000-0000-0000-0000-00000000c002', 'Group', '00000000-0000-0000-0000-00000000b001', false, '00000000-0000-0000-0000-00000000a001', '2020-01-01', '2021-01-01');
insert into public.tasks (id, title, project_id, parent_id, in_inbox, import_id, created_at, updated_at) values
  ('00000000-0000-0000-0000-00000000c003', 'Step A', '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-00000000c002', false, '00000000-0000-0000-0000-00000000a001', '2020-01-01', '2021-01-01'),
  ('00000000-0000-0000-0000-00000000c004', 'Step B', '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-00000000c002', false, '00000000-0000-0000-0000-00000000a001', '2020-01-01', '2021-01-01');
insert into public.tasks (id, title, project_id, in_inbox, due_at, flagged) values ('00000000-0000-0000-0000-00000000c009', 'Not imported', '00000000-0000-0000-0000-00000000b002', false, '2020-01-01', true);
insert into public.tags (id, name, import_id) values ('00000000-0000-0000-0000-00000000d001', 'Unused', '00000000-0000-0000-0000-00000000a001');

-- Someday: the steps, and their group with them; rows outside the import are ignored.
insert into res select 'sd', public.settle_apply('00000000-0000-0000-0000-00000000a001', 'someday', '{"ids":["00000000-0000-0000-0000-00000000c003","00000000-0000-0000-0000-00000000c004","00000000-0000-0000-0000-00000000c009"]}');
insert into r (test, ok, detail) select 'someday: 2 steps + their group, not the outside row', (v->>'changed')::int = 3, v::text from res where k = 'sd';
insert into r (test, ok, detail) select 'Someday tag made, on hold', status = 'on_hold', status from public.tags where name = 'Someday';
insert into r (test, ok, detail) select 'links added', count(*) = 3, count(*)::text from public.task_tags tt join public.tags g on g.id = tt.tag_id where g.name = 'Someday';
insert into res select 'sdu', public.settle_undo((select (v->>'op_id')::uuid from res where k = 'sd'));
insert into r (test, ok, detail) select 'undo someday removes exactly those links', (select count(*) from public.task_tags) = 0 and (v->>'restored')::int = 3, v::text from res where k = 'sdu';
do $$ begin perform public.settle_undo((select (v->>'op_id')::uuid from res where k = 'sd')); insert into r (test, ok) values ('undo twice refused', false);
exception when others then insert into r (test, ok, detail) values ('undo twice refused', sqlerrm like 'Already undone%', sqlerrm); end $$;

-- Drop closes the steps too; undo reopens all and keeps the old age.
insert into res select 'dr', public.settle_apply('00000000-0000-0000-0000-00000000a001', 'drop', '{"ids":["00000000-0000-0000-0000-00000000c002"]}');
insert into r (test, ok, detail) select 'drop: the group and its steps are dropped', (select count(*) from public.tasks where dropped_at is not null) = 3, '';
insert into res select 'dru', public.settle_undo((select (v->>'op_id')::uuid from res where k = 'dr'));
insert into r (test, ok, detail) select 'undo drop: all open again, updated_at restored', (select count(*) from public.tasks where dropped_at is not null) = 0
  and (select bool_and(updated_at = '2021-01-01'::timestamptz) from public.tasks where import_id is not null), (select string_agg(updated_at::text, ',') from public.tasks where import_id is not null);
update public.tasks set title = 'Old one!' where id = '00000000-0000-0000-0000-00000000c001';
insert into r (test, ok, detail) select 'normal updates still touch updated_at (after undo)', updated_at > '2025-01-01', updated_at::text from public.tasks where id = '00000000-0000-0000-0000-00000000c001';

-- Plan, projects, reviews, tags
insert into res select 'pl', public.settle_apply('00000000-0000-0000-0000-00000000a001', 'plan', '{"ids":["00000000-0000-0000-0000-00000000c001","00000000-0000-0000-0000-00000000c009"],"at":"2026-10-01T14:00:00Z"}');
insert into r (test, ok, detail) select 'plan: only the imported row', (select planned_at from public.tasks where id = '00000000-0000-0000-0000-00000000c001') = '2026-10-01T14:00:00Z'
  and (select due_at from public.tasks where id = '00000000-0000-0000-0000-00000000c009') is not null, '';
insert into res select 'ps', public.settle_apply('00000000-0000-0000-0000-00000000a001', 'project_status', '{"ids":["00000000-0000-0000-0000-00000000b001","00000000-0000-0000-0000-00000000b002"],"status":"on_hold"}');
insert into r (test, ok, detail) select 'project status: imported only', (select status from public.projects where name = 'Imported') = 'on_hold' and (select status from public.projects where name = 'Mine already') = 'active', '';
insert into res select 'rv', public.settle_apply('00000000-0000-0000-0000-00000000a001', 'review_dates', '{"items":[{"id":"00000000-0000-0000-0000-00000000b001","at":"2026-10-05T14:00:00Z"}]}');
insert into r (test, ok, detail) select 'review dates set', next_review_at = '2026-10-05T14:00:00Z', next_review_at::text from public.projects where name = 'Imported';
insert into res select 'tg', public.settle_apply('00000000-0000-0000-0000-00000000a001', 'drop_tags', '{"ids":["00000000-0000-0000-0000-00000000d001"]}');
insert into r (test, ok, detail) select 'tag dropped', status = 'dropped', status from public.tags where name = 'Unused';
insert into res select 'psu', public.settle_undo((select (v->>'op_id')::uuid from res where k = 'ps'));
insert into r (test, ok, detail) select 'undo project status', status = 'active', status from public.projects where name = 'Imported';
do $$ begin perform public.settle_apply('00000000-0000-0000-0000-00000000a001', 'explode', '{}'); insert into r (test, ok) values ('unknown op refused', false);
exception when others then insert into r (test, ok, detail) values ('unknown op refused', sqlerrm like 'Unknown settle op%', sqlerrm); end $$;
insert into r (test, ok, detail) select 'ops recorded (6 applied; the refused one isn’t)', count(*) = 6, count(*)::text from public.settle_ops;
do $$ begin delete from public.settle_ops; insert into r (test, ok) values ('settle_ops cannot be deleted', (select count(*) from public.settle_ops) = 6);
exception when others then insert into r (test, ok, detail) values ('settle_ops cannot be deleted', true, sqlerrm); end $$;

-- Another user can't touch this import.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000f3","role":"authenticated"}', true);
do $$ begin perform public.settle_apply('00000000-0000-0000-0000-00000000a001', 'drop', '{"ids":["00000000-0000-0000-0000-00000000c001"]}'); insert into r (test, ok) values ('another user: import not found', false);
exception when others then insert into r (test, ok, detail) values ('another user: import not found', sqlerrm like 'Import not found%', sqlerrm); end $$;
insert into r (test, ok, detail) select 'another user sees no ops', count(*) = 0, count(*)::text from public.settle_ops;

reset role;
select n, test, ok, detail from r order by n;
rollback;
