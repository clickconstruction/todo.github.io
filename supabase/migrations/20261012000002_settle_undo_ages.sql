-- Settle in, Undo keeps ages: undoing a choice puts updated_at back too, so a restored action is still
-- "2 years old" (its age decides which bucket it's in). touch_updated_at() leaves updated_at alone while
-- app.keep_updated_at is on (transaction-local, set only by settle_undo).
create or replace function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  if coalesce(current_setting('app.keep_updated_at', true), '') <> 'on' then new.updated_at = now(); end if;
  return new;
end $$;

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

create or replace function public.settle_undo(op_id uuid, owner uuid default null) returns jsonb
language plpgsql set search_path = '' as $$
declare
  uid uuid := coalesce((select auth.uid()), settle_undo.owner);
  o public.settle_ops;
  e jsonb;
  n int := 0;
begin
  select * into o from public.settle_ops s where s.id = settle_undo.op_id and s.user_id = uid;
  if o.id is null then raise exception 'Nothing to undo.'; end if;
  if o.undone_at is not null then raise exception 'Already undone.'; end if;
  perform set_config('app.keep_updated_at', 'on', true); -- an undone row keeps its own age
  for e in select value from jsonb_array_elements(o.before) loop
    if e->>'t' = 'someday_tag' then
      delete from public.task_tags x where x.user_id = uid and x.tag_id = (e->>'tag')::uuid
        and x.task_id in (select (jsonb_array_elements_text(e->'ids'))::uuid);
      n := n + jsonb_array_length(e->'ids');
    elsif e->>'t' = 'task' then
      update public.tasks t set completed_at = (e->>'completed_at')::timestamptz, dropped_at = (e->>'dropped_at')::timestamptz,
        flagged = (e->>'flagged')::boolean, due_at = (e->>'due_at')::timestamptz, planned_at = (e->>'planned_at')::timestamptz,
        updated_at = coalesce((e->>'updated_at')::timestamptz, t.updated_at)
      where t.id = (e->>'id')::uuid and t.user_id = uid;
      n := n + 1;
    elsif e->>'t' = 'project' then
      update public.projects p set status = e->>'status' where p.id = (e->>'id')::uuid and p.user_id = uid; n := n + 1;
    elsif e->>'t' = 'review' then
      update public.projects p set next_review_at = (e->>'next_review_at')::timestamptz where p.id = (e->>'id')::uuid and p.user_id = uid; n := n + 1;
    elsif e->>'t' = 'tag' then
      update public.tags g set status = e->>'status' where g.id = (e->>'id')::uuid and g.user_id = uid; n := n + 1;
    end if;
  end loop;
  perform set_config('app.keep_updated_at', 'off', true);
  update public.settle_ops set undone_at = now() where id = o.id;
  return jsonb_build_object('restored', n);
end $$;

