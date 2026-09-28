-- Tech tree, grown from a review and looked back on.
--   A Full Review suggestion can carry additions to the tree (suggestion.tree): items to make (a goal,
--     milestone or destination, or a card in a project) or to reuse (exists: what is already there), and
--     links between them. Submit makes them; Undo takes them back (goals and cards dropped, links archived).
--   tree_activity: what was finished in each project since a day, and what is still open in it, in one read. The app only keeps the last
--     day of finished cards, so "am I working on it?" is asked of the database.
--   user_settings.tree_reviewed_at: when the tree was last reviewed ("since my last review").
alter table public.user_settings add column tree_reviewed_at timestamptz;

create or replace function public.tree_activity(since timestamptz, owner uuid default null) returns jsonb
language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('project_id', x.project_id, 'done', x.done, 'last', x.last, 'open', x.open)), '[]'::jsonb)
  from (select t.project_id,
               count(*) filter (where t.completed_at >= tree_activity.since) as done,
               max(t.completed_at) filter (where t.completed_at >= tree_activity.since) as last,
               count(*) filter (where t.completed_at is null and t.dropped_at is null) as open
          from public.tasks t
         where t.user_id = coalesce((select auth.uid()), tree_activity.owner) and t.project_id is not null
           and (t.completed_at >= tree_activity.since or (t.completed_at is null and t.dropped_at is null))
         group by t.project_id) x
$$;
revoke execute on function public.tree_activity(timestamptz, uuid) from public, anon;
grant execute on function public.tree_activity(timestamptz, uuid) to authenticated, service_role;

-- Make what a suggestion adds to the tree. tree = { items: [{ kind: goal | milestone | destination | card,
-- title, project_id?, exists?: { kind: goal | project | task, id } }], links: [{ node: i, requires: j }] }
-- where i and j are places in items. → the Undo record: { t: tree, goals, tasks, links } (what was made).
create or replace function public.review_tree_apply(uid uuid, tree jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare
  x jsonb;
  i int := 0;
  kinds text[] := '{}';
  ids uuid[] := '{}';
  made_goals uuid[] := '{}';
  made_tasks uuid[] := '{}';
  made_links uuid[] := '{}';
  nid uuid;
  nk text;
  a int;
  b int;
  lid uuid;
begin
  if jsonb_typeof(tree->'items') <> 'array' then return null; end if;
  if jsonb_array_length(tree->'items') > 40 then raise exception 'Up to 40 items in one suggestion.'; end if;
  for x in select value from jsonb_array_elements(tree->'items') loop
    if x ? 'exists' then
      nk := x->'exists'->>'kind'; nid := (x->'exists'->>'id')::uuid;
      if not (case nk when 'goal' then exists (select 1 from public.goals g where g.id = nid and g.user_id = uid)
                      when 'project' then exists (select 1 from public.projects p where p.id = nid and p.user_id = uid)
                      when 'task' then exists (select 1 from public.tasks t where t.id = nid and t.user_id = uid) else false end) then raise exception 'Something this suggestion builds on is gone: %', coalesce(x->>'title', ''); end if;
    elsif x->>'kind' = 'card' then
      if x->>'project_id' is not null and not exists (select 1 from public.projects p where p.id = (x->>'project_id')::uuid and p.user_id = uid) then raise exception 'The project for “%” is gone.', x->>'title'; end if;
      insert into public.tasks (user_id, title, project_id, in_inbox, source)
        values (uid, left(trim(x->>'title'), 1000), (x->>'project_id')::uuid, x->>'project_id' is null, 'review') returning id into nid;
      nk := 'task'; made_tasks := made_tasks || nid;
    elsif x->>'kind' in ('goal', 'milestone', 'destination') then
      insert into public.goals (user_id, title, kind) values (uid, left(trim(x->>'title'), 300), x->>'kind') returning id into nid;
      nk := 'goal'; made_goals := made_goals || nid;
    else
      raise exception 'A new item is a goal, milestone, destination or card.';
    end if;
    kinds := kinds || nk; ids := ids || nid; i := i + 1;
  end loop;
  for x in select value from jsonb_array_elements(coalesce(tree->'links', '[]')) loop
    a := (x->>'node')::int + 1; b := (x->>'requires')::int + 1;
    if a < 1 or a > i or b < 1 or b > i then raise exception 'A link points at something that isn''t in the suggestion.'; end if;
    select l.id into lid from public.tree_links l where l.user_id = uid and l.archived_at is null and l.state = 'accepted'
      and l.node_kind = kinds[a] and l.node_id = ids[a] and l.requires_kind = kinds[b] and l.requires_id = ids[b];
    if lid is null then
      update public.tree_links l set state = 'accepted' where l.user_id = uid and l.archived_at is null and l.state = 'proposed'
        and l.node_kind = kinds[a] and l.node_id = ids[a] and l.requires_kind = kinds[b] and l.requires_id = ids[b] returning l.id into lid;
      if lid is null then
        insert into public.tree_links (user_id, node_kind, node_id, requires_kind, requires_id, proposed_by) values (uid, kinds[a], ids[a], kinds[b], ids[b], 'agent') returning id into lid;
      end if;
      made_links := made_links || lid;
    end if;
  end loop;
  return jsonb_build_object('t', 'tree', 'goals', to_jsonb(made_goals), 'tasks', to_jsonb(made_tasks), 'links', to_jsonb(made_links));
end $$;
-- review_apply runs as the signed-in user, so that role must be able to call the helper; RLS still limits
-- what it can make (owner insert: user_id must be auth.uid()), and the links' own guard checks the rest.
revoke execute on function public.review_tree_apply(uuid, jsonb) from public, anon;
grant execute on function public.review_tree_apply(uuid, jsonb) to authenticated, service_role;

-- Submit and Undo are the dailies versions (20261101000001) with the tree added.
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

  -- Daily: the action becomes a daily checkbox ({tier: must|should, weekdays?}); its repeat and dates go (keep only).
  if jsonb_typeof(s->'daily') = 'object' and s->>'decision' = 'keep' then
    dysnap := jsonb_build_object('t', 'daily', 'id', t.id, 'daily', t.daily, 'repeat_rule', t.repeat_rule);
    update public.tasks y set daily = jsonb_strip_nulls(jsonb_build_object('tier', s->'daily'->>'tier', 'weekdays', s->'daily'->'weekdays')) where y.id = t.id;
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
end $$;

create or replace function public.review_undo(item uuid, owner uuid default null) returns jsonb
language plpgsql set search_path = '' as $$
declare
  uid uuid := coalesce((select auth.uid()), review_undo.owner);
  it public.review_items;
  e jsonb;
  n int := 0;
begin
  select * into it from public.review_items r where r.id = review_undo.item and r.user_id = uid;
  if it.id is null then raise exception 'Card not found.'; end if;
  if it.status not in ('reviewed', 'skipped') then raise exception 'Nothing to undo on that card.'; end if;
  perform set_config('app.keep_updated_at', 'on', true);
  for e in select value from jsonb_array_elements(it.before) loop
    if e->>'t' = 'someday_tag' then
      delete from public.task_tags x where x.user_id = uid and x.tag_id = (e->>'tag')::uuid and x.task_id in (select (jsonb_array_elements_text(e->'ids'))::uuid);
      n := n + jsonb_array_length(e->'ids');
    elsif e->>'t' = 'task' then
      update public.tasks t set completed_at = (e->>'completed_at')::timestamptz, dropped_at = (e->>'dropped_at')::timestamptz,
        updated_at = coalesce((e->>'updated_at')::timestamptz, t.updated_at) where t.id = (e->>'id')::uuid and t.user_id = uid;
      n := n + 1;
    elsif e->>'t' = 'project' then
      update public.projects p set status = e->>'status' where p.id = (e->>'id')::uuid and p.user_id = uid; n := n + 1;
    elsif e->>'t' = 'expanded' then
      update public.review_items r set status = 'void' where r.session_id = it.session_id and r.user_id = uid
        and r.sort > it.sort and r.sort < it.sort + 1 and r.kind = 'task' and r.status = 'pending';
    elsif e->>'t' = 'reading' then
      update public.tasks t set reading_state = e->>'reading_state', reading_type = e->>'reading_type', updated_at = coalesce((e->>'updated_at')::timestamptz, t.updated_at)
        where t.id = (e->>'id')::uuid and t.user_id = uid;
      if (e->>'someday_added')::boolean then
        delete from public.task_tags x using public.tags g where x.tag_id = g.id and x.task_id = (e->>'id')::uuid and x.user_id = uid and g.parent_id is null and g.name ~* '^someday';
      end if;
      n := n + 1;
    elsif e->>'t' = 'slipbox' then
      update public.slipbox_notes s set archived_at = now() where s.id = (e->>'note')::uuid and s.user_id = uid;
      update public.tasks t set dropped_at = (e->>'dropped_at')::timestamptz, updated_at = coalesce((e->>'updated_at')::timestamptz, t.updated_at)
        where t.id = (e->>'id')::uuid and t.user_id = uid;
      n := n + 1;
    elsif e->>'t' = 'steps' then
      perform set_config('app.importing', 'on', true); -- group rules aside: dropping the added steps must not complete the action
      update public.tasks t set dropped_at = now() where t.user_id = uid and t.id in (select (jsonb_array_elements_text(e->'ids'))::uuid) and t.completed_at is null and t.dropped_at is null;
      perform set_config('app.importing', 'off', true);
      update public.tasks t set steps_in_order = coalesce((e->>'steps_in_order')::boolean, false) where t.id = (e->>'id')::uuid and t.user_id = uid;
      n := n + 1;
    elsif e->>'t' = 'tree' then
      update public.tree_links l set archived_at = now() where l.user_id = uid and l.archived_at is null and l.id in (select (jsonb_array_elements_text(coalesce(e->'links', '[]')))::uuid);
      update public.goals g set status = 'dropped' where g.user_id = uid and g.id in (select (jsonb_array_elements_text(coalesce(e->'goals', '[]')))::uuid);
      perform set_config('app.importing', 'on', true);
      update public.tasks t set dropped_at = now() where t.user_id = uid and t.completed_at is null and t.dropped_at is null and t.id in (select (jsonb_array_elements_text(coalesce(e->'tasks', '[]')))::uuid);
      perform set_config('app.importing', 'off', true);
      n := n + 1;
    elsif e->>'t' = 'daily' then
      update public.tasks t set daily = case when jsonb_typeof(e->'daily') = 'object' then e->'daily' else null end,
        repeat_rule = case when jsonb_typeof(e->'repeat_rule') = 'object' then e->'repeat_rule' else null end
      where t.id = (e->>'id')::uuid and t.user_id = uid;
      n := n + 1;
    elsif e->>'t' = 'checklist' then
      update public.tasks t set checklist_id = (e->>'prev')::uuid where t.id = (e->>'id')::uuid and t.user_id = uid;
      if e->>'made' is not null then update public.checklists c set archived_at = now() where c.id = (e->>'made')::uuid and c.user_id = uid; end if;
      n := n + 1;
    elsif e->>'t' = 'fields' then
      update public.tasks t set title = e->>'title', notes = case when e ? 'notes' then coalesce(e->>'notes', '') else t.notes end, gain = coalesce(e->>'gain', ''), gain_by = e->>'gain_by', project_id = (e->>'project_id')::uuid,
        in_inbox = (e->>'in_inbox')::boolean, planned_at = (e->>'planned_at')::timestamptz, due_at = (e->>'due_at')::timestamptz,
        defer_at = (e->>'defer_at')::timestamptz, flagged = (e->>'flagged')::boolean,
        folder_path = case when e ? 'folder_path' then e->>'folder_path' else t.folder_path end, updated_at = coalesce((e->>'updated_at')::timestamptz, t.updated_at)
      where t.id = (e->>'id')::uuid and t.user_id = uid;
      delete from public.task_tags x where x.task_id = (e->>'id')::uuid and x.user_id = uid
        and not (x.tag_id in (select (jsonb_array_elements_text(e->'tags'))::uuid));
      insert into public.task_tags (task_id, tag_id, user_id) select (e->>'id')::uuid, g, uid from (select (jsonb_array_elements_text(e->'tags'))::uuid g) z
        where not exists (select 1 from public.task_tags y where y.task_id = (e->>'id')::uuid and y.tag_id = z.g);
      n := n + 1;
    end if;
  end loop;
  perform set_config('app.keep_updated_at', 'off', true);
  update public.review_items r set status = 'pending', decision = null, decided_by = null, before = '[]', reviewed_at = null,
    suggestion = case when r.suggestion is null then null else r.suggestion - 'applied_at' end where r.id = it.id;
  update public.review_sessions s set current_item = it.id, status = 'active', finished_at = null where s.id = it.session_id;
  return jsonb_build_object('restored', n, 'current', it.id);
end $$;
