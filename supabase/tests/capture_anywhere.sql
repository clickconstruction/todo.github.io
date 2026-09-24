-- Capture from anywhere and BCC → Waiting For (migration 20261008000001).
-- One rolled-back transaction; every row should be ok = true.
begin;
insert into auth.users (id, instance_id, aud, role, email) values ('00000000-0000-0000-0000-0000000000c7','00000000-0000-0000-0000-000000000000','authenticated','authenticated','cap1@test.invalid');
create temp table r (n int generated always as identity, test text, ok boolean, detail text); grant all on r to authenticated;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c7","role":"authenticated"}', true);
insert into public.api_tokens (name, token_hash, token_hint, scope) values ('iPhone (capture)', repeat('a', 64), 'abcd', 'capture');
insert into r (test, ok, detail) select 'owner makes a capture key', count(*) = 1, '' from public.api_tokens where scope = 'capture';
do $$ begin insert into public.api_tokens (name, token_hash, token_hint, scope) values ('x', repeat('b', 64), 'x', 'admin'); insert into r (test, ok, detail) values ('only full, geo or capture scopes', false, '');
exception when check_violation then insert into r (test, ok, detail) values ('only full, geo or capture scopes', true, sqlerrm); end $$;
insert into public.user_settings (waiting_followup_days) values (3);
insert into r (test, ok, detail) select 'waiting follow-up days saved', waiting_followup_days = 3, '' from public.user_settings;
do $$ begin update public.user_settings set waiting_followup_days = 0; insert into r (test, ok, detail) values ('follow-up days 1-60', false, '');
exception when check_violation then insert into r (test, ok, detail) values ('follow-up days 1-60', true, sqlerrm); end $$;
insert into public.people (name, email, added_via) values ('Jodi Park', 'jodi@parkhomes.com', 'email');
insert into r (test, ok, detail) select 'people remember they came from email', added_via = 'email', '' from public.people;
insert into public.people (name) values ('Hiro');
insert into r (test, ok, detail) select 'default is app', added_via = 'app', '' from public.people where name = 'Hiro';
select test, ok, detail from r order by n;
rollback;
