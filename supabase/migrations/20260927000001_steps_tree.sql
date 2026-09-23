-- Steps ("eat the elephant"): any action can be broken into steps, and steps into steps,
-- up to 4 levels. The database keeps the tree sound for every client (app, MCP, email):
--   * a step always lives in its parent's project (moving the parent moves the whole tree)
--   * no loops (a task can't sit under its own step), max depth 4
--   * steps_in_order: only the first open step is available ("do in order")
--   * group rules (complete with last step, close steps with the group) work at every level
--   * repeating tasks and projects copy the whole tree of steps
--   * convert_to_project(): a task whose steps became a project of their own

alter table public.tasks add column steps_in_order boolean not null default false;

-- ---------- tree guard ----------
create or replace function public.tasks_tree_guard() returns trigger
language plpgsql set search_path = '' as $$
declare
  p public.tasks;
  cur uuid;
  parent_depth int := 1;
  below int := 0;
begin
  if new.parent_id is null then return new; end if;
  if new.parent_id = new.id then
    raise exception 'A task can’t be a step of itself.' using errcode = 'check_violation';
  end if;
  select * into p from public.tasks where id = new.parent_id;
  if p.id is null or p.user_id <> new.user_id then
    raise exception 'Parent task not found.' using errcode = 'foreign_key_violation';
  end if;
  -- Walk up from the parent: count its depth, and refuse a loop back to this task.
  cur := p.parent_id;
  while cur is not null loop
    if cur = new.id then
      raise exception 'A task can’t be a step of one of its own steps.' using errcode = 'check_violation';
    end if;
    parent_depth := parent_depth + 1;
    select parent_id into cur from public.tasks where id = cur;
    exit when parent_depth > 10;
  end loop;
  -- How deep this task's own steps go (when moving an existing task).
  if tg_op = 'UPDATE' then
    with recursive sub(id, d) as (
      select id, 1 from public.tasks where parent_id = new.id
      union all
      select t.id, s.d + 1 from public.tasks t join sub s on t.parent_id = s.id where s.d < 10
    ) select coalesce(max(d), 0) into below from sub;
  end if;
  if parent_depth + 1 + below > 4 then
    raise exception 'Steps can go 4 levels deep. Turn the big step into a project instead.' using errcode = 'check_violation';
  end if;
  new.project_id := p.project_id; -- steps live where their parent lives
  new.in_inbox := false;          -- the parent carries the step into (or out of) the Inbox
  return new;
end $$;

create trigger tasks_tree_guard before insert or update of parent_id, project_id on public.tasks
  for each row execute function public.tasks_tree_guard();

-- Moving a task to another project (or out of one) takes its steps along, all the way down.
create or replace function public.tasks_tree_follow() returns trigger
language plpgsql set search_path = '' as $$
begin
  update public.tasks set project_id = new.project_id
   where parent_id = new.id and project_id is distinct from new.project_id;
  return null;
end $$;

create trigger tasks_tree_follow after update of project_id on public.tasks
  for each row execute function public.tasks_tree_follow();

-- Group rules cascade one level per trigger; allow the full depth.
create or replace function public.tasks_group_rules() returns trigger
language plpgsql set search_path = '' as $$
declare
  was_open boolean := tg_op = 'INSERT' or (old.completed_at is null and old.dropped_at is null);
  is_open boolean := new.completed_at is null and new.dropped_at is null;
begin
  if pg_trigger_depth() > 16 then return null; end if;
  if was_open and not is_open then
    update public.tasks c
       set completed_at = coalesce(c.completed_at, new.completed_at),
           dropped_at = case when new.completed_at is null then coalesce(c.dropped_at, new.dropped_at) else c.dropped_at end
     where c.parent_id = new.id and c.completed_at is null and c.dropped_at is null;
  end if;
  if new.parent_id is not null then
    if not is_open and not exists (
         select 1 from public.tasks s where s.parent_id = new.parent_id and s.completed_at is null and s.dropped_at is null)
       and exists (select 1 from public.tasks s where s.parent_id = new.parent_id and s.completed_at is not null) then
      update public.tasks p set completed_at = now()
       where p.id = new.parent_id and p.completed_at is null and p.dropped_at is null;
    elsif is_open then
      update public.tasks p set completed_at = null
       where p.id = new.parent_id and p.completed_at is not null;
    end if;
  end if;
  return null;
end $$;

-- ---------- repeat: copy the whole tree ----------
create or replace function public.repeat_clone_task(t public.tasks, shift interval, new_parent uuid, new_project uuid, rule jsonb) returns uuid
language plpgsql set search_path = '' as $$
declare new_id uuid := gen_random_uuid();
begin
  insert into public.tasks (id, user_id, project_id, parent_id, in_inbox, title, notes, flagged, defer_at, planned_at, due_at,
                            estimate_minutes, place_id, location_trigger, location_radius_m, sort, source, repeat_rule, steps_in_order)
  values (new_id, t.user_id, new_project, new_parent, t.in_inbox, t.title, t.notes, t.flagged,
          t.defer_at + shift, t.planned_at + shift, t.due_at + shift,
          t.estimate_minutes, t.place_id, t.location_trigger, t.location_radius_m, t.sort, 'repeat', rule, t.steps_in_order);
  insert into public.task_tags (task_id, tag_id, user_id) select new_id, tag_id, user_id from public.task_tags where task_id = t.id;
  insert into public.notifications (user_id, task_id, kind, offset_minutes, at)
    select user_id, new_id, kind, offset_minutes, at + coalesce(shift, interval '0') from public.notifications where task_id = t.id;
  return new_id;
end $$;

create or replace function public.repeat_clone_steps(src uuid, dst uuid, shift interval, dst_project uuid) returns void
language plpgsql set search_path = '' as $$
declare c public.tasks; nid uuid;
begin
  for c in select * from public.tasks where parent_id = src and dropped_at is null order by sort loop
    nid := public.repeat_clone_task(c, shift, dst, dst_project, c.repeat_rule);
    perform public.repeat_clone_steps(c.id, nid, shift, dst_project);
  end loop;
end $$;

create or replace function public.tasks_repeat() returns trigger
language plpgsql set search_path = '' as $$
declare
  anchor timestamptz := coalesce(new.due_at, new.planned_at, new.defer_at);
  nxt timestamptz;
  shift interval;
  rule jsonb;
  new_id uuid;
begin
  if new.repeat_rule is null or old.completed_at is not null or new.completed_at is null or new.dropped_at is not null then return null; end if;
  if pg_trigger_depth() > 16 then return null; end if;
  -- Closed because a repeating ancestor completed: that ancestor's copy already brings it back.
  if new.parent_id is not null and exists (select 1 from public.tasks p where p.id = new.parent_id and p.completed_at is not null) then
    update public.tasks set repeat_rule = null where id = new.id;
    return null;
  end if;
  nxt := public.repeat_next_anchor(new.repeat_rule, anchor, new.completed_at);
  if not public.repeat_ended(new.repeat_rule, nxt) then
    rule := jsonb_set(new.repeat_rule, '{n}', to_jsonb(coalesce((new.repeat_rule->>'n')::int, 1) + 1));
    shift := case when anchor is null then interval '0' else nxt - anchor end;
    new_id := public.repeat_clone_task(new, shift, new.parent_id, new.project_id, rule);
    if anchor is null then update public.tasks set defer_at = nxt where id = new_id; end if;
    perform public.repeat_clone_steps(new.id, new_id, shift, new.project_id);
  end if;
  update public.tasks set repeat_rule = null where id = new.id;
  return null;
end $$;

create or replace function public.projects_repeat() returns trigger
language plpgsql set search_path = '' as $$
declare
  anchor timestamptz := coalesce(new.due_at, new.planned_at, new.defer_at);
  nxt timestamptz;
  shift interval;
  rule jsonb;
  new_pid uuid := gen_random_uuid();
  t public.tasks;
  nid uuid;
begin
  if new.repeat_rule is null or new.status <> 'completed' or old.status = 'completed' then return null; end if;
  if pg_trigger_depth() > 16 then return null; end if;
  nxt := public.repeat_next_anchor(new.repeat_rule, anchor, coalesce(new.completed_at, now()));
  if not public.repeat_ended(new.repeat_rule, nxt) then
    rule := jsonb_set(new.repeat_rule, '{n}', to_jsonb(coalesce((new.repeat_rule->>'n')::int, 1) + 1));
    shift := nxt - coalesce(anchor, new.created_at);
    insert into public.projects (id, user_id, folder_id, name, notes, status, kind, complete_with_last, flagged, review_every, review_unit,
                                 defer_at, planned_at, due_at, estimate_minutes, place_id, location_trigger, location_radius_m, sort, repeat_rule)
    values (new_pid, new.user_id, new.folder_id, new.name, new.notes, 'active', new.kind, new.complete_with_last, new.flagged, new.review_every, new.review_unit,
            case when anchor is null then nxt else new.defer_at + shift end, new.planned_at + shift, new.due_at + shift,
            new.estimate_minutes, new.place_id, new.location_trigger, new.location_radius_m, new.sort, rule);
    insert into public.project_tags (project_id, tag_id, user_id) select new_pid, tag_id, user_id from public.project_tags where project_id = new.id;
    insert into public.notifications (user_id, project_id, kind, offset_minutes, at)
      select user_id, new_pid, kind, offset_minutes, at + shift from public.notifications where project_id = new.id;
    for t in select * from public.tasks where project_id = new.id and parent_id is null and dropped_at is null order by sort loop
      nid := public.repeat_clone_task(t, shift, null, new_pid, t.repeat_rule);
      perform public.repeat_clone_steps(t.id, nid, shift, new_pid);
    end loop;
  end if;
  update public.projects set repeat_rule = null where id = new.id;
  return null;
end $$;

-- ---------- convert a task with steps into a project ----------
-- The steps become the project's actions (their own steps come along); the task is dropped with
-- a note pointing at the new project, since nothing is ever deleted. Returns the project id.
create or replace function public.convert_to_project(task_id uuid, owner uuid default null) returns uuid
language plpgsql set search_path = '' as $$
declare
  t public.tasks;
  pid uuid := gen_random_uuid();
  folder uuid;
begin
  -- Columns are qualified: the parameter is also called task_id.
  select * into t from public.tasks x where x.id = convert_to_project.task_id and x.user_id = coalesce((select auth.uid()), convert_to_project.owner);
  if t.id is null then raise exception 'Task not found.'; end if;
  if t.completed_at is not null or t.dropped_at is not null then raise exception 'Only open tasks can become projects.'; end if;
  select p.folder_id into folder from public.projects p where p.id = t.project_id;
  insert into public.projects (id, user_id, folder_id, name, notes, kind, flagged, defer_at, planned_at, due_at, estimate_minutes,
                               place_id, location_trigger, location_radius_m, sort)
  values (pid, t.user_id, folder, t.title, t.notes, case when t.steps_in_order then 'sequential' else 'parallel' end, t.flagged,
          t.defer_at, t.planned_at, t.due_at, t.estimate_minutes, t.place_id, t.location_trigger, t.location_radius_m,
          coalesce((select max(p.sort) + 1 from public.projects p where p.user_id = t.user_id), 0));
  insert into public.project_tags (project_id, tag_id, user_id) select pid, x.tag_id, x.user_id from public.task_tags x where x.task_id = t.id;
  update public.tasks x set parent_id = null, project_id = pid where x.parent_id = t.id;
  update public.tasks x set dropped_at = now(), completion_note = 'Became the project “' || t.title || '”' where x.id = t.id;
  return pid;
end $$;
revoke execute on function public.convert_to_project(uuid, uuid) from public, anon;
grant execute on function public.convert_to_project(uuid, uuid) to authenticated, service_role;
revoke execute on function public.repeat_clone_steps(uuid, uuid, interval, uuid) from public, anon;
