-- Slipbox and reading list (bridges between GTD and a slipbox / Zettelkasten).
--   * slipbox_notes: one idea per note, in your own words; fleeting (just captured) or permanent (processed);
--     links are [[Title]] in the body (Obsidian-style); archived, never deleted. Not actions: never in lists.
--   * tasks.reading_*: a reading-list item (book / article / video / podcast / other), up_next (parked in
--     Someday, out of your lists), reading (a live action) or finished (completed; notes_done when its notes
--     are written).
--   * reading_set(task, state, type): move an item along the reading list (Someday tag handled).
--   * slipbox_from_task(task, title, body, source): a note from an action (Clarify's Slipbox choice); the
--     action is dropped, the note remembers where it came from.
--   * Full Review decisions: reading (→ up next) and slipbox (→ fleeting note), both undoable.
create table public.slipbox_notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 300),
  body text not null default '' check (char_length(body) <= 20000),
  source text not null default '' check (char_length(source) <= 500),
  source_url text check (source_url is null or char_length(source_url) <= 2000),
  kind text not null default 'fleeting' check (kind in ('fleeting', 'permanent')),
  from_task_id uuid references public.tasks(id) on delete set null,
  reading_task_id uuid references public.tasks(id) on delete set null,
  processed_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.slipbox_notes (user_id, kind) where archived_at is null;
alter table public.slipbox_notes enable row level security;
create policy "owner select" on public.slipbox_notes for select to authenticated using ((select auth.uid()) = user_id);
create policy "owner insert" on public.slipbox_notes for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "owner update" on public.slipbox_notes for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create trigger slipbox_notes_touch before update on public.slipbox_notes for each row execute function public.touch_updated_at();
create trigger slipbox_notes_no_delete before delete on public.slipbox_notes for each row execute function public.forbid_delete();

alter table public.tasks
  add column reading_type text check (reading_type in ('book', 'article', 'video', 'podcast', 'other')),
  add column reading_state text check (reading_state in ('up_next', 'reading', 'finished')),
  add column reading_url text check (reading_url is null or char_length(reading_url) <= 2000),
  add column reading_notes_done boolean not null default false;
create index on public.tasks (user_id, reading_state) where reading_state is not null;

-- What kind of reading an action is, from its words (a guess; you can change it).
create or replace function public.reading_guess(title text) returns text
language sql immutable set search_path = '' as $$
  select case
    when title ~* '\m(watch|video|youtube|film|movie|documentary|ted talk)\M' then 'video'
    when title ~* '\m(listen|podcast|episode|audiobook)\M' then 'podcast'
    when title ~* '\m(book|novel|archive\.org)\M' then 'book'
    when title ~* 'https?://' then 'article'
    when title ~* '^\s*read\M' then 'book'
    else 'other' end
$$;

create or replace function public.reading_set(task uuid, state text, rtype text default null, owner uuid default null) returns jsonb
language plpgsql set search_path = '' as $$
declare
  uid uuid := coalesce((select auth.uid()), reading_set.owner);
  t public.tasks;
  someday uuid;
  url text;
begin
  select * into t from public.tasks x where x.id = reading_set.task and x.user_id = uid;
  if t.id is null then raise exception 'Action not found.'; end if;
  if state not in ('up_next', 'reading', 'finished', 'off') then raise exception 'state: up_next, reading, finished or off.'; end if;
  select g.id into someday from public.tags g where g.user_id = uid and g.parent_id is null and g.name ~* '^someday' limit 1;
  url := coalesce(t.reading_url, substring(t.title || ' ' || coalesce(t.notes, '') from 'https?://[^\s)>\]]+'));
  if state = 'up_next' then
    if someday is null then insert into public.tags (user_id, name, status) values (uid, 'Someday', 'on_hold') returning id into someday; end if;
    insert into public.task_tags (task_id, tag_id, user_id) select t.id, someday, uid where not exists (select 1 from public.task_tags y where y.task_id = t.id and y.tag_id = someday);
    update public.tasks x set reading_state = 'up_next', reading_type = coalesce(rtype, x.reading_type, public.reading_guess(x.title)), reading_url = url, flagged = false where x.id = t.id;
  elsif state = 'reading' then
    if someday is not null then delete from public.task_tags y where y.task_id = t.id and y.tag_id = someday; end if;
    update public.tasks x set reading_state = 'reading', reading_type = coalesce(rtype, x.reading_type, public.reading_guess(x.title)), reading_url = url,
      completed_at = null, dropped_at = null where x.id = t.id;
  elsif state = 'finished' then
    if someday is not null then delete from public.task_tags y where y.task_id = t.id and y.tag_id = someday; end if;
    update public.tasks x set reading_state = 'finished', reading_type = coalesce(rtype, x.reading_type, public.reading_guess(x.title)), reading_url = url,
      completed_at = coalesce(x.completed_at, now()), reading_notes_done = false where x.id = t.id;
  else
    update public.tasks x set reading_state = null where x.id = t.id;
  end if;
  return (select jsonb_build_object('id', x.id, 'reading_state', x.reading_state, 'reading_type', x.reading_type) from public.tasks x where x.id = t.id);
end $$;

create or replace function public.slipbox_from_task(task uuid, title text default null, body text default null, source text default '', owner uuid default null) returns uuid
language plpgsql set search_path = '' as $$
declare
  uid uuid := coalesce((select auth.uid()), slipbox_from_task.owner);
  t public.tasks;
  nid uuid;
begin
  select * into t from public.tasks x where x.id = slipbox_from_task.task and x.user_id = uid;
  if t.id is null then raise exception 'Action not found.'; end if;
  insert into public.slipbox_notes (user_id, title, body, source, kind, from_task_id)
    values (uid, left(coalesce(nullif(trim(slipbox_from_task.title), ''), t.title), 300), coalesce(slipbox_from_task.body, t.notes, ''), coalesce(slipbox_from_task.source, ''), 'fleeting', t.id)
    returning id into nid;
  update public.tasks x set dropped_at = coalesce(x.dropped_at, now()) where x.id = t.id;
  return nid;
end $$;

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
  if it.kind = 'task' and decision not in ('keep', 'someday', 'done', 'drop', 'skip', 'reading', 'slipbox') then raise exception 'For an action: keep, someday, done, drop, skip, reading or slipbox.'; end if;
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

  -- The reading list (up next, parked in Someday) or the slipbox (a fleeting note; the action is dropped).
  if decision = 'reading' then
    select jsonb_build_array(jsonb_build_object('t', 'reading', 'id', x.id, 'reading_state', x.reading_state, 'reading_type', x.reading_type, 'updated_at', x.updated_at,
      'someday_added', not exists (select 1 from public.task_tags y join public.tags g on g.id = y.tag_id where y.task_id = x.id and g.parent_id is null and g.name ~* '^someday')))
      into prev from public.tasks x where x.id = any(ids);
    perform public.reading_set(ids[1], 'up_next', null, uid);
    n := 1;
  elsif decision = 'slipbox' then
    insert into public.slipbox_notes (user_id, title, body, source, kind, from_task_id)
      select uid, left(x.title, 300), coalesce(x.notes, ''), '', 'fleeting', x.id from public.tasks x where x.id = any(ids) returning id into someday;
    select jsonb_build_array(jsonb_build_object('t', 'slipbox', 'note', someday, 'id', x.id, 'dropped_at', x.dropped_at, 'updated_at', x.updated_at))
      into prev from public.tasks x where x.id = any(ids);
    update public.tasks x set dropped_at = now_ts where x.id = any(ids);
    n := 1;
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
    elsif e->>'t' = 'fields' then
      update public.tasks t set title = e->>'title', gain = coalesce(e->>'gain', ''), gain_by = e->>'gain_by', project_id = (e->>'project_id')::uuid,
        in_inbox = (e->>'in_inbox')::boolean, planned_at = (e->>'planned_at')::timestamptz, due_at = (e->>'due_at')::timestamptz,
        defer_at = (e->>'defer_at')::timestamptz, flagged = (e->>'flagged')::boolean, updated_at = coalesce((e->>'updated_at')::timestamptz, t.updated_at)
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

revoke execute on function public.reading_set(uuid, text, text, uuid) from public, anon;
grant execute on function public.reading_set(uuid, text, text, uuid) to authenticated, service_role;
revoke execute on function public.slipbox_from_task(uuid, text, text, text, uuid) from public, anon;
grant execute on function public.slipbox_from_task(uuid, text, text, text, uuid) to authenticated, service_role;
