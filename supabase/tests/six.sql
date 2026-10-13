-- Six (migration 20261112000001). One rolled-back transaction; every row should be ok = true.
begin;
insert into auth.users (id, instance_id, aud, role, email) values ('00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-000000000000','authenticated','authenticated','six1@test.invalid'),('00000000-0000-0000-0000-0000000000d2','00000000-0000-0000-0000-000000000000','authenticated','authenticated','six2@test.invalid');
create temp table r (n int generated always as identity, test text, ok boolean, detail text); grant all on r to authenticated;
-- Someone else's open card: never carried into mine.
insert into public.tasks (id, user_id, title) values ('00000000-0000-0000-0000-0000000d0009', '00000000-0000-0000-0000-0000000000d2', 'theirs');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000d1","role":"authenticated"}', true);
insert into public.tasks (id, title) values
  ('00000000-0000-0000-0000-0000000d0001', 'one'), ('00000000-0000-0000-0000-0000000d0002', 'two'), ('00000000-0000-0000-0000-0000000d0003', 'three'),
  ('00000000-0000-0000-0000-0000000d0004', 'four'), ('00000000-0000-0000-0000-0000000d0005', 'five'), ('00000000-0000-0000-0000-0000000d0006', 'six'),
  ('00000000-0000-0000-0000-0000000d0007', 'seven'), ('00000000-0000-0000-0000-0000000d0008', 'eight');
update public.tasks set completed_at = now() where id = '00000000-0000-0000-0000-0000000d0002';
-- Yesterday: one done, one dropped (nothing is deleted), one of theirs, four open.
update public.tasks set dropped_at = now() where id = '00000000-0000-0000-0000-0000000d0003';
insert into public.daily_reviews (day, focus) values ('2026-10-12',
  '["00000000-0000-0000-0000-0000000d0001","00000000-0000-0000-0000-0000000d0002","00000000-0000-0000-0000-0000000d0003","00000000-0000-0000-0000-0000000d0009","00000000-0000-0000-0000-0000000d0004","00000000-0000-0000-0000-0000000d0005"]');
insert into r (test, ok, detail) select 'six fit on a day', count(*) = 1, '' from public.daily_reviews where day = '2026-10-12';
do $$ begin update public.daily_reviews set focus = '["a","b","c","d","e","f","g"]' where day = '2026-10-12'; insert into r (test, ok, detail) values ('seven do not', false, '');
exception when check_violation then insert into r (test, ok, detail) values ('seven do not', true, sqlerrm); end $$;
-- Today already has two picked; carrying brings the three open leftovers to the top, in their old order.
insert into public.daily_reviews (day, focus) values ('2026-10-13', '["00000000-0000-0000-0000-0000000d0006","00000000-0000-0000-0000-0000000d0007"]');
select public.six_carry('2026-10-13');
insert into r (test, ok, detail) select 'carried: the open ones from yesterday first, mine only, then today''s picks',
  focus = '["00000000-0000-0000-0000-0000000d0001","00000000-0000-0000-0000-0000000d0004","00000000-0000-0000-0000-0000000d0005","00000000-0000-0000-0000-0000000d0006","00000000-0000-0000-0000-0000000d0007"]'
  and carried = '["00000000-0000-0000-0000-0000000d0001","00000000-0000-0000-0000-0000000d0004","00000000-0000-0000-0000-0000000d0005"]' and carried_at is not null, focus::text from public.daily_reviews where day = '2026-10-13';
select public.six_carry('2026-10-13');
insert into r (test, ok, detail) select 'carrying again changes nothing', jsonb_array_length(focus) = 5, focus::text from public.daily_reviews where day = '2026-10-13';
select public.six_uncarry('2026-10-13');
insert into r (test, ok, detail) select 'uncarry: today''s own picks stay, the day stays marked', focus = '["00000000-0000-0000-0000-0000000d0006","00000000-0000-0000-0000-0000000d0007"]' and carried = '[]' and carried_at is not null, focus::text from public.daily_reviews where day = '2026-10-13';
select public.six_carry('2026-10-13');
insert into r (test, ok, detail) select 'after an undo it is not carried again', jsonb_array_length(focus) = 2, focus::text from public.daily_reviews where day = '2026-10-13';
-- A full day: what doesn't fit stays off the list. (Yesterday for 10-14 is 10-13 with two open picks.)
insert into public.daily_reviews (day, focus) values ('2026-10-14', '["00000000-0000-0000-0000-0000000d0001","00000000-0000-0000-0000-0000000d0002","00000000-0000-0000-0000-0000000d0003","00000000-0000-0000-0000-0000000d0004","00000000-0000-0000-0000-0000000d0008"]');
select public.six_carry('2026-10-14');
insert into r (test, ok, detail) select 'six at most: one carried in, the rest left where it was', jsonb_array_length(focus) = 6 and focus->>0 = '00000000-0000-0000-0000-0000000d0006' and carried = '["00000000-0000-0000-0000-0000000d0006"]', focus::text from public.daily_reviews where day = '2026-10-14';
-- A day with no row yet: carry makes it.
select public.six_carry('2026-10-15');
insert into r (test, ok, detail) select 'carry makes the day''s row when there is none', count(*) = 1 and bool_and(carried_at is not null), '' from public.daily_reviews where day = '2026-10-15';
insert into public.user_settings (six_evening_minutes) values (1020);
insert into r (test, ok, detail) select 'evening setting saved', six_evening_minutes = 1020, '' from public.user_settings;
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000d2","role":"authenticated"}', true);
set local role authenticated;
do $$ begin perform public.six_uncarry('2026-10-13'); insert into r (test, ok, detail) values ('another user sees no list of mine', false, '');
exception when others then insert into r (test, ok, detail) values ('another user sees no list of mine', true, sqlerrm); end $$;
select test, ok, detail from r order by n;
rollback;
