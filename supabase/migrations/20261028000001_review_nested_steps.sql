-- Full Review: a suggestion's steps can nest. Each step is a title or {title, steps: [...], in_order?},
-- up to three levels under the card (the tree's four-level rule still holds, checked by the tasks
-- trigger). Submit (review_apply) adds the whole tree under the action; Undo drops every step added.
-- review_apply is the folders version (20261021000001) with the steps block replaced.

create or replace function public.review_add_steps(uid uuid, parent uuid, proj uuid, steps jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare
  e jsonb;
  n int := 0;
  base numeric;
  title text;
  nid uuid;
  ids jsonb := '[]';
begin
  if jsonb_typeof(steps) <> 'array' then return ids; end if;
  select coalesce(max(c.sort), -1) + 1 into base from public.tasks c where c.parent_id = parent;
  for e in select value from jsonb_array_elements(steps) loop
    title := left(trim(case when jsonb_typeof(e) = 'object' then coalesce(e->>'title', '') else coalesce(e #>> '{}', '') end), 500);
    if title = '' then continue; end if;
    insert into public.tasks (user_id, title, parent_id, project_id, in_inbox, sort, steps_in_order)
      values (uid, title, parent, proj, false, base + n, jsonb_typeof(e) = 'object' and coalesce((e->>'in_order')::boolean, false))
      returning id into nid;
    n := n + 1;
    ids := ids || jsonb_build_array(nid);
    if jsonb_typeof(e) = 'object' and jsonb_typeof(e->'steps') = 'array' then
      ids := ids || public.review_add_steps(uid, nid, proj, e->'steps');
    end if;
  end loop;
  return ids;
end $$;
-- review_apply runs as the signed-in user (not security definer), so that role must be able to call the helper;
-- RLS still limits what it can insert (owner insert: user_id must be auth.uid()).
revoke execute on function public.review_add_steps(uuid, uuid, uuid, jsonb) from public, anon;
grant execute on function public.review_add_steps(uuid, uuid, uuid, jsonb) to authenticated;

create or replace function public.review_apply(item uuid, owner uuid default null) returns jsonb
language plpgsql set search_path = '' as $$
declare
  uid uuid := coalesce((select auth.uid()), review_apply.owner);
  it public.review_items;
  s jsonb;
  t public.tasks;
  snap jsonb;
  tid uuid;
  nm text;
  res jsonb;
  newsteps jsonb;
  stepsnap jsonb;
begin
  select * into it from public.review_items r where r.id = review_apply.item and r.user_id = uid;
  if it.id is null then raise exception 'Card not found.'; end if;
  if it.status <> 'pending' then raise exception 'That card was already decided (undo it first).'; end if;
  s := it.suggestion;
  if s is null or coalesce(s->>'decision', '') = '' then raise exception 'No suggestion to submit on this card.'; end if;

  if it.kind = 'group' then
    if s ? 'proposal' then update public.review_items r set grp = jsonb_set(coalesce(r.grp, '{}'), '{proposal}', s->'proposal') where r.id = it.id; end if;
    res := public.review_decide(it.id, s->>'decision', 'user', nullif(s->>'note', ''), uid);
    update public.review_items r set suggestion = s || jsonb_build_object('applied_at', now()) where r.id = it.id;
    return res;
  end if;

  select * into t from public.tasks x where x.id = it.task_id and x.user_id = uid;
  if t.id is null then raise exception 'That action is gone.'; end if;
  snap := jsonb_build_object('t', 'fields', 'id', t.id, 'title', t.title, 'gain', t.gain, 'gain_by', t.gain_by, 'project_id', t.project_id,
    'in_inbox', t.in_inbox, 'folder_path', t.folder_path, 'planned_at', t.planned_at, 'due_at', t.due_at, 'defer_at', t.defer_at, 'flagged', t.flagged, 'updated_at', t.updated_at,
    'tags', coalesce((select jsonb_agg(x.tag_id) from public.task_tags x where x.task_id = t.id), '[]'));

  update public.tasks x set
    title = coalesce(nullif(s->>'title', ''), x.title),
    gain = case when s ? 'gain' then left(coalesce(s->>'gain', ''), 500) else x.gain end,
    gain_by = case when s ? 'gain' then (case when (s->>'gain_suggested')::boolean then 'agent' else null end) else x.gain_by end,
    project_id = case when s ? 'project_id' then (select p.id from public.projects p where p.id = (s->>'project_id')::uuid and p.user_id = uid) else x.project_id end,
    in_inbox = case when s ? 'project_id' and s->>'project_id' is not null then false else x.in_inbox end,
    planned_at = case when s ? 'planned' then (s->>'planned')::timestamptz else x.planned_at end,
    due_at = case when s ? 'due' then (s->>'due')::timestamptz else x.due_at end,
    defer_at = case when s ? 'defer' then (s->>'defer')::timestamptz else x.defer_at end,
    flagged = case when s ? 'flagged' then (s->>'flagged')::boolean else x.flagged end,
    folder_path = case when s ? 'folder' then nullif(left(trim(coalesce(s->>'folder', '')), 500), '') else x.folder_path end
  where x.id = t.id;

  for tid in select (jsonb_array_elements_text(coalesce(s->'add_tag_ids', '[]')))::uuid loop
    insert into public.task_tags (task_id, tag_id, user_id) select t.id, g.id, uid from public.tags g where g.id = tid and g.user_id = uid
      and not exists (select 1 from public.task_tags y where y.task_id = t.id and y.tag_id = g.id);
  end loop;
  for nm in select jsonb_array_elements_text(coalesce(s->'add_tag_names', '[]')) loop
    select g.id into tid from public.tags g where g.user_id = uid and lower(g.name) = lower(trim(nm)) and g.status <> 'dropped' order by g.parent_id nulls first limit 1;
    if tid is null then insert into public.tags (user_id, name) values (uid, left(trim(nm), 100)) returning id into tid; end if;
    insert into public.task_tags (task_id, tag_id, user_id) select t.id, tid, uid where not exists (select 1 from public.task_tags y where y.task_id = t.id and y.tag_id = tid);
  end loop;
  delete from public.task_tags x where x.task_id = t.id and x.user_id = uid
    and x.tag_id in (select (jsonb_array_elements_text(coalesce(s->'remove_tag_ids', '[]')))::uuid);

  -- Steps: the suggested breakdown goes in under the action, after any steps it already has (keep / someday only).
  if jsonb_typeof(s->'steps') = 'array' and jsonb_array_length(s->'steps') > 0 and s->>'decision' in ('keep', 'someday') then
    newsteps := public.review_add_steps(uid, t.id, (select y.project_id from public.tasks y where y.id = t.id), s->'steps');
    if s ? 'steps_in_order' then update public.tasks y set steps_in_order = (s->>'steps_in_order')::boolean where y.id = t.id; end if;
    stepsnap := jsonb_build_object('t', 'steps', 'id', t.id, 'ids', newsteps, 'steps_in_order', t.steps_in_order);
  end if;

  res := public.review_decide(it.id, s->>'decision', 'user', nullif(s->>'note', ''), uid);
  -- Undo restores the fields (and drops the added steps) as well as the decision.
  update public.review_items r set before = r.before || jsonb_build_array(snap) || coalesce(jsonb_build_array(stepsnap), '[]'),
    suggestion = s || jsonb_build_object('applied_at', now()) where r.id = it.id;
  return res;
end $$;
