-- User settings (migration 20261002000001). One rolled-back transaction; every row should be ok = true.
begin;
insert into auth.users (id, instance_id, aud, role, email) values ('00000000-0000-0000-0000-0000000000b8','00000000-0000-0000-0000-000000000000','authenticated','authenticated','set@test.invalid');
create temp table r (n int generated always as identity, test text, ok boolean, detail text); grant all on r to authenticated;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b8","role":"authenticated"}', true);
insert into public.user_settings (due_minutes, planned_minutes, defer_minutes, timezone) values (930, 480, 360, 'America/New_York');
insert into r (test, ok, detail) select 'settings saved for the owner', count(*) = 1, '' from public.user_settings;
do $$ begin update public.user_settings set due_minutes = 2000; insert into r (test, ok, detail) values ('times must be within a day', false, '');
exception when check_violation then insert into r (test, ok, detail) values ('times must be within a day', true, sqlerrm); end $$;
insert into public.project_templates (id, name, body) values ('00000000-0000-0000-0000-00000000b8a1', 'T', '{"name":"P","project_due":1,"actions":[{"title":"A","due":0,"planned":0,"defer":0}]}');
select public.create_from_template('00000000-0000-0000-0000-00000000b8a1', '2026-10-05', '{}', null, null);
insert into r (test, ok, detail) select 'templates use the account''s times and zone (no zone passed)', due_at = '2026-10-05 15:30 America/New_York'::timestamptz and planned_at = '2026-10-05 08:00 America/New_York'::timestamptz and defer_at = '2026-10-05 06:00 America/New_York'::timestamptz, due_at::text from public.tasks where title = 'A';
insert into r (test, ok, detail) select 'project due too', due_at = '2026-10-06 15:30 America/New_York'::timestamptz, due_at::text from public.projects where name = 'P';
select test, ok, detail from r order by n;
rollback;
