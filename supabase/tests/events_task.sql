-- Events → card link (migration 20261026000001). One rolled-back transaction; every row should be ok = true.
begin;
insert into auth.users (id, instance_id, aud, role, email) values ('00000000-0000-0000-0000-0000000000e3','00000000-0000-0000-0000-000000000000','authenticated','authenticated','ev3@test.invalid');
create temp table r (n int generated always as identity, test text, ok boolean, detail text); grant all on r to authenticated;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000e3","role":"authenticated"}', true);
insert into public.tasks (id, title) values ('00000000-0000-0000-0000-0000000e3001', 'Add Texas airshows to my calendar');
insert into public.events (title, all_day, starts_at, ends_at, task_id) values ('Wings Over Houston', true, '2026-10-31 05:00+00', '2026-11-02 06:00+00', '00000000-0000-0000-0000-0000000e3001');
insert into r (test, ok, detail) select 'an event links to its card', count(*) = 1, '' from public.events where task_id = '00000000-0000-0000-0000-0000000e3001';
do $$ begin insert into public.events (title, starts_at, ends_at, task_id) values ('Orphan', '2026-10-31 05:00+00', '2026-10-31 06:00+00', '00000000-0000-0000-0000-0000000e3999'); insert into r (test, ok, detail) values ('a card that does not exist is refused', false, '');
exception when foreign_key_violation then insert into r (test, ok, detail) values ('a card that does not exist is refused', true, sqlerrm); end $$;
update public.events set task_id = null where title = 'Wings Over Houston';
insert into r (test, ok, detail) select 'unlink works', count(*) = 1, '' from public.events where title = 'Wings Over Houston' and task_id is null;
update public.tasks set dropped_at = now() where id = '00000000-0000-0000-0000-0000000e3001';
insert into r (test, ok, detail) select 'dropping the card leaves the event', count(*) = 1, '' from public.events where title = 'Wings Over Houston';
select test, ok, detail from r order by n;
rollback;
