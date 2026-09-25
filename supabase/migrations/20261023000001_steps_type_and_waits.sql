-- Cards with steps get the same choices as projects, and any card can wait for another card.
--
-- Steps type: parallel (default), in order (steps_in_order, as before) or single actions
-- (steps_single: a bucket of separate actions that never completes on its own). The two flags are
-- exclusive; whichever was set last wins.
-- complete_with_last: finishing the last step completes the card (the old behaviour, still the
-- default). Off, the card stays open for you to check off yourself.
--
-- Waits for: task_waits links a card to the cards it waits for (any project). It isn't available
-- until every one of them is completed or dropped. When the last one closes, on_unblock = 'forecast'
-- (the default) plans the card for today so it shows in Forecast.

alter table public.tasks
  add column if not exists steps_single boolean not null default false,
  add column if not exists complete_with_last boolean not null default true,
  add column if not exists on_unblock text not null default 'forecast' check (on_unblock in ('forecast', 'none'));

create or replace function public.tasks_steps_kind() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.steps_single and new.steps_in_order then
    if tg_op = 'UPDATE' and new.steps_in_order and not old.steps_in_order then new.steps_single := false;
    else new.steps_in_order := false; end if;
  end if;
  return new;
end $$;
create trigger tasks_steps_kind before insert or update of steps_single, steps_in_order on public.tasks
  for each row execute function public.tasks_steps_kind();

-- Group rules: a card completes with its last step only if it's set to, and never as a bucket.
create or replace function public.tasks_group_rules() returns trigger
language plpgsql set search_path = '' as $$
declare
  was_open boolean := tg_op = 'INSERT' or (old.completed_at is null and old.dropped_at is null);
  is_open boolean := new.completed_at is null and new.dropped_at is null;
begin
  if pg_trigger_depth() > 16 then return null; end if;
  if coalesce(current_setting('app.importing', true), '') = 'on' then return null; end if;
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
       where p.id = new.parent_id and p.completed_at is null and p.dropped_at is null
         and p.complete_with_last and not p.steps_single;
    elsif is_open then
      update public.tasks p set completed_at = null
       where p.id = new.parent_id and p.completed_at is not null;
    end if;
  end if;
  return null;
end $$;

-- ---------- waits for ----------
create table public.task_waits (
  task_id uuid not null references public.tasks(id) on delete cascade,
  waits_for uuid not null references public.tasks(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (task_id, waits_for),
  check (task_id <> waits_for)
);
create index on public.task_waits (waits_for);
create index on public.task_waits (user_id);
alter table public.task_waits enable row level security;
create policy "owner select" on public.task_waits for select to authenticated using ((select auth.uid()) = user_id);
create policy "owner insert" on public.task_waits for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "owner delete" on public.task_waits for delete to authenticated using ((select auth.uid()) = user_id);

-- Both cards are yours; no loops (A waits for B waits for A); a card can't wait for one of its own
-- steps or for a card it's a step of (it could never finish).
create or replace function public.task_waits_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if not exists (select 1 from public.tasks t where t.id = new.task_id and t.user_id = new.user_id)
     or not exists (select 1 from public.tasks t where t.id = new.waits_for and t.user_id = new.user_id) then
    raise exception 'Task not found.';
  end if;
  if exists (
    with recursive chain(id) as (
      select w.waits_for from public.task_waits w where w.task_id = new.waits_for
      union select w.waits_for from public.task_waits w join chain c on w.task_id = c.id)
    select 1 from chain where id = new.task_id) then
    raise exception 'That would make a loop: those cards would wait for each other.';
  end if;
  if exists (
    with recursive up(id) as (select parent_id from public.tasks where id = new.task_id
      union select t.parent_id from public.tasks t join up on t.id = up.id where t.parent_id is not null)
    select 1 from up where id = new.waits_for)
  or exists (
    with recursive up(id) as (select parent_id from public.tasks where id = new.waits_for
      union select t.parent_id from public.tasks t join up on t.id = up.id where t.parent_id is not null)
    select 1 from up where id = new.task_id) then
    raise exception 'A card can’t wait for one of its own steps, or for the card it’s a step of.';
  end if;
  return new;
end $$;
create trigger task_waits_guard before insert on public.task_waits
  for each row execute function public.task_waits_guard();

-- When a card closes, the cards waiting only for it (and set to) are planned for today.
create or replace function public.tasks_unblock() returns trigger
language plpgsql set search_path = '' as $$
begin
  if coalesce(current_setting('app.importing', true), '') = 'on' then return null; end if;
  if (old.completed_at is null and old.dropped_at is null) and (new.completed_at is not null or new.dropped_at is not null) then
    update public.tasks w set planned_at = now()
     where w.id in (select x.task_id from public.task_waits x where x.waits_for = new.id)
       and w.completed_at is null and w.dropped_at is null and w.on_unblock = 'forecast'
       and (w.planned_at is null or w.planned_at > now())
       and not exists (select 1 from public.task_waits o join public.tasks b on b.id = o.waits_for
                        where o.task_id = w.id and b.completed_at is null and b.dropped_at is null);
  end if;
  return null;
end $$;
create trigger tasks_unblock after update of completed_at, dropped_at on public.tasks
  for each row execute function public.tasks_unblock();

-- ---------- keep the new settings when repeating and converting ----------
create or replace function public.repeat_clone_task(t public.tasks, shift interval, new_parent uuid, new_project uuid, rule jsonb)
returns uuid language plpgsql set search_path = '' as $$
declare new_id uuid := gen_random_uuid();
begin
  insert into public.tasks (id, user_id, project_id, parent_id, in_inbox, title, notes, flagged, defer_at, planned_at, due_at,
                            estimate_minutes, place_id, location_trigger, location_radius_m, sort, source, repeat_rule, steps_in_order,
                            energy, checklist_id, scheduled_at, scheduled_minutes, steps_single, complete_with_last, on_unblock)
  values (new_id, t.user_id, new_project, new_parent, t.in_inbox, t.title, t.notes, t.flagged,
          t.defer_at + shift, t.planned_at + shift, t.due_at + shift,
          t.estimate_minutes, t.place_id, t.location_trigger, t.location_radius_m, t.sort, 'repeat', rule, t.steps_in_order,
          t.energy, t.checklist_id, t.scheduled_at + shift, t.scheduled_minutes, t.steps_single, t.complete_with_last, t.on_unblock);
  insert into public.task_tags (task_id, tag_id, user_id) select new_id, tag_id, user_id from public.task_tags where task_id = t.id;
  insert into public.notifications (user_id, task_id, kind, offset_minutes, at)
    select user_id, new_id, kind, offset_minutes, at + coalesce(shift, interval '0') from public.notifications where task_id = t.id;
  return new_id;
end $$;

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
  insert into public.projects (id, user_id, folder_id, name, notes, kind, complete_with_last, flagged, defer_at, planned_at, due_at, estimate_minutes,
                               place_id, location_trigger, location_radius_m, sort)
  values (pid, t.user_id, folder, t.title, t.notes,
          case when t.steps_single then 'single_actions' when t.steps_in_order then 'sequential' else 'parallel' end,
          t.complete_with_last and not t.steps_single, t.flagged,
          t.defer_at, t.planned_at, t.due_at, t.estimate_minutes, t.place_id, t.location_trigger, t.location_radius_m,
          coalesce((select max(p.sort) + 1 from public.projects p where p.user_id = t.user_id), 0));
  insert into public.project_tags (project_id, tag_id, user_id) select pid, x.tag_id, x.user_id from public.task_tags x where x.task_id = t.id;
  update public.tasks x set parent_id = null, project_id = pid where x.parent_id = t.id;
  update public.tasks x set dropped_at = now(), completion_note = 'Became the project “' || t.title || '”' where x.id = t.id;
  return pid;
end $$;
revoke execute on function public.convert_to_project(uuid, uuid) from public, anon;
grant execute on function public.convert_to_project(uuid, uuid) to authenticated, service_role;
revoke execute on function public.task_waits_guard() from public, anon, authenticated;
revoke execute on function public.tasks_unblock() from public, anon, authenticated;
revoke execute on function public.tasks_steps_kind() from public, anon, authenticated;
