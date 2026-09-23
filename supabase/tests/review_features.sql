-- Review features: review schedule, action groups, complete-with-last-action, project tags.
begin;
insert into auth.users (id, instance_id, aud, role, email) values ('00000000-0000-0000-0000-0000000000ad','00000000-0000-0000-0000-000000000000','authenticated','authenticated','t4@test.invalid');
create temp table r (n int generated always as identity, test text, ok boolean, detail text); grant all on r to authenticated;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000ad","role":"authenticated"}', true);

-- review schedule
insert into public.projects (id, name, review_every_days) values ('00000000-0000-0000-0000-0000000000a1', 'P', 7);
insert into r (test, ok, detail) select 'next_review = created + 7d', abs(extract(epoch from next_review_at - (created_at + interval '7 days'))) < 1, next_review_at::text from public.projects where id = '00000000-0000-0000-0000-0000000000a1';
update public.projects set last_reviewed_at = now() - interval '1 day', review_every_days = 14 where id = '00000000-0000-0000-0000-0000000000a1';
insert into r (test, ok, detail) select 'mark reviewed + 14d interval', abs(extract(epoch from next_review_at - (now() + interval '13 days'))) < 5, next_review_at::text from public.projects where id = '00000000-0000-0000-0000-0000000000a1';

-- action group
insert into public.tasks (id, title, project_id) values ('00000000-0000-0000-0000-00000000aa01', 'Group', '00000000-0000-0000-0000-0000000000a1');
insert into public.tasks (id, title, project_id, parent_id) values
  ('00000000-0000-0000-0000-00000000aa02', 'Child 1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000aa01'),
  ('00000000-0000-0000-0000-00000000aa03', 'Child 2', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000aa01');
update public.tasks set completed_at = now() where id = '00000000-0000-0000-0000-00000000aa02';
insert into r (test, ok, detail) select 'group stays open with one child left', completed_at is null, coalesce(completed_at::text,'open') from public.tasks where id = '00000000-0000-0000-0000-00000000aa01';
update public.tasks set completed_at = now() where id = '00000000-0000-0000-0000-00000000aa03';
insert into r (test, ok, detail) select 'group completes with last child', completed_at is not null, coalesce(completed_at::text,'open') from public.tasks where id = '00000000-0000-0000-0000-00000000aa01';
update public.tasks set completed_at = null where id = '00000000-0000-0000-0000-00000000aa03';
insert into r (test, ok, detail) select 'reopening a child reopens group', completed_at is null, coalesce(completed_at::text,'open') from public.tasks where id = '00000000-0000-0000-0000-00000000aa01';
update public.tasks set dropped_at = now() where id = '00000000-0000-0000-0000-00000000aa01';
insert into r (test, ok, detail) select 'dropping group drops open children', dropped_at is not null and completed_at is null, 'child2 dropped=' || (dropped_at is not null) from public.tasks where id = '00000000-0000-0000-0000-00000000aa03';
insert into r (test, ok, detail) select 'completed child untouched by group drop', completed_at is not null and dropped_at is null, '' from public.tasks where id = '00000000-0000-0000-0000-00000000aa02';

-- complete with last action
insert into public.projects (id, name, complete_with_last) values ('00000000-0000-0000-0000-0000000000a2', 'Auto', true);
insert into public.tasks (id, title, project_id) values ('00000000-0000-0000-0000-00000000bb01', 'A', '00000000-0000-0000-0000-0000000000a2'), ('00000000-0000-0000-0000-00000000bb02', 'B', '00000000-0000-0000-0000-0000000000a2');
update public.tasks set completed_at = now() where id = '00000000-0000-0000-0000-00000000bb01';
insert into r (test, ok, detail) select 'project open with an action left', status = 'active', status from public.projects where id = '00000000-0000-0000-0000-0000000000a2';
update public.tasks set completed_at = now() where id = '00000000-0000-0000-0000-00000000bb02';
insert into r (test, ok, detail) select 'project completes with last action', status = 'completed' and completed_at is not null, status from public.projects where id = '00000000-0000-0000-0000-0000000000a2';
insert into r (test, ok, detail) select 'without the setting, project stays active', status = 'active', status from public.projects where id = '00000000-0000-0000-0000-0000000000a1';
update public.projects set status = 'active' where id = '00000000-0000-0000-0000-0000000000a2';
insert into r (test, ok, detail) select 'reopened project clears completed_at', completed_at is null, '' from public.projects where id = '00000000-0000-0000-0000-0000000000a2';

-- child → group → project cascade
insert into public.projects (id, name, complete_with_last) values ('00000000-0000-0000-0000-0000000000a3', 'Auto2', true);
insert into public.tasks (id, title, project_id) values ('00000000-0000-0000-0000-00000000cc01', 'G', '00000000-0000-0000-0000-0000000000a3');
insert into public.tasks (id, title, project_id, parent_id) values ('00000000-0000-0000-0000-00000000cc02', 'c', '00000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-00000000cc01');
update public.tasks set completed_at = now() where id = '00000000-0000-0000-0000-00000000cc02';
insert into r (test, ok, detail) select 'child → group → project cascade', status = 'completed', status from public.projects where id = '00000000-0000-0000-0000-0000000000a3';

-- project tags
insert into public.tags (id, name) values ('00000000-0000-0000-0000-00000000dd01', 'Laptop');
insert into public.project_tags (project_id, tag_id) values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000dd01');
insert into r (test, ok, detail) select 'project tag insert + read', count(*) = 1, count(*)::text from public.project_tags;

-- review cadence in natural units (20260925000001_inspector_parity)
insert into public.projects (id, name, review_every_days) values ('00000000-0000-0000-0000-0000000000a4', 'Fortnight', 14);
insert into r (test, ok, detail) select 'insert with 14 days -> every 2 weeks', review_every = 2 and review_unit = 'week' and review_every_days = 14, review_every || ' ' || review_unit from public.projects where id = '00000000-0000-0000-0000-0000000000a4';
update public.projects set review_every = 1, review_unit = 'month', last_reviewed_at = '2026-01-31T12:00:00Z' where id = '00000000-0000-0000-0000-0000000000a4';
insert into r (test, ok, detail) select 'monthly uses calendar months (Jan 31 -> Feb 28)', next_review_at = '2026-02-28T12:00:00Z' and review_every_days = 30, next_review_at::text from public.projects where id = '00000000-0000-0000-0000-0000000000a4';
update public.projects set next_review_at = '2026-06-01T00:00:00Z' where id = '00000000-0000-0000-0000-0000000000a4';
insert into r (test, ok, detail) select 'next review date can be set directly', next_review_at = '2026-06-01T00:00:00Z', next_review_at::text from public.projects where id = '00000000-0000-0000-0000-0000000000a4';
update public.projects set notes = 'touch' where id = '00000000-0000-0000-0000-0000000000a4';
insert into r (test, ok, detail) select 'unrelated edits keep the chosen review date', next_review_at = '2026-06-01T00:00:00Z', next_review_at::text from public.projects where id = '00000000-0000-0000-0000-0000000000a4';
update public.projects set review_every_days = 365 where id = '00000000-0000-0000-0000-0000000000a4';
insert into r (test, ok, detail) select 'old clients sending days still work (365 -> 1 year)', review_every = 1 and review_unit = 'year', review_every || ' ' || review_unit from public.projects where id = '00000000-0000-0000-0000-0000000000a4';
update public.projects set status = 'completed', completed_at = '2026-03-01T15:00:00Z', due_at = '2026-03-05T22:00:00Z', estimate_minutes = 90 where id = '00000000-0000-0000-0000-0000000000a4';
insert into r (test, ok, detail) select 'backdated completion kept; project due + duration stored', completed_at = '2026-03-01T15:00:00Z' and due_at is not null and estimate_minutes = 90, completed_at::text from public.projects where id = '00000000-0000-0000-0000-0000000000a4';

select test, ok, detail from r order by n;
rollback;
