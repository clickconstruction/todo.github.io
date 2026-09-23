-- Project templates (migration 20261001000001). One rolled-back transaction; every row should be ok = true.
begin;
insert into auth.users (id, instance_id, aud, role, email) values ('00000000-0000-0000-0000-0000000000a7','00000000-0000-0000-0000-000000000000','authenticated','authenticated','tpl@test.invalid');
create temp table r (n int generated always as identity, test text, ok boolean, detail text); grant all on r to authenticated;
create temp table ids (k text, v uuid); grant all on ids to authenticated;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a7","role":"authenticated"}', true);
insert into public.tags (id, name) values ('00000000-0000-0000-0000-00000000a701', 'Phone');
insert into public.folders (id, name) values ('00000000-0000-0000-0000-00000000a7f1', 'Jobs');
insert into public.project_templates (id, name, folder_id, body) values ('00000000-0000-0000-0000-00000000a7a1', 'New job setup', '00000000-0000-0000-0000-00000000a7f1',
 '{"name":"«Client» remodel","notes":"For «Client», started «Date»","kind":"sequential","review_every":2,"review_unit":"week","tag_ids":["00000000-0000-0000-0000-00000000a701"],"project_due":30,
   "blanks":[{"name":"Client","default":"Someone"}],
   "actions":[{"title":"Site visit: «Client»","due":0,"estimate_minutes":60},
              {"title":"Send estimate","due":2,"tag_ids":["00000000-0000-0000-0000-00000000a701","00000000-0000-0000-0000-00000000dead"],"flagged":true},
              {"title":"Permits","steps_in_order":true,"steps":[{"title":"Apply","defer":3},{"title":"Pick up \"stamped\" set","planned":7}]},
              {"title":"  "}]}');
insert into ids select 'p', public.create_from_template('00000000-0000-0000-0000-00000000a7a1', '2026-10-05', '{"Client":"Smith \"Jr\""}', null, null, 'America/Chicago');
insert into r (test, ok, detail) select 'blanks filled in (quotes safe), built-ins too', name = 'Smith "Jr" remodel' and notes = 'For Smith "Jr", started Oct 5' and kind = 'sequential' and review_every = 2
   and folder_id = '00000000-0000-0000-0000-00000000a7f1' and template_id = '00000000-0000-0000-0000-00000000a7a1', name || ' / ' || notes from public.projects where id = (select v from ids where k = 'p');
insert into r (test, ok, detail) select 'project due = anchor + 30 days at 5pm local', due_at = '2026-11-04 17:00 America/Chicago'::timestamptz, due_at::text from public.projects where id = (select v from ids where k = 'p');
insert into r (test, ok, detail) select 'project tags', count(*) = 1, '' from public.project_tags where project_id = (select v from ids where k = 'p');
insert into r (test, ok, detail) select 'actions in order, empty ones skipped', string_agg(title, '|' order by sort) = 'Site visit: Smith "Jr"|Send estimate|Permits', string_agg(title, '|' order by sort)
  from public.tasks where project_id = (select v from ids where k = 'p') and parent_id is null;
insert into r (test, ok, detail) select 'dates shifted in the user''s zone', (select due_at from public.tasks where title = 'Send estimate') = '2026-10-07 17:00 America/Chicago'::timestamptz
   and (select defer_at from public.tasks where title = 'Apply') = '2026-10-08 00:00 America/Chicago'::timestamptz
   and (select planned_at from public.tasks where title = 'Pick up "stamped" set') = '2026-10-12 09:00 America/Chicago'::timestamptz, '';
insert into r (test, ok, detail) select 'steps nested, in order kept, estimate + flag', (select steps_in_order from public.tasks where title = 'Permits')
   and (select count(*) from public.tasks c join public.tasks p on p.id = c.parent_id where p.title = 'Permits') = 2
   and (select estimate_minutes from public.tasks where title like 'Site visit%') = 60 and (select flagged from public.tasks where title = 'Send estimate'), '';
insert into r (test, ok, detail) select 'only real tags attached', count(*) = 1, '' from public.task_tags tt join public.tasks t on t.id = tt.task_id where t.title = 'Send estimate';
insert into ids select 'p2', public.create_from_template('00000000-0000-0000-0000-00000000a7a1', '2026-10-05', '{}', 'Custom name', null, 'America/Chicago');
insert into r (test, ok, detail) select 'defaults and a custom name', name = 'Custom name' and (select count(*) from public.tasks where title = 'Site visit: Someone') = 1, name from public.projects where id = (select v from ids where k = 'p2');
update public.project_templates set schedule = '{"every":1,"unit":"month","start":"2026-01-01","tz":"America/Chicago"}' where id = '00000000-0000-0000-0000-00000000a7a1';
insert into r (test, ok, detail) select 'schedule: next run is the next 6am local, never in the past', next_run_at > now() and extract(hour from next_run_at at time zone 'America/Chicago') = 6
   and extract(day from next_run_at at time zone 'America/Chicago') = 1, next_run_at::text from public.project_templates where id = '00000000-0000-0000-0000-00000000a7a1';
do $$ begin perform public.run_template_schedules(); insert into r (test, ok, detail) values ('cron function is not for users', false, '');
exception when others then insert into r (test, ok, detail) values ('cron function is not for users', true, sqlerrm); end $$;
update public.project_templates set archived_at = now() where id = '00000000-0000-0000-0000-00000000a7a1';
insert into r (test, ok, detail) select 'archiving stops the schedule', next_run_at is null, '' from public.project_templates where id = '00000000-0000-0000-0000-00000000a7a1';
do $$ begin perform public.create_from_template('00000000-0000-0000-0000-00000000a7a1', null, '{}', null, null, 'UTC'); insert into r (test, ok, detail) values ('archived template can''t be used', false, '');
exception when others then insert into r (test, ok, detail) values ('archived template can''t be used', true, sqlerrm); end $$;
delete from public.project_templates;
insert into r (test, ok, detail) select 'delete does nothing', count(*) = 1, '' from public.project_templates;
-- The cron, as the Worker runs it.
reset role;
update public.project_templates set archived_at = null, schedule = '{"every":1,"unit":"week","start":"2026-01-01","tz":"America/Chicago"}' where id = '00000000-0000-0000-0000-00000000a7a1';
update public.project_templates set next_run_at = now() - interval '1 minute' where id = '00000000-0000-0000-0000-00000000a7a1';
select set_config('request.jwt.claims', '', true);
insert into r (test, ok, detail) select 'cron creates due projects', public.run_template_schedules() = 1, '';
insert into r (test, ok, detail) select 'cron: made with defaults, next run moved on', (select count(*) from public.projects where name = 'Someone remodel') = 1
   and (select next_run_at > now() from public.project_templates where id = '00000000-0000-0000-0000-00000000a7a1'), '';
select test, ok, detail from r order by n;
rollback;
