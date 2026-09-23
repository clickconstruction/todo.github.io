-- Calendars (migration 20261003000001). One rolled-back transaction; every row should be ok = true.
begin;
insert into auth.users (id, instance_id, aud, role, email) values ('00000000-0000-0000-0000-0000000000c9','00000000-0000-0000-0000-000000000000','authenticated','authenticated','cal1@test.invalid'),('00000000-0000-0000-0000-0000000000ca','00000000-0000-0000-0000-000000000000','authenticated','authenticated','cal2@test.invalid');
create temp table r (n int generated always as identity, test text, ok boolean, detail text); grant all on r to authenticated;
insert into public.calendars (user_id, name, url) values ('00000000-0000-0000-0000-0000000000ca', 'Theirs', 'https://x/secret.ics');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c9","role":"authenticated"}', true);
insert into public.calendars (name, url) values ('Work', 'webcal://p01-caldav.icloud.com/published/2/abc');
insert into r (test, ok, detail) select 'owner adds a calendar (webcal ok)', count(*) = 1, '' from public.calendars;
insert into r (test, ok, detail) select 'can''t read another user''s link', count(*) = 0, '' from public.calendars where name = 'Theirs';
do $$ begin insert into public.calendars (name, url) values ('Bad', 'http://x/a.ics'); insert into r (test, ok, detail) values ('http links refused', false, '');
exception when check_violation then insert into r (test, ok, detail) values ('http links refused', true, sqlerrm); end $$;
do $$ begin insert into public.calendars (name, url, color) values ('Bad', 'https://x/a.ics', 'red'); insert into r (test, ok, detail) values ('colors are #rrggbb', false, '');
exception when check_violation then insert into r (test, ok, detail) values ('colors are #rrggbb', true, sqlerrm); end $$;
delete from public.calendars;
insert into r (test, ok, detail) select 'delete does nothing', count(*) = 1, '' from public.calendars;
select test, ok, detail from r order by n;
rollback;
