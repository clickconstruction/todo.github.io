-- Full Review: qualify `decision` in review_decide's card update (it clashed with the column).
create or replace function public.review_decide(item uuid, decision text, by text default 'user', note text default null, owner uuid default null) returns jsonb
language plpgsql set search_path = '' as $$
declare
  uid uuid := coalesce((select auth.uid()), review_decide.owner);
  it public.review_items;
  ids uuid[];
  someday uuid;
  prev jsonb := '[]';
  op text;
  keep int;
  n int := 0;
  nxt uuid;
  now_ts timestamptz := now();
begin
  select * into it from public.review_items r where r.id = review_decide.item and r.user_id = uid;
  if it.id is null then raise exception 'Card not found.'; end if;
  if it.status <> 'pending' then raise exception 'That card was already decided (undo it first).'; end if;
  if it.kind = 'task' and decision not in ('keep', 'someday', 'done', 'drop', 'skip') then raise exception 'For an action: keep, someday, done, drop or skip.'; end if;
  if it.kind = 'group' and decision not in ('accept', 'keep_all', 'one_by_one', 'skip') then raise exception 'For a group: accept, keep_all, one_by_one or skip.'; end if;

  ids := case when it.kind = 'task' then array[it.task_id] else array(select (jsonb_array_elements_text(coalesce(it.grp->'task_ids', '[]')))::uuid) end;
  ids := array(select t.id from public.tasks t where t.id = any(ids) and t.user_id = uid and t.completed_at is null and t.dropped_at is null);

  op := case decision when 'someday' then 'someday' when 'done' then 'done' when 'drop' then 'drop'
               when 'accept' then coalesce(it.grp->'proposal'->>'op', 'someday') else null end;
  if op = 'keep_newest' then
    keep := greatest(0, coalesce((it.grp->'proposal'->>'keep')::int, 20));
    ids := array(select t.id from public.tasks t where t.id = any(ids)
                 order by greatest(t.updated_at, t.created_at) desc offset keep);
    op := 'someday';
  end if;

  if op = 'someday' then
    perform set_config('app.importing', 'on', true); -- bulk: no per-row history for tag links
    select g.id into someday from public.tags g where g.user_id = uid and g.parent_id is null and g.name ~* '^someday' limit 1;
    if someday is null then insert into public.tags (user_id, name, status) values (uid, 'Someday', 'on_hold') returning id into someday;
    else update public.tags set status = 'on_hold' where id = someday and status <> 'on_hold'; end if;
    -- a group whose open steps are all going (or already parked) goes too
    ids := ids || array(
      select g.id from public.tasks g
      where g.user_id = uid and g.completed_at is null and g.dropped_at is null and not (g.id = any(ids))
        and exists (select 1 from public.tasks c where c.parent_id = g.id and c.id = any(ids))
        and not exists (select 1 from public.tasks c where c.parent_id = g.id and c.completed_at is null and c.dropped_at is null
                        and not (c.id = any(ids)) and not exists (select 1 from public.task_tags x where x.task_id = c.id and x.tag_id = someday)));
    select coalesce(jsonb_agg(x), '[]') into prev from unnest(ids) x where not exists (select 1 from public.task_tags y where y.task_id = x and y.tag_id = someday);
    insert into public.task_tags (task_id, tag_id, user_id) select x, someday, uid from unnest(ids) x
      where not exists (select 1 from public.task_tags y where y.task_id = x and y.tag_id = someday);
    get diagnostics n = row_count;
    perform set_config('app.importing', 'off', true);
    prev := jsonb_build_array(jsonb_build_object('t', 'someday_tag', 'tag', someday, 'ids', prev));
  elsif op in ('done', 'drop') then
    select coalesce(jsonb_agg(jsonb_build_object('t', 'task', 'id', t.id, 'completed_at', t.completed_at, 'dropped_at', t.dropped_at, 'updated_at', t.updated_at)), '[]')
      into prev from public.tasks t
      where t.id = any(ids) or t.id in (
        with recursive d as (select c.id from public.tasks c where c.parent_id = any(ids) and c.user_id = uid
                             union select c.id from public.tasks c join d on c.parent_id = d.id)
        select id from d);
    update public.tasks t set completed_at = case when op = 'done' then now_ts else t.completed_at end,
                              dropped_at = case when op = 'drop' then now_ts else t.dropped_at end
      where t.id = any(ids);
    get diagnostics n = row_count;
  elsif op = 'park' then
    select coalesce(jsonb_agg(jsonb_build_object('t', 'project', 'id', p.id, 'status', p.status)), '[]') into prev
      from public.projects p where p.user_id = uid and p.status = 'active' and p.id in (select t.project_id from public.tasks t where t.id = any(ids));
    update public.projects p set status = 'on_hold' where p.user_id = uid and p.status = 'active' and p.id in (select t.project_id from public.tasks t where t.id = any(ids));
    get diagnostics n = row_count;
  end if;

  if decision = 'one_by_one' then
    insert into public.review_items (session_id, user_id, sort, kind, task_id, priority)
      select it.session_id, uid, it.sort + (o::double precision / (count(*) over () + 1)), 'task', x, false
      from unnest(ids) with ordinality u(x, o);
    get diagnostics n = row_count;
    prev := jsonb_build_array(jsonb_build_object('t', 'expanded'));
  end if;

  update public.review_items r set status = case when review_decide.decision = 'skip' then 'skipped' else 'reviewed' end,
    decision = review_decide.decision, decided_by = case when review_decide.by = 'agent' then 'agent' else 'user' end,
    note = coalesce(review_decide.note, r.note), before = prev, reviewed_at = now_ts
  where r.id = it.id;

  nxt := public.review_next(it.session_id, it.sort);
  update public.review_sessions s set current_item = nxt,
    status = case when nxt is null then 'done' else 'active' end, finished_at = case when nxt is null then now_ts else null end,
    agent_seen_at = case when review_decide.by = 'agent' then now_ts else s.agent_seen_at end,
    agent_status = case when review_decide.by = 'agent' then '' else s.agent_status end
  where s.id = it.session_id;
  return jsonb_build_object('changed', n, 'next', nxt);
end $$;
