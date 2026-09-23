-- Places rules (migration 20260924000001). Run in the SQL editor or via execute_sql;
-- everything happens in one transaction that is rolled back. Every row should be ok = true.
begin;
create temp table r (name text, ok boolean) on commit drop;
do $$
declare u1 uuid; u2 uuid; p1 uuid; p2 uuid; t uuid; ok boolean;
begin
  select id into u1 from auth.users order by created_at limit 1;
  u2 := gen_random_uuid();
  insert into auth.users (id, email, aud, role) values (u2, 'places-test@example.invalid', 'authenticated', 'authenticated');
  insert into public.places (user_id, name, lat, lng) values (u1, 'Home Depot', 29.76, -95.36) returning id into p1;
  insert into public.places (user_id, name, lat, lng) values (u2, 'Other', 1, 1) returning id into p2;
  insert into r values ('default radius 402', (select radius_m = 402 from public.places where id = p1));
  insert into public.tasks (user_id, title, place_id, location_trigger) values (u1, 'buy screws', p1, 'arrive') returning id into t;
  insert into r values ('task gets own place', (select place_id = p1 from public.tasks where id = t));
  begin update public.tasks set place_id = p2 where id = t; ok := false; exception when foreign_key_violation then ok := true; end;
  insert into r values ('cannot use another user''s place', ok);
  begin update public.tasks set location_trigger = 'teleport' where id = t; ok := false; exception when check_violation then ok := true; end;
  insert into r values ('trigger values checked', ok);
  begin update public.tasks set location_radius_m = 5 where id = t; ok := false; exception when check_violation then ok := true; end;
  insert into r values ('radius bounds checked', ok);
  begin insert into public.places (user_id, name, lat, lng) values (u1, 'bad', 91, 0); ok := false; exception when check_violation then ok := true; end;
  insert into r values ('lat bounds checked', ok);
  begin delete from public.places where id = p1; ok := false; exception when insufficient_privilege then ok := true; end;
  insert into r values ('places cannot be deleted', ok);
  insert into r values ('tags/projects have place columns', (select count(*) = 6 from information_schema.columns where table_schema='public' and table_name in ('tags','projects') and column_name in ('place_id','location_trigger','location_radius_m')));
  delete from auth.users where id = u2;
  insert into r values ('account deletion cascades places', not exists (select 1 from public.places where id = p2));
end $$;
select * from r;
rollback;
