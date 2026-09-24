-- Folders: an action or project can name a folder on your Mac (its support files, e.g. "~/_SYNC/MAGA/_Todo/Bookmarks cleanup").
-- The app opens it through an Apple Shortcut (browsers can't open local folders). Settings keep where your _Todo
-- folder is and the Shortcut's name. Full Review suggestions can set the folder ("folder"); Undo puts it back.
alter table public.tasks add column folder_path text check (char_length(folder_path) <= 500);
alter table public.projects add column folder_path text check (char_length(folder_path) <= 500);
alter table public.user_settings add column todo_folder text check (char_length(todo_folder) <= 500),
  add column folder_shortcut text not null default 'Open in Finder' check (char_length(folder_shortcut) between 1 and 100);

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
  base numeric;
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
    select coalesce(max(c.sort), -1) + 1 into base from public.tasks c where c.parent_id = t.id;
    with ins as (
      insert into public.tasks (user_id, title, parent_id, project_id, in_inbox, sort)
      select uid, left(trim(x.v), 500), t.id, (select y.project_id from public.tasks y where y.id = t.id), false, base + x.n - 1
      from jsonb_array_elements_text(s->'steps') with ordinality x(v, n) where trim(x.v) <> '' order by x.n
      returning id)
    select coalesce(jsonb_agg(ins.id), '[]') into newsteps from ins;
    if s ? 'steps_in_order' then update public.tasks y set steps_in_order = (s->>'steps_in_order')::boolean where y.id = t.id; end if;
    stepsnap := jsonb_build_object('t', 'steps', 'id', t.id, 'ids', newsteps, 'steps_in_order', t.steps_in_order);
  end if;

  res := public.review_decide(it.id, s->>'decision', 'user', nullif(s->>'note', ''), uid);
  -- Undo restores the fields (and drops the added steps) as well as the decision.
  update public.review_items r set before = r.before || jsonb_build_array(snap) || coalesce(jsonb_build_array(stepsnap), '[]'),
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
    elsif e->>'t' = 'fields' then
      update public.tasks t set title = e->>'title', gain = coalesce(e->>'gain', ''), gain_by = e->>'gain_by', project_id = (e->>'project_id')::uuid,
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
