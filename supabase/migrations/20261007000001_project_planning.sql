-- Plan it: the Natural Planning Model for a project (purpose, principles, outcome, brainstorm,
-- organize, next actions).
--   * projects.purpose / principles: why, and the boundaries it must stay within.
--   * projects.plan: the plan in progress (so it can be finished later or on another device):
--       { mode: quick|full, step, ideas: [{id, text, bucket}], groups: [{id, name, in_order}],
--         next: {"project"|groupId: ideaId}, applied: {at, task_ids, reference_ids} }
--     bucket: null (not sorted) | action | someday | reference | drop | g:<group id>
--   * apply_project_plan(): creates everything in one transaction (groups become action groups with
--     steps, someday ideas get the on-hold Someday tag, reference ideas become reference items).
--   * undo_project_plan(): drops those actions and archives those reference items (never deletes).

alter table public.projects
  add column purpose text not null default '' check (length(purpose) <= 5000),
  add column principles text not null default '' check (length(principles) <= 5000),
  add column plan jsonb check (plan is null or (jsonb_typeof(plan) = 'object' and length(plan::text) <= 200000));

create or replace function public.apply_project_plan(project uuid, owner uuid default null) returns jsonb
language plpgsql set search_path = '' as $$
declare
  p public.projects;
  uid uuid;
  pl jsonb;
  g jsonb;
  i jsonb;
  gid uuid;
  tid uuid;
  rid uuid;
  base double precision;
  n int;
  someday uuid;
  nxt text;
  task_ids uuid[] := '{}';
  ref_ids uuid[] := '{}';
  target text;
begin
  uid := coalesce((select auth.uid()), apply_project_plan.owner);
  select * into p from public.projects x where x.id = apply_project_plan.project and x.user_id = uid;
  if p.id is null then raise exception 'Project not found.'; end if;
  if p.status not in ('active', 'on_hold') then raise exception 'Only active or on-hold projects can be planned.'; end if;
  pl := coalesce(p.plan, '{}');
  if pl ? 'applied' then raise exception 'This plan was already created. Undo it first to create it again.'; end if;
  select coalesce(max(x.sort), -1) + 1 into base from public.tasks x where x.project_id = p.id and x.parent_id is null;

  -- Loose actions first (the chosen next action leads), then each group with its steps.
  nxt := pl #>> '{next,project}';
  n := 0;
  for i in select e.value from jsonb_array_elements(coalesce(pl->'ideas', '[]')) with ordinality e(value, o)
           where coalesce(e.value->>'bucket', 'action') in ('action', '') or e.value->>'bucket' is null
           order by coalesce(e.value->>'id' = nxt, false) desc, e.o loop
    if length(trim(coalesce(i->>'text', ''))) = 0 then continue; end if;
    insert into public.tasks (user_id, title, project_id, in_inbox, sort, source)
      values (uid, left(trim(i->>'text'), 500), p.id, false, base + n, 'app') returning id into tid;
    task_ids := task_ids || tid; n := n + 1;
  end loop;

  for g in select e.value from jsonb_array_elements(coalesce(pl->'groups', '[]')) with ordinality e(value, o) order by e.o loop
    target := 'g:' || (g->>'id');
    if not exists (select 1 from jsonb_array_elements(coalesce(pl->'ideas', '[]')) e where e->>'bucket' = target) then continue; end if;
    insert into public.tasks (user_id, title, project_id, in_inbox, sort, steps_in_order, source)
      values (uid, left(trim(coalesce(g->>'name', 'Group')), 500), p.id, false, base + n, coalesce((g->>'in_order')::boolean, false), 'app') returning id into gid;
    task_ids := task_ids || gid; n := n + 1;
    nxt := pl->'next'->>(g->>'id');
    for i in select e.value from jsonb_array_elements(coalesce(pl->'ideas', '[]')) with ordinality e(value, o)
             where e.value->>'bucket' = target order by coalesce(e.value->>'id' = nxt, false) desc, e.o loop
      insert into public.tasks (user_id, title, project_id, parent_id, in_inbox, sort, source)
        values (uid, left(trim(i->>'text'), 500), p.id, gid, false, (select coalesce(max(x.sort), -1) + 1 from public.tasks x where x.parent_id = gid), 'app') returning id into tid;
      task_ids := task_ids || tid;
    end loop;
  end loop;

  -- Someday: in the project, parked by the on-hold Someday tag.
  if exists (select 1 from jsonb_array_elements(coalesce(pl->'ideas', '[]')) e where e->>'bucket' = 'someday') then
    select t.id into someday from public.tags t where t.user_id = uid and t.parent_id is null and t.name ~* '^someday' limit 1;
    if someday is null then
      insert into public.tags (user_id, name, status) values (uid, 'Someday', 'on_hold') returning id into someday;
    else
      update public.tags set status = 'on_hold' where id = someday and status <> 'on_hold';
    end if;
    for i in select e.value from jsonb_array_elements(pl->'ideas') with ordinality e(value, o) where e.value->>'bucket' = 'someday' order by e.o loop
      insert into public.tasks (user_id, title, project_id, in_inbox, sort, source)
        values (uid, left(trim(i->>'text'), 500), p.id, false, base + n, 'app') returning id into tid;
      insert into public.task_tags (task_id, tag_id, user_id) values (tid, someday, uid);
      task_ids := task_ids || tid; n := n + 1;
    end loop;
  end if;

  -- Reference: filed as the project's support material.
  for i in select e.value from jsonb_array_elements(coalesce(pl->'ideas', '[]')) with ordinality e(value, o) where e.value->>'bucket' = 'reference' order by e.o loop
    insert into public.reference_items (user_id, title, topic, project_id) values (uid, left(trim(i->>'text'), 300), left(p.name, 200), p.id) returning id into rid;
    ref_ids := ref_ids || rid;
  end loop;

  update public.projects x set plan = pl || jsonb_build_object('applied', jsonb_build_object('at', now(), 'task_ids', to_jsonb(task_ids), 'reference_ids', to_jsonb(ref_ids)))
    where x.id = p.id;
  return jsonb_build_object('tasks', coalesce(array_length(task_ids, 1), 0), 'references', coalesce(array_length(ref_ids, 1), 0), 'task_ids', to_jsonb(task_ids), 'reference_ids', to_jsonb(ref_ids));
end $$;

create or replace function public.undo_project_plan(project uuid, owner uuid default null) returns jsonb
language plpgsql set search_path = '' as $$
declare
  p public.projects;
  uid uuid;
  a jsonb;
  dropped int;
  archived int;
begin
  uid := coalesce((select auth.uid()), undo_project_plan.owner);
  select * into p from public.projects x where x.id = undo_project_plan.project and x.user_id = uid;
  if p.id is null then raise exception 'Project not found.'; end if;
  a := p.plan->'applied';
  if a is null then raise exception 'Nothing to undo.'; end if;
  update public.tasks t set dropped_at = now()
    where t.user_id = uid and t.id in (select (jsonb_array_elements_text(a->'task_ids'))::uuid) and t.completed_at is null and t.dropped_at is null;
  get diagnostics dropped = row_count;
  update public.reference_items r set archived_at = now()
    where r.user_id = uid and r.id in (select (jsonb_array_elements_text(a->'reference_ids'))::uuid) and r.archived_at is null;
  get diagnostics archived = row_count;
  update public.projects x set plan = p.plan - 'applied' where x.id = p.id;
  return jsonb_build_object('tasks_dropped', dropped, 'references_archived', archived);
end $$;

revoke execute on function public.apply_project_plan(uuid, uuid) from public, anon;
grant execute on function public.apply_project_plan(uuid, uuid) to authenticated, service_role;
revoke execute on function public.undo_project_plan(uuid, uuid) from public, anon;
grant execute on function public.undo_project_plan(uuid, uuid) to authenticated, service_role;
