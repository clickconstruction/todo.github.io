-- Event distances (migration 20261027000001). One rolled-back transaction; every row should be ok = true.
begin;
insert into auth.users (id, instance_id, aud, role, email) values ('00000000-0000-0000-0000-0000000000e4','00000000-0000-0000-0000-000000000000','authenticated','authenticated','ev4@test.invalid');
create temp table r (n int generated always as identity, test text, ok boolean, detail text); grant all on r to authenticated;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000e4","role":"authenticated"}', true);
insert into public.events (title, all_day, starts_at, ends_at, location, lat, lng) values ('Wings Over Houston', true, '2026-10-31 05:00+00', '2026-11-02 06:00+00', 'Ellington Airport, Houston, TX', 29.6073, -95.1588);
insert into r (test, ok, detail) select 'an event keeps its coordinates', count(*) = 1, '' from public.events where lat = 29.6073 and lng = -95.1588;
do $$ begin insert into public.events (title, starts_at, ends_at, lat) values ('Half', '2026-10-31 05:00+00', '2026-10-31 06:00+00', 29.6); insert into r (test, ok, detail) values ('lat without lng is refused', false, '');
exception when check_violation then insert into r (test, ok, detail) values ('lat without lng is refused', true, sqlerrm); end $$;
do $$ begin insert into public.events (title, starts_at, ends_at, lat, lng) values ('Off the map', '2026-10-31 05:00+00', '2026-10-31 06:00+00', 95, 10); insert into r (test, ok, detail) values ('out-of-range coordinates are refused', false, '');
exception when check_violation then insert into r (test, ok, detail) values ('out-of-range coordinates are refused', true, sqlerrm); end $$;
update public.events set drive_minutes = 35, drive_from = '29.76,-95.37' where title = 'Wings Over Houston';
insert into r (test, ok, detail) select 'the drive time is cached with where it was measured from', count(*) = 1, '' from public.events where drive_minutes = 35 and drive_from = '29.76,-95.37';
insert into public.places (id, name, lat, lng) values ('00000000-0000-0000-0000-0000000e4001', 'Home', 29.76, -95.37);
insert into public.user_settings (distance_place_id) values ('00000000-0000-0000-0000-0000000e4001');
insert into r (test, ok, detail) select 'Settings: distances measured from a place', count(*) = 1, '' from public.user_settings where distance_place_id = '00000000-0000-0000-0000-0000000e4001';
select test, ok, detail from r order by n;
rollback;
