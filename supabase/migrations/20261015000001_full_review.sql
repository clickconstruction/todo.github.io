-- Full Review: go through a list one card at a time, with Claude alongside (in another window, over the
-- MCP). Both sides share one session: the same queue and the same current card. Changes arrive live
-- (Realtime on these two tables), and every decision can be undone. Nothing is deleted.
--   * review_sessions: scope, the current card, and Claude's presence (agent_seen_at / agent_status)
--   * review_items: the queue, in `sort` order. A card is one action (task_id) or a group of similar
--     actions (grp: {label, key, task_ids, proposal: {op: someday|drop|park|keep_newest, keep}}).
--     priority = pulled to the front (looks important, flagged, dated, has a gain).
--     note = Claude's one line of reasoning; changed = {field: time} for fields Claude just changed.
--   * review_decide(item, decision, by, note): keep | someday | done | drop | skip (a card), accept |
--     keep_all | one_by_one | skip (a group); records what it changed and moves to the next card.
--   * review_undo(item): puts it all back and makes that card current again.
create table public.review_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title text not null default 'Full Review' check (char_length(title) <= 200),
  scope jsonb not null default '{}' check (jsonb_typeof(scope) = 'object'),
  current_item uuid,
  status text not null default 'active' check (status in ('active', 'done', 'abandoned')),
  agent_seen_at timestamptz,
  agent_status text not null default '' check (char_length(agent_status) <= 40),
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.review_sessions (user_id, created_at desc);

create table public.review_items (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.review_sessions(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  sort double precision not null default 0,
  kind text not null check (kind in ('task', 'group')),
  task_id uuid references public.tasks(id) on delete cascade,
  grp jsonb check (grp is null or jsonb_typeof(grp) = 'object'),
  priority boolean not null default false,
  status text not null default 'pending' check (status in ('pending', 'reviewed', 'skipped', 'void')),
  decision text,
  decided_by text check (decided_by in ('user', 'agent')),
  note text not null default '' check (char_length(note) <= 1000),
  changed jsonb not null default '{}' check (jsonb_typeof(changed) = 'object'),
  before jsonb not null default '[]',
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((kind = 'task') = (task_id is not null))
);
create index on public.review_items (session_id, sort);
create index on public.review_items (session_id, status);

alter table public.review_sessions enable row level security;
alter table public.review_items enable row level security;
create policy "owner select" on public.review_sessions for select to authenticated using ((select auth.uid()) = user_id);
create policy "owner insert" on public.review_sessions for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "owner update" on public.review_sessions for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "owner select" on public.review_items for select to authenticated using ((select auth.uid()) = user_id);
create policy "owner insert" on public.review_items for insert to authenticated with check ((select auth.uid()) = user_id and exists (select 1 from public.review_sessions s where s.id = session_id and s.user_id = (select auth.uid())));
create policy "owner update" on public.review_items for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create trigger review_sessions_touch before update on public.review_sessions for each row execute function public.touch_updated_at();
create trigger review_items_touch before update on public.review_items for each row execute function public.touch_updated_at();
create trigger review_sessions_no_delete before delete on public.review_sessions for each row execute function public.forbid_delete();
create trigger review_items_no_delete before delete on public.review_items for each row execute function public.forbid_delete();

-- Live: the app listens for changes to the session and its cards.
alter publication supabase_realtime add table public.review_sessions, public.review_items;

-- The next card still to look at, after `after_sort` (wrapping to the start); null when none are left.
create or replace function public.review_next(sid uuid, after_sort double precision) returns uuid
language sql stable set search_path = '' as $$
  select id from public.review_items where session_id = sid and status = 'pending'
  order by (sort <= after_sort), sort limit 1
$$;

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

  update public.review_items r set status = case when decision = 'skip' then 'skipped' else 'reviewed' end,
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
  perform set_config('app.keep_updated_at', 'on', true); -- restored actions keep their own age
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
    end if;
  end loop;
  perform set_config('app.keep_updated_at', 'off', true);
  update public.review_items r set status = 'pending', decision = null, decided_by = null, before = '[]', reviewed_at = null where r.id = it.id;
  update public.review_sessions s set current_item = it.id, status = 'active', finished_at = null where s.id = it.session_id;
  return jsonb_build_object('restored', n, 'current', it.id);
end $$;

revoke execute on function public.review_decide(uuid, text, text, text, uuid) from public, anon;
grant execute on function public.review_decide(uuid, text, text, text, uuid) to authenticated, service_role;
revoke execute on function public.review_undo(uuid, uuid) from public, anon;
grant execute on function public.review_undo(uuid, uuid) to authenticated, service_role;
revoke execute on function public.review_next(uuid, double precision) from public, anon;
grant execute on function public.review_next(uuid, double precision) to authenticated, service_role;
