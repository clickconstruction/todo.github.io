-- A whole project onto Reading & watching (e.g. OmniFocus "Movies", "Books"), in one step with one Undo.
--   * bulk_ops: one row per bulk change, with every touched row's previous values (archived, never deleted)
--   * reading_from_project(project, rtype, flag, owner): every open leaf action becomes a reading-list item
--       (up next, parked in Someday, out of the project and any group; flagged = flag, so a priority list
--       stays flagged), the group containers it leaves empty are completed, the project is completed, and
--       their cards leave any Full Review in progress (void) → {op_id, moved, containers}
--   * bulk_undo(op_id): puts all of it back
create table public.bulk_ops (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  op text not null,
  label text not null default '',
  changed int not null default 0,
  before jsonb not null default '{}',
  undone_at timestamptz,
  created_at timestamptz not null default now()
);
create index on public.bulk_ops (user_id, created_at desc);
alter table public.bulk_ops enable row level security;
create policy "owner select" on public.bulk_ops for select to authenticated using ((select auth.uid()) = user_id);
create policy "owner insert" on public.bulk_ops for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "owner update" on public.bulk_ops for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create trigger bulk_ops_no_delete before delete on public.bulk_ops for each row execute function public.forbid_delete();

create or replace function public.reading_from_project(project uuid, rtype text default null, flag boolean default false, owner uuid default null) returns jsonb
language plpgsql set search_path = '' as $$
declare
  uid uuid := coalesce((select auth.uid()), reading_from_project.owner);
  p public.projects;
  someday uuid;
  leaves uuid[];
  boxes uuid[];
  items jsonb;
  op uuid;
begin
  select * into p from public.projects x where x.id = reading_from_project.project and x.user_id = uid;
  if p.id is null then raise exception 'Project not found.'; end if;
  if rtype is not null and rtype not in ('book', 'article', 'video', 'podcast', 'other') then raise exception 'type: book, article, video, podcast or other.'; end if;
  leaves := array(select t.id from public.tasks t where t.project_id = p.id and t.user_id = uid and t.completed_at is null and t.dropped_at is null
                    and not exists (select 1 from public.tasks c where c.parent_id = t.id and c.completed_at is null and c.dropped_at is null));
  boxes := array(select t.id from public.tasks t where t.project_id = p.id and t.user_id = uid and t.completed_at is null and t.dropped_at is null and not (t.id = any(leaves)));
  select g.id into someday from public.tags g where g.user_id = uid and g.parent_id is null and g.name ~* '^someday' limit 1;
  if someday is null then insert into public.tags (user_id, name, status) values (uid, 'Someday', 'on_hold') returning id into someday;
  else update public.tags set status = 'on_hold' where id = someday and status <> 'on_hold'; end if;
  -- Full Review cards for these (task cards, and group cards made only of them), still pending
  items := coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'status', i.status)) from public.review_items i
    join public.review_sessions s on s.id = i.session_id and s.user_id = uid and s.status = 'active'
    where i.status in ('pending', 'skipped') and (i.task_id = any(leaves || boxes)
      or (i.kind = 'group' and not exists (select 1 from jsonb_array_elements_text(coalesce(i.grp->'task_ids', '[]')) x where not (x::uuid = any(leaves || boxes)))))), '[]');
  insert into public.bulk_ops (user_id, op, label, changed, before) values (uid, 'reading_from_project', p.name, cardinality(leaves), jsonb_build_object(
    'project', jsonb_build_object('id', p.id, 'status', p.status),
    'tag', someday,
    'tagged', to_jsonb(array(select x from unnest(leaves) x where not exists (select 1 from public.task_tags y where y.task_id = x and y.tag_id = someday))),
    'tasks', (select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'reading_state', t.reading_state, 'reading_type', t.reading_type, 'reading_url', t.reading_url,
                'flagged', t.flagged, 'project_id', t.project_id, 'parent_id', t.parent_id, 'in_inbox', t.in_inbox, 'completed_at', t.completed_at, 'updated_at', t.updated_at)), '[]')
              from public.tasks t where t.id = any(leaves || boxes)),
    'items', items)) returning id into op;
  perform set_config('app.importing', 'on', true); -- bulk: no per-row history for the tag links
  insert into public.task_tags (task_id, tag_id, user_id) select x, someday, uid from unnest(leaves) x
    where not exists (select 1 from public.task_tags y where y.task_id = x and y.tag_id = someday);
  perform set_config('app.importing', 'off', true);
  update public.tasks t set reading_state = 'up_next', reading_type = coalesce(rtype, t.reading_type, public.reading_guess(t.title)),
      reading_url = coalesce(t.reading_url, (regexp_match(t.title || ' ' || coalesce(t.notes, ''), 'https?://[^\s)>\]]+'))[1]),
      flagged = reading_from_project.flag, project_id = null, parent_id = null, in_inbox = false
    where t.id = any(leaves);
  update public.tasks t set completed_at = now() where t.id = any(boxes);
  update public.projects x set status = 'completed' where x.id = p.id;
  update public.review_items i set status = 'void' where i.id in (select (e->>'id')::uuid from jsonb_array_elements(items) e);
  return jsonb_build_object('op_id', op, 'moved', cardinality(leaves), 'containers', cardinality(boxes), 'review_cards', jsonb_array_length(items));
end $$;

create or replace function public.bulk_undo(op_id uuid, owner uuid default null) returns jsonb
language plpgsql set search_path = '' as $$
declare
  uid uuid := coalesce((select auth.uid()), bulk_undo.owner);
  o public.bulk_ops;
  e jsonb;
begin
  select * into o from public.bulk_ops b where b.id = bulk_undo.op_id and b.user_id = uid;
  if o.id is null then raise exception 'Nothing to undo.'; end if;
  if o.undone_at is not null then raise exception 'Already undone.'; end if;
  if o.op <> 'reading_from_project' then raise exception 'Unknown change.'; end if;
  perform set_config('app.keep_updated_at', 'on', true);
  update public.projects x set status = o.before->'project'->>'status' where x.id = (o.before->'project'->>'id')::uuid and x.user_id = uid;
  for e in select value from jsonb_array_elements(o.before->'tasks') loop
    update public.tasks t set reading_state = e->>'reading_state', reading_type = e->>'reading_type', reading_url = e->>'reading_url',
        flagged = (e->>'flagged')::boolean, project_id = (e->>'project_id')::uuid, parent_id = (e->>'parent_id')::uuid,
        in_inbox = (e->>'in_inbox')::boolean, completed_at = (e->>'completed_at')::timestamptz, updated_at = (e->>'updated_at')::timestamptz
      where t.id = (e->>'id')::uuid and t.user_id = uid;
  end loop;
  delete from public.task_tags y where y.user_id = uid and y.tag_id = (o.before->>'tag')::uuid
    and y.task_id in (select (jsonb_array_elements_text(o.before->'tagged'))::uuid);
  update public.review_items i set status = e2->>'status' from jsonb_array_elements(o.before->'items') e2 where i.id = (e2->>'id')::uuid;
  perform set_config('app.keep_updated_at', 'off', true);
  update public.bulk_ops set undone_at = now() where id = o.id;
  return jsonb_build_object('restored', o.changed);
end $$;

revoke execute on function public.reading_from_project(uuid, text, boolean, uuid) from public, anon;
revoke execute on function public.bulk_undo(uuid, uuid) from public, anon;
grant execute on function public.reading_from_project(uuid, text, boolean, uuid) to authenticated, service_role;
grant execute on function public.bulk_undo(uuid, uuid) to authenticated, service_role;
