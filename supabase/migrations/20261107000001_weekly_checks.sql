-- Weekly checks: a checkbox ticked once per Weekly Review, for the questions and routines that came in as
-- weekly repeating actions ("Am I reviewing?"). It is the daily checkbox with every = 'week':
--   tasks.daily = {tier, every: 'week', since}
-- so everything a daily one has holds for it (no dates or repeat, never "available", ticks in daily_ticks,
-- un-ticking keeps the row). What differs is when it is asked for: never on a day (it is not in Today), but in
-- the Weekly Review's "Weekly checks" step, where it counts as ticked if it was ticked on or after the day the
-- open review started. Each review starts it fresh. The rules are in js/daily-rules.js.
alter table public.tasks add constraint tasks_daily_every check (daily is null or not daily ? 'every' or daily->>'every' = 'week');

-- Full Review: a suggestion can make the action a weekly check (daily: {tier, every: 'week'}). This is the
-- tree version of review_apply (20261105000001) with every carried through; Undo already restores daily whole.
CREATE OR REPLACE FUNCTION public.review_apply(item uuid, owner uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
  ckid uuid;
  ckmade uuid;
  cksnap jsonb;
  dysnap jsonb;
  trsnap jsonb;
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
  snap := jsonb_build_object('t', 'fields', 'id', t.id, 'title', t.title, 'notes', t.notes, 'gain', t.gain, 'gain_by', t.gain_by, 'project_id', t.project_id,
    'in_inbox', t.in_inbox, 'folder_path', t.folder_path, 'planned_at', t.planned_at, 'due_at', t.due_at, 'defer_at', t.defer_at, 'flagged', t.flagged, 'updated_at', t.updated_at,
    'tags', coalesce((select jsonb_agg(x.tag_id) from public.task_tags x where x.task_id = t.id), '[]'));

  update public.tasks x set
    title = coalesce(nullif(s->>'title', ''), x.title),
    notes = case when nullif(trim(s->>'task_notes'), '') is not null then left(s->>'task_notes', 6000) else x.notes end,
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

  -- Daily: the action becomes a daily checkbox ({tier: must|should, weekdays?}) or a weekly check ({tier, every: week});
  -- its repeat and dates go (keep only).
  if jsonb_typeof(s->'daily') = 'object' and s->>'decision' = 'keep' then
    dysnap := jsonb_build_object('t', 'daily', 'id', t.id, 'daily', t.daily, 'repeat_rule', t.repeat_rule);
    update public.tasks y set daily = jsonb_strip_nulls(jsonb_build_object('tier', s->'daily'->>'tier', 'weekdays', s->'daily'->'weekdays', 'every', s->'daily'->>'every')) where y.id = t.id;
  end if;

  -- Steps: the suggested breakdown goes in under the action, after any steps it already has (keep / someday only).
  if jsonb_typeof(s->'steps') = 'array' and jsonb_array_length(s->'steps') > 0 and s->>'decision' in ('keep', 'someday') then
    newsteps := public.review_add_steps(uid, t.id, (select y.project_id from public.tasks y where y.id = t.id), s->'steps');
    if s ? 'steps_in_order' then update public.tasks y set steps_in_order = (s->>'steps_in_order')::boolean where y.id = t.id; end if;
    stepsnap := jsonb_build_object('t', 'steps', 'id', t.id, 'ids', newsteps, 'steps_in_order', t.steps_in_order);
  end if;

  -- Checklist: a new one ({name, items, reflect, complete_action}) is made and attached; an existing one ({id}) is
  -- attached. Undo puts the action's old checklist back and archives one made here (keep / someday only).
  if jsonb_typeof(s->'checklist') = 'object' and s->>'decision' in ('keep', 'someday') then
    if s->'checklist' ? 'id' then
      select c.id into ckid from public.checklists c where c.id = (s->'checklist'->>'id')::uuid and c.user_id = uid;
      if ckid is null then raise exception 'That checklist is gone.'; end if;
    else
      insert into public.checklists (user_id, name, items, reflect, complete_action, sort)
        values (uid, left(trim(coalesce(s->'checklist'->>'name', '')), 200), coalesce(s->'checklist'->'items', '[]'),
          coalesce((s->'checklist'->>'reflect')::boolean, false), coalesce((s->'checklist'->>'complete_action')::boolean, true),
          coalesce((select max(c.sort) + 1 from public.checklists c where c.user_id = uid), 0))
        returning id into ckid;
      ckmade := ckid;
    end if;
    cksnap := jsonb_build_object('t', 'checklist', 'id', t.id, 'prev', t.checklist_id, 'made', ckmade);
    update public.tasks y set checklist_id = ckid where y.id = t.id;
  end if;

  -- Tech tree: what the suggestion adds (goals, cards) and links, made now; Undo takes them back.
  if jsonb_typeof(s->'tree') = 'object' and s->>'decision' in ('keep', 'someday') then
    trsnap := public.review_tree_apply(uid, s->'tree');
  end if;

  res := public.review_decide(it.id, s->>'decision', 'user', nullif(s->>'note', ''), uid);
  -- Undo restores the fields (and drops the added steps) as well as the decision. The daily entry goes first:
  -- while an action is daily its dates stay empty, so Undo must make it not daily before it restores them.
  update public.review_items r set before = r.before || case when dysnap is null then '[]'::jsonb else jsonb_build_array(dysnap) end || jsonb_build_array(snap) || coalesce(jsonb_build_array(stepsnap), '[]') || case when cksnap is null then '[]'::jsonb else jsonb_build_array(cksnap) end || case when trsnap is null then '[]'::jsonb else jsonb_build_array(trsnap) end,
    suggestion = s || jsonb_build_object('applied_at', now()) where r.id = it.id;
  return res;
end $function$;
