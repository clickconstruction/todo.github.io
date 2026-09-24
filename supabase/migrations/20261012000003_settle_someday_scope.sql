-- Settle in: the Someday sweep turns app.importing off again when it's done, so later calls in the same
-- transaction (tests, or an agent batching calls) keep the group rules (closing a group closes its steps).
create or replace function public.settle_apply(batch uuid, op text, args jsonb, owner uuid default null) returns jsonb
language plpgsql set search_path = '' as $$
declare
  uid uuid := coalesce((select auth.uid()), settle_apply.owner);
  ids uuid[];
  someday uuid;
  prev jsonb := '[]';
  n int := 0;
  op_id uuid;
  st text;
  now_ts timestamptz := now();
begin
  if not exists (select 1 from public.imports i where i.id = batch and i.user_id = uid and i.undone_at is null) then
    raise exception 'Import not found.';
  end if;
  ids := array(select (jsonb_array_elements_text(coalesce(args->'ids', '[]')))::uuid);

  if op in ('someday', 'complete', 'drop', 'unflag', 'clear_due', 'plan') then
    -- only open items of this import
    ids := array(select t.id from public.tasks t where t.id = any(ids) and t.user_id = uid and t.import_id = batch and t.completed_at is null and t.dropped_at is null);
    if op = 'someday' then
      perform set_config('app.importing', 'on', true); -- bulk: no per-row history for tag links
      select t.id into someday from public.tags t where t.user_id = uid and t.parent_id is null and t.name ~* '^someday' limit 1;
      if someday is null then insert into public.tags (user_id, name, status) values (uid, 'Someday', 'on_hold') returning id into someday;
      else update public.tags set status = 'on_hold' where id = someday and status <> 'on_hold'; end if;
      -- groups whose open steps are all going (or already parked) go too
      ids := ids || array(
        select g.id from public.tasks g
        where g.user_id = uid and g.import_id = batch and g.completed_at is null and g.dropped_at is null and not (g.id = any(ids))
          and exists (select 1 from public.tasks c where c.parent_id = g.id and c.completed_at is null and c.dropped_at is null)
          and not exists (select 1 from public.tasks c where c.parent_id = g.id and c.completed_at is null and c.dropped_at is null
                          and not (c.id = any(ids)) and not exists (select 1 from public.task_tags x where x.task_id = c.id and x.tag_id = someday)));
      select coalesce(jsonb_agg(jsonb_build_object('t', 'someday', 'id', x)), '[]') into prev
        from unnest(ids) x where not exists (select 1 from public.task_tags y where y.task_id = x and y.tag_id = someday);
      insert into public.task_tags (task_id, tag_id, user_id) select x, someday, uid from unnest(ids) x
        where not exists (select 1 from public.task_tags y where y.task_id = x and y.tag_id = someday);
      get diagnostics n = row_count;
      perform set_config('app.importing', 'off', true); -- only for these links, not the rest of the transaction
      prev := jsonb_build_array(jsonb_build_object('t', 'someday_tag', 'tag', someday, 'ids', (select coalesce(jsonb_agg(e->'id'), '[]') from jsonb_array_elements(prev) e)));
    else
      -- completing or dropping closes open steps too: remember them for Undo
      select coalesce(jsonb_agg(jsonb_build_object('t', 'task', 'id', t.id, 'completed_at', t.completed_at, 'dropped_at', t.dropped_at, 'flagged', t.flagged, 'due_at', t.due_at, 'planned_at', t.planned_at, 'updated_at', t.updated_at)), '[]')
        into prev from public.tasks t
        where t.id = any(ids) or (op in ('complete', 'drop') and t.id in (
          with recursive d as (select c.id from public.tasks c where c.parent_id = any(ids) and c.user_id = uid
                               union select c.id from public.tasks c join d on c.parent_id = d.id)
          select id from d));
      update public.tasks t set
        completed_at = case when op = 'complete' then now_ts else t.completed_at end,
        dropped_at = case when op = 'drop' then now_ts else t.dropped_at end,
        flagged = case when op = 'unflag' then false else t.flagged end,
        due_at = case when op in ('clear_due', 'plan') then null else t.due_at end,
        planned_at = case when op = 'plan' then (args->>'at')::timestamptz else t.planned_at end
      where t.id = any(ids);
      get diagnostics n = row_count;
    end if;
  elsif op = 'project_status' then
    st := args->>'status';
    if st not in ('active', 'on_hold', 'completed', 'dropped') then raise exception 'Unknown status.'; end if;
    select coalesce(jsonb_agg(jsonb_build_object('t', 'project', 'id', p.id, 'status', p.status)), '[]') into prev
      from public.projects p where p.id = any(ids) and p.user_id = uid and p.import_id = batch and p.status <> st;
    update public.projects p set status = st where p.id = any(ids) and p.user_id = uid and p.import_id = batch and p.status <> st;
    get diagnostics n = row_count;
  elsif op = 'review_dates' then
    select coalesce(jsonb_agg(jsonb_build_object('t', 'review', 'id', p.id, 'next_review_at', p.next_review_at)), '[]') into prev
      from public.projects p join jsonb_array_elements(args->'items') e on (e->>'id')::uuid = p.id where p.user_id = uid and p.import_id = batch;
    update public.projects p set next_review_at = (e->>'at')::timestamptz
      from jsonb_array_elements(args->'items') e where (e->>'id')::uuid = p.id and p.user_id = uid and p.import_id = batch;
    get diagnostics n = row_count;
  elsif op = 'drop_tags' then
    select coalesce(jsonb_agg(jsonb_build_object('t', 'tag', 'id', g.id, 'status', g.status)), '[]') into prev
      from public.tags g where g.id = any(ids) and g.user_id = uid and g.import_id = batch and g.status <> 'dropped';
    update public.tags g set status = 'dropped' where g.id = any(ids) and g.user_id = uid and g.import_id = batch and g.status <> 'dropped';
    get diagnostics n = row_count;
  else
    raise exception 'Unknown settle op.';
  end if;

  insert into public.settle_ops (user_id, import_id, op, changed, before) values (uid, batch, op, n, prev) returning id into op_id;
  return jsonb_build_object('op_id', op_id, 'changed', n);
end $$;
