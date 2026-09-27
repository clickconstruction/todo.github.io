-- Horizons checkboxes (migration 20261102000001). One rolled-back transaction; every row ok = true.
begin;
insert into auth.users (id, instance_id, aud, role, email) values ('00000000-0000-0000-0000-0000000e0001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','hz1@test.invalid');
create temp table r (n int generated always as identity, test text, ok boolean, detail text); grant all on r to authenticated;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000e0001","role":"authenticated"}', true);
insert into public.user_settings (purpose, vision) values (E'PURPOSE\n[x] Live\n- [X] Love\n  [ ] Learn\nA line about [x] things, not a checkbox', E'[x] A workshop');
insert into r (test, ok, detail) select 'writing the text keeps its ticks', purpose like E'%[x] Live\n- [X] Love%' and vision = '[x] A workshop', purpose from public.user_settings;
update public.user_settings set vision = E'[x] A workshop\n[x] A band';
insert into r (test, ok, detail) select 'editing the text alone clears nothing', vision = E'[x] A workshop\n[x] A band' and purpose like '%[x] Live%', vision from public.user_settings;
update public.user_settings set purpose_read_at = now();
insert into r (test, ok, detail) select 'marking the purpose as read clears its ticks, in every form, and nothing else',
  purpose = E'PURPOSE\n[ ] Live\n- [ ] Love\n  [ ] Learn\nA line about [x] things, not a checkbox' and vision = E'[x] A workshop\n[x] A band', purpose from public.user_settings;
update public.user_settings set purpose = E'[x] Live', due_minutes = 600;
insert into r (test, ok, detail) select 'a tick made after the read stays (the read time didn''t change)', purpose = '[x] Live', purpose from public.user_settings;
update public.user_settings set vision_read_at = now(), vision = E'[x] A workshop\n[X] A band';
insert into r (test, ok, detail) select 'read and text in one write: the ticks still clear', vision = E'[ ] A workshop\n[ ] A band' and purpose = '[x] Live', vision from public.user_settings;
reset role;
insert into auth.users (id, instance_id, aud, role, email) values ('00000000-0000-0000-0000-0000000e0002','00000000-0000-0000-0000-000000000000','authenticated','authenticated','hz2@test.invalid');
insert into public.user_settings (user_id, purpose, purpose_read_at) values ('00000000-0000-0000-0000-0000000e0002', E'[x] First', now());
insert into r (test, ok, detail) select 'a first save that is also a read clears too', purpose = '[ ] First', purpose from public.user_settings where user_id = '00000000-0000-0000-0000-0000000e0002';
insert into r (test, ok, detail) select 'no text is no trouble', public.horizon_clear_ticks(null) = '' and public.horizon_clear_ticks('plain') = 'plain', '';
select test, ok, detail from r order by n;
rollback;
