-- Dailies: an action can be a daily checkbox instead of a repeating action.
--   tasks.daily = {tier: must | should, weekdays?: [0-6], since: YYYY-MM-DD}   (null = an ordinary action)
--     must   = "Have to, every day": a missed day shows, and it counts in the Daily review's must-dos.
--     should = "Should, most days": a missed day is just an empty dot.
--   daily_ticks = one row per action per day it was ticked (state done), kept when un-ticked (state cleared).
-- Each day starts fresh: nothing carries over and nothing piles up. The action itself stays open; completing
-- or dropping it ends it. While an action is daily it has no repeat rule and no dates (they would make it
-- overdue or clone it), and it is never an "available" action or a turn-holder in an ordered list.
alter table public.tasks add column daily jsonb
  check (daily is null or (jsonb_typeof(daily) = 'object' and daily->>'tier' in ('must', 'should')
    and (not daily ? 'weekdays' or (jsonb_typeof(daily->'weekdays') = 'array' and jsonb_array_length(daily->'weekdays') between 1 and 7))));
create index on public.tasks (user_id) where daily is not null and completed_at is null and dropped_at is null;

create or replace function public.tasks_daily_guard() returns trigger language plpgsql set search_path = '' as $$
begin
  if new.daily is not null then
    new.repeat_rule := null; new.due_at := null; new.planned_at := null; new.defer_at := null;
    -- since: the day it became daily (kept through later edits), so earlier days never count as missed.
    if not new.daily ? 'since' then
      new.daily := new.daily || jsonb_build_object('since', case when tg_op = 'UPDATE' and old.daily ? 'since' then old.daily->>'since' else to_char(now(), 'YYYY-MM-DD') end);
    end if;
  end if;
  return new;
end $$;
create trigger tasks_daily_guard before insert or update on public.tasks for each row execute function public.tasks_daily_guard();

create table public.daily_ticks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  task_id uuid not null references public.tasks(id) on delete cascade,
  day date not null,
  state text not null default 'done' check (state in ('done', 'cleared')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (task_id, day)
);
create index on public.daily_ticks (user_id, day desc);
alter table public.daily_ticks enable row level security;
create policy "owner select" on public.daily_ticks for select to authenticated using ((select auth.uid()) = user_id);
create policy "owner insert" on public.daily_ticks for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "owner update" on public.daily_ticks for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create trigger daily_ticks_touch before update on public.daily_ticks for each row execute function public.touch_updated_at();
create trigger daily_ticks_no_delete before delete on public.daily_ticks for each row execute function public.forbid_delete();

-- A tick belongs to the owner's own open daily action, on a day that has come (a day's grace for time zones).
create or replace function public.daily_ticks_guard() returns trigger language plpgsql security definer set search_path = '' as $$
declare t public.tasks;
begin
  select * into t from public.tasks x where x.id = new.task_id and x.user_id = new.user_id;
  if t.id is null then raise exception 'That action isn''t yours.' using errcode = 'foreign_key_violation'; end if;
  if tg_op = 'UPDATE' and (new.task_id <> old.task_id or new.day <> old.day or new.user_id <> old.user_id) then raise exception 'A tick stays on its action and day.' using errcode = 'check_violation'; end if;
  if new.state = 'done' and (tg_op = 'INSERT' or old.state <> 'done') then
    if t.daily is null then raise exception 'That action isn''t a daily one.' using errcode = 'check_violation'; end if;
    if t.completed_at is not null or t.dropped_at is not null then raise exception 'That action is closed.' using errcode = 'check_violation'; end if;
    if new.day > (now() + interval '1 day')::date then raise exception 'That day hasn''t come yet.' using errcode = 'check_violation'; end if;
  end if;
  return new;
end $$;
create trigger daily_ticks_guard before insert or update on public.daily_ticks for each row execute function public.daily_ticks_guard();

-- The MCP's snapshot carries the new column.
create or replace function public.mcp_snapshot(owner uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'tasks', (select jsonb_build_object('cols', to_jsonb(array['id','project_id','parent_id','in_inbox','title','notes','flagged','defer_at','due_at','completed_at','dropped_at','source','sort','created_at','updated_at','completion_note','planned_at','estimate_minutes','place_id','location_trigger','location_radius_m','repeat_rule','steps_in_order','external_ref','import_id','energy','waiting_on','delegated_at','follow_up_at','agenda_for','tickler','reference_id','scheduled_at','scheduled_minutes','checklist_id','gain','gain_cost','gain_by','gain_met','clarify_skips','reading_type','reading_state','reading_url','reading_notes_done','important','folder_path','steps_single','complete_with_last','on_unblock','daily']),
                                        'rows', coalesce(jsonb_agg(jsonb_build_array(t.id,t.project_id,t.parent_id,t.in_inbox,t.title,t.notes,t.flagged,t.defer_at,t.due_at,t.completed_at,t.dropped_at,t.source,t.sort,t.created_at,t.updated_at,t.completion_note,t.planned_at,t.estimate_minutes,t.place_id,t.location_trigger,t.location_radius_m,t.repeat_rule,t.steps_in_order,t.external_ref,t.import_id,t.energy,t.waiting_on,t.delegated_at,t.follow_up_at,t.agenda_for,t.tickler,t.reference_id,t.scheduled_at,t.scheduled_minutes,t.checklist_id,t.gain,t.gain_cost,t.gain_by,t.gain_met,t.clarify_skips,t.reading_type,t.reading_state,t.reading_url,t.reading_notes_done,t.important,t.folder_path,t.steps_single,t.complete_with_last,t.on_unblock,t.daily) order by t.id), '[]'::jsonb))
                from public.tasks t where t.user_id = owner and t.completed_at is null and t.dropped_at is null),
    'tags', coalesce((select jsonb_agg(to_jsonb(g) order by g.id) from public.tags g where g.user_id = owner), '[]'::jsonb),
    'task_tags', coalesce((select jsonb_agg(jsonb_build_object('task_id', x.task_id, 'tag_id', x.tag_id) order by x.task_id, x.tag_id)
                            from public.task_tags x where x.user_id = owner), '[]'::jsonb),
    'project_tags', coalesce((select jsonb_agg(jsonb_build_object('project_id', x.project_id, 'tag_id', x.tag_id) order by x.project_id, x.tag_id)
                               from public.project_tags x where x.user_id = owner), '[]'::jsonb),
    'projects', coalesce((select jsonb_agg(to_jsonb(p) order by p.id) from public.projects p where p.user_id = owner), '[]'::jsonb),
    'people', coalesce((select jsonb_agg(to_jsonb(p) order by p.id) from public.people p where p.user_id = owner), '[]'::jsonb),
    'places', coalesce((select jsonb_agg(to_jsonb(p) order by p.id) from public.places p where p.user_id = owner), '[]'::jsonb),
    'task_waits', coalesce((select jsonb_agg(jsonb_build_object('task_id', w.task_id, 'waits_for', w.waits_for) order by w.task_id, w.waits_for)
                             from public.task_waits w where w.user_id = owner), '[]'::jsonb)
  );
$$;
revoke execute on function public.mcp_snapshot(uuid) from public, anon, authenticated;
grant execute on function public.mcp_snapshot(uuid) to service_role;

-- Availability: a daily action is never an available action, and never holds the turn in an ordered list.
create or replace function public.available_task_ids(owner uuid, only_ids uuid[] default null, as_of timestamptz default now())
returns uuid[] language sql stable set search_path = '' as $$
with recursive
t as (select id, parent_id, project_id, sort, created_at, defer_at, steps_in_order, steps_single, waiting_on, agenda_for, daily
        from public.tasks where user_id = owner and completed_at is null and dropped_at is null),
-- each asked-about task with itself (depth 0) and every open task above it
chain(id, node, depth) as (
  select id, id, 0 from t where only_ids is null or id = any(only_ids)
  union all
  select c.id, p.id, c.depth + 1 from chain c join t n on n.id = c.node join t p on p.id = n.parent_id where c.depth < 9),
tagchain(id, cur, depth) as (
  select id, id, 0 from public.tags where user_id = owner
  union all
  select tc.id, g.parent_id, tc.depth + 1 from tagchain tc join public.tags g on g.id = tc.cur where g.parent_id is not null and tc.depth < 7),
held as (select tc.id from tagchain tc join public.tags g on g.id = tc.cur group by tc.id
          having bool_or(g.status = 'on_hold') and not bool_or(g.status = 'dropped')),
-- per open task, once: each reason it (as a link in a chain) can block
node_held as (select l.task_id as id from public.task_tags l join held h on h.id = l.tag_id
              union select n.id from t n join public.project_tags l on l.project_id = n.project_id join held h on h.id = l.tag_id),
node_waits as (select distinct w.task_id as id from public.task_waits w join t b on b.id = w.waits_for),
first_child as (select distinct on (parent_id) parent_id, id from t where parent_id is not null and daily is null
                 order by parent_id, coalesce(sort, 0), created_at, id),
first_top as (select distinct on (project_id) project_id, id from t where parent_id is null and project_id is not null and daily is null
               order by project_id, coalesce(sort, 0), created_at, id),
node_turn as (select n.id from t n
               left join t p on p.id = n.parent_id
               left join first_child fc on fc.parent_id = p.id
               left join public.projects np on np.id = n.project_id
               left join first_top ft on ft.project_id = n.project_id
              where (p.id is not null and p.steps_in_order and fc.id <> n.id)
                 or (p.id is null and np.kind = 'sequential' and ft.id <> n.id)),
blocked as (select c.id,
                   bool_or(coalesce(n.defer_at > as_of, false)) as deferred,
                   bool_or(c.depth < 8 and nh.id is not null) as held,
                   bool_or(c.depth < 8 and nw.id is not null) as waits,
                   bool_or(nt.id is not null) as turn
              from chain c join t n on n.id = c.node
              left join node_held nh on nh.id = c.node
              left join node_waits nw on nw.id = c.node
              left join node_turn nt on nt.id = c.node
             group by c.id),
has_steps as (select distinct parent_id as id from t where parent_id is not null),
person_tagged as (select distinct l.task_id as id from public.task_tags l join public.people pp on pp.tag_id = l.tag_id
                   where pp.user_id = owner and pp.archived_at is null)
select coalesce(array_agg(x.id order by x.id), '{}') from t x
join blocked b on b.id = x.id
left join public.projects pr on pr.id = x.project_id
left join has_steps hs on hs.id = x.id
left join person_tagged pt on pt.id = x.id
where not x.steps_single and x.daily is null
  and x.waiting_on is null and x.agenda_for is null
  and (pr.id is null or (pr.status = 'active' and (pr.defer_at is null or pr.defer_at <= as_of)))
  and hs.id is null and pt.id is null
  and not b.deferred and not b.held and not b.waits and not b.turn
$$;
revoke execute on function public.available_task_ids(uuid, uuid[], timestamptz) from public, anon, authenticated;
grant execute on function public.available_task_ids(uuid, uuid[], timestamptz) to service_role;

-- Full Review: a suggestion can make the action daily (daily: {tier, weekdays?}); Undo puts its repeat and dates back.
-- Both functions are the notes versions (20261031000001) with daily added.
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

  res := public.review_decide(it.id, s->>'decision', 'user', nullif(s->>'note', ''), uid);
  -- Undo restores the fields (and drops the added steps) as well as the decision. The daily entry goes first:
  -- while an action is daily its dates stay empty, so Undo must make it not daily before it restores them.
  update public.review_items r set before = r.before || case when dysnap is null then '[]'::jsonb else jsonb_build_array(dysnap) end || jsonb_build_array(snap) || coalesce(jsonb_build_array(stepsnap), '[]') || case when cksnap is null then '[]'::jsonb else jsonb_build_array(cksnap) end,
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
