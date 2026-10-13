-- Six: the Ivy Lee list. A day's ranked list is daily_reviews.focus (now up to six, in order). What is
-- left of the day before comes over to the top of today once (six_carry), and that can be taken back
-- (six_uncarry). user_settings.six_evening_minutes: from this time of day the view opens on tomorrow.
alter table public.daily_reviews drop constraint daily_reviews_focus_check;
alter table public.daily_reviews add constraint daily_reviews_focus_check check (jsonb_typeof(focus) = 'array' and jsonb_array_length(focus) <= 6);
alter table public.daily_reviews
  add column carried jsonb not null default '[]' check (jsonb_typeof(carried) = 'array'),
  add column carried_at timestamptz;
alter table public.user_settings add column six_evening_minutes int not null default 960 check (six_evening_minutes between 0 and 1439);

-- Carry what is left of the latest earlier day to the top of p_day's list, once. Open cards only, no
-- repeats, six at most (what doesn't fit stays where it was). Returns the day's row.
create or replace function public.six_carry(p_day date, owner uuid default null) returns public.daily_reviews
language plpgsql set search_path = '' as $$
declare
  uid uuid := coalesce((select auth.uid()), six_carry.owner);
  cur public.daily_reviews;
  prev public.daily_reviews;
  left_over jsonb := '[]';
  free int;
begin
  if uid is null then raise exception 'Not signed in.'; end if;
  select * into cur from public.daily_reviews d where d.user_id = uid and d.day = p_day;
  if cur.id is null then
    insert into public.daily_reviews (user_id, day) values (uid, p_day) returning * into cur;
  end if;
  if cur.carried_at is not null then return cur; end if;
  select * into prev from public.daily_reviews d where d.user_id = uid and d.day < p_day order by d.day desc limit 1;
  if prev.id is not null then
    select coalesce(jsonb_agg(to_jsonb(x.id::text) order by x.ord), '[]') into left_over
    from (select e.value #>> '{}' as id, e.ordinality as ord from jsonb_array_elements(prev.focus) with ordinality e) x
    join public.tasks t on t.id::text = x.id and t.user_id = uid
    where t.completed_at is null and t.dropped_at is null and not (cur.focus ? x.id);
  end if;
  -- Only the free places: today's own picks stay; what doesn't fit stays where it was.
  free := greatest(0, 6 - jsonb_array_length(cur.focus));
  select coalesce(jsonb_agg(v order by o), '[]') into left_over
  from (select value as v, ordinality as o from jsonb_array_elements(left_over) with ordinality) z where o <= free;
  update public.daily_reviews d set focus = left_over || d.focus, carried = left_over, carried_at = now() where d.id = cur.id returning * into cur;
  return cur;
end $$;
revoke execute on function public.six_carry(date, uuid) from public, anon;
grant execute on function public.six_carry(date, uuid) to authenticated, service_role;

-- Take the carried cards off p_day's list again. The day stays marked as carried, so it isn't redone.
create or replace function public.six_uncarry(p_day date, owner uuid default null) returns public.daily_reviews
language plpgsql set search_path = '' as $$
declare
  uid uuid := coalesce((select auth.uid()), six_uncarry.owner);
  cur public.daily_reviews;
  kept jsonb;
begin
  if uid is null then raise exception 'Not signed in.'; end if;
  select * into cur from public.daily_reviews d where d.user_id = uid and d.day = p_day;
  if cur.id is null then raise exception 'No list for that day.'; end if;
  select coalesce(jsonb_agg(v order by o), '[]') into kept
  from (select value as v, ordinality as o from jsonb_array_elements(cur.focus) with ordinality) z where not (cur.carried @> jsonb_build_array(v));
  update public.daily_reviews d set focus = kept, carried = '[]' where d.id = cur.id returning * into cur;
  return cur;
end $$;
revoke execute on function public.six_uncarry(date, uuid) from public, anon;
grant execute on function public.six_uncarry(date, uuid) to authenticated, service_role;
