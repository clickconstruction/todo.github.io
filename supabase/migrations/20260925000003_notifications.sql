-- Custom notifications (reminders) on actions and projects.
--   kind 'at'             at a specific moment (at)
--   kind 'before_due'     offset_minutes before the due date (0 = at due time)
--   kind 'before_planned' offset_minutes before the planned date
--   kind 'at_defer'       when it becomes available (defer date)
-- fire_at is derived and follows the item's dates; moving a date re-arms the reminder.
-- The MCP Worker's cron sends due reminders as Web Push (sent_at records delivery).
-- A reminder is a setting on an item, not the item itself, so removing one is allowed.

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  task_id uuid references public.tasks(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  kind text not null check (kind in ('at', 'before_due', 'before_planned', 'at_defer')),
  offset_minutes int not null default 0 check (offset_minutes between 0 and 525600),
  at timestamptz,
  fire_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  check ((task_id is null) <> (project_id is null)),
  check (kind <> 'at' or at is not null)
);
create index on public.notifications (user_id);
create index on public.notifications (task_id) where task_id is not null;
create index on public.notifications (project_id) where project_id is not null;
create index notifications_due_idx on public.notifications (fire_at) where sent_at is null;

alter table public.notifications enable row level security;
create policy "owner select" on public.notifications for select to authenticated using ((select auth.uid()) = user_id);
create policy "owner insert" on public.notifications for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "owner update" on public.notifications for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "owner delete" on public.notifications for delete to authenticated using ((select auth.uid()) = user_id);

-- Compute fire_at from the item's dates; re-arm (clear sent_at) when it moves.
create or replace function public.notifications_fire_at() returns trigger
language plpgsql set search_path = '' as $$
declare
  d_due timestamptz; d_planned timestamptz; d_defer timestamptz; owner uuid; fire timestamptz;
begin
  if new.task_id is not null then
    select due_at, planned_at, defer_at, user_id into d_due, d_planned, d_defer, owner from public.tasks where id = new.task_id;
  else
    select due_at, planned_at, defer_at, user_id into d_due, d_planned, d_defer, owner from public.projects where id = new.project_id;
  end if;
  if owner is distinct from new.user_id then raise exception 'Item not found.' using errcode = 'foreign_key_violation'; end if;
  fire := case new.kind
    when 'at' then new.at
    when 'before_due' then d_due - make_interval(mins => new.offset_minutes)
    when 'before_planned' then d_planned - make_interval(mins => new.offset_minutes)
    else d_defer end;
  if tg_op = 'UPDATE' and fire is distinct from old.fire_at then new.sent_at := null; end if;
  new.fire_at := fire;
  return new;
end $$;

create trigger notifications_fire_at before insert or update on public.notifications
  for each row execute function public.notifications_fire_at();

-- When an item's dates change, recompute its reminders.
create or replace function public.rearm_notifications() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_table_name = 'tasks' then
    update public.notifications set kind = kind where task_id = new.id;
  else
    update public.notifications set kind = kind where project_id = new.id;
  end if;
  return null;
end $$;

create trigger tasks_rearm_notifications after update of due_at, planned_at, defer_at on public.tasks
  for each row execute function public.rearm_notifications();
create trigger projects_rearm_notifications after update of due_at, planned_at, defer_at on public.projects
  for each row execute function public.rearm_notifications();

-- Repeating items bring their reminders along (absolute times move with the dates).
create or replace function public.repeat_clone_task(t public.tasks, shift interval, new_parent uuid, new_project uuid, rule jsonb) returns uuid
language plpgsql set search_path = '' as $$
declare new_id uuid := gen_random_uuid();
begin
  insert into public.tasks (id, user_id, project_id, parent_id, in_inbox, title, notes, flagged, defer_at, planned_at, due_at,
                            estimate_minutes, place_id, location_trigger, location_radius_m, sort, source, repeat_rule)
  values (new_id, t.user_id, new_project, new_parent, t.in_inbox, t.title, t.notes, t.flagged,
          t.defer_at + shift, t.planned_at + shift, t.due_at + shift,
          t.estimate_minutes, t.place_id, t.location_trigger, t.location_radius_m, t.sort, 'repeat', rule);
  insert into public.task_tags (task_id, tag_id, user_id) select new_id, tag_id, user_id from public.task_tags where task_id = t.id;
  insert into public.notifications (user_id, task_id, kind, offset_minutes, at)
    select user_id, new_id, kind, offset_minutes, at + coalesce(shift, interval '0') from public.notifications where task_id = t.id;
  return new_id;
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
  map jsonb := '{}';
  new_tid uuid;
begin
  if new.repeat_rule is null or new.status <> 'completed' or old.status = 'completed' then return null; end if;
  if pg_trigger_depth() > 4 then return null; end if;
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
      new_tid := public.repeat_clone_task(t, shift, null, new_pid, t.repeat_rule);
      map := map || jsonb_build_object(t.id::text, new_tid);
    end loop;
    for t in select * from public.tasks where project_id = new.id and parent_id is not null and dropped_at is null order by sort loop
      if map ? t.parent_id::text then
        perform public.repeat_clone_task(t, shift, (map->>t.parent_id::text)::uuid, new_pid, t.repeat_rule);
      end if;
    end loop;
  end if;
  update public.projects set repeat_rule = null where id = new.id;
  return null;
end $$;

