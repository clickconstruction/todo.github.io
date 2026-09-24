-- Matrix (Eisenhower): a lens over your available actions, sorted by urgent (hard due soon, or a
-- follow-up that's late) and important (flagged, flagged project, a project serving an active goal).
--   * tasks.important: your override. null = decide from the signals, true = ★ important, false = not.
--   * user_settings.matrix_urgent_days: how soon a due date counts as urgent (default 7 days).
--   * matrix_park(ids): the Someday tag on many open actions at once → {parked: ids actually tagged}
--   * matrix_unpark(ids): Undo: the Someday tag comes off those again (the tag links only; nothing deleted)
alter table public.tasks add column important boolean;
alter table public.user_settings add column matrix_urgent_days int not null default 7 check (matrix_urgent_days between 1 and 60);

create or replace function public.matrix_park(ids uuid[], owner uuid default null) returns jsonb
language plpgsql set search_path = '' as $$
declare
  uid uuid := coalesce((select auth.uid()), matrix_park.owner);
  someday uuid;
  parked uuid[];
begin
  if uid is null then raise exception 'Not signed in.'; end if;
  select g.id into someday from public.tags g where g.user_id = uid and g.parent_id is null and g.name ~* '^someday' limit 1;
  if someday is null then insert into public.tags (user_id, name, status) values (uid, 'Someday', 'on_hold') returning id into someday;
  else update public.tags set status = 'on_hold' where id = someday and status <> 'on_hold'; end if;
  parked := array(select t.id from public.tasks t where t.id = any(ids) and t.user_id = uid and t.completed_at is null and t.dropped_at is null
                    and not exists (select 1 from public.task_tags y where y.task_id = t.id and y.tag_id = someday));
  insert into public.task_tags (task_id, tag_id, user_id) select x, someday, uid from unnest(parked) x;
  update public.tasks t set in_inbox = false, tickler = false where t.id = any(parked) and (t.in_inbox or t.tickler);
  return jsonb_build_object('parked', to_jsonb(parked), 'tag', someday);
end $$;

create or replace function public.matrix_unpark(ids uuid[], owner uuid default null) returns jsonb
language plpgsql set search_path = '' as $$
declare
  uid uuid := coalesce((select auth.uid()), matrix_unpark.owner);
  someday uuid;
  n int := 0;
begin
  if uid is null then raise exception 'Not signed in.'; end if;
  select g.id into someday from public.tags g where g.user_id = uid and g.parent_id is null and g.name ~* '^someday' limit 1;
  if someday is not null then
    delete from public.task_tags y using public.tasks t where y.task_id = t.id and t.user_id = uid and t.id = any(ids) and y.tag_id = someday;
    get diagnostics n = row_count;
  end if;
  return jsonb_build_object('unparked', n);
end $$;

revoke execute on function public.matrix_park(uuid[], uuid) from public, anon;
revoke execute on function public.matrix_unpark(uuid[], uuid) from public, anon;
grant execute on function public.matrix_park(uuid[], uuid) to authenticated, service_role;
grant execute on function public.matrix_unpark(uuid[], uuid) to authenticated, service_role;
