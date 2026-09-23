-- Change history for actions and projects, and a delivery log for push notifications.
-- Both are append-only: users can read their rows; only database triggers and the server write.

-- ---------- push delivery log ----------
-- One row per send attempt (test, reminder, place alert). scheduled_for lets the app queue a
-- test ("in 1 minute") that the Worker's cron sends. results holds each device's HTTP status.
create table public.push_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  kind text not null check (kind in ('test', 'reminder', 'place')),
  title text not null default '',
  body text not null default '',
  task_id uuid references public.tasks(id) on delete set null,
  project_id uuid references public.projects(id) on delete set null,
  scheduled_for timestamptz,
  sent_at timestamptz,
  devices int not null default 0,
  delivered int not null default 0,
  results jsonb not null default '[]',
  created_at timestamptz not null default now()
);
create index on public.push_log (user_id, created_at desc);
create index on public.push_log (task_id) where task_id is not null;
create index push_log_pending_idx on public.push_log (scheduled_for) where sent_at is null and scheduled_for is not null;

alter table public.push_log enable row level security;
create policy "owner select" on public.push_log for select to authenticated using ((select auth.uid()) = user_id);
-- Users may only queue a test for themselves; everything else is written by the server.
create policy "owner queue test" on public.push_log for insert to authenticated
  with check ((select auth.uid()) = user_id and kind = 'test' and sent_at is null and delivered = 0 and results = '[]'
              and scheduled_for between now() - interval '1 minute' and now() + interval '1 hour');

-- ---------- item history ----------
create table public.item_history (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  task_id uuid references public.tasks(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  field text not null,
  old_value jsonb,
  new_value jsonb,
  source text not null default 'app' check (source in ('app', 'agent', 'automatic')),
  changed_at timestamptz not null default now()
);
create index on public.item_history (task_id, changed_at desc) where task_id is not null;
create index on public.item_history (project_id, changed_at desc) where project_id is not null;
create index on public.item_history (user_id);

alter table public.item_history enable row level security;
create policy "owner select" on public.item_history for select to authenticated using ((select auth.uid()) = user_id);

-- Who made a change: the signed-in app, the server (MCP agents, email capture), or a rule
-- reacting to another change (repeat, group completion, complete-with-last, re-arming).
create or replace function public.history_source() returns text
language sql stable set search_path = '' as $$
  select case
    when pg_trigger_depth() > 1 then 'automatic'
    when coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'role', '') = 'authenticated' then 'app'
    when coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'role', '') = 'service_role' then 'agent'
    else 'automatic' end
$$;

-- Long text is kept, but capped so one huge note doesn't bloat history.
create or replace function public.history_value(v jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select case when jsonb_typeof(v) = 'string' and length(v #>> '{}') > 4000 then to_jsonb(left(v #>> '{}', 4000) || '…') else v end
$$;

-- Log each listed column that changed. TG_ARGV = the columns to track.
create or replace function public.log_item_changes() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  o jsonb := to_jsonb(old);
  n jsonb := to_jsonb(new);
  col text;
  src text := public.history_source();
begin
  if not exists (select 1 from auth.users u where u.id = new.user_id) then return null; end if; -- account being deleted
  foreach col in array tg_argv loop
    if (o -> col) is distinct from (n -> col) then
      insert into public.item_history (user_id, task_id, project_id, field, old_value, new_value, source)
      values (new.user_id,
              case when tg_table_name = 'tasks' then new.id end,
              case when tg_table_name = 'projects' then new.id end,
              col, public.history_value(o -> col), public.history_value(n -> col), src);
    end if;
  end loop;
  return null;
end $$;

create trigger tasks_history after update on public.tasks for each row execute function public.log_item_changes(
  'title', 'notes', 'project_id', 'parent_id', 'flagged', 'defer_at', 'planned_at', 'due_at', 'estimate_minutes',
  'completed_at', 'dropped_at', 'completion_note', 'place_id', 'location_trigger', 'location_radius_m', 'repeat_rule');
create trigger projects_history after update on public.projects for each row execute function public.log_item_changes(
  'name', 'notes', 'status', 'kind', 'folder_id', 'flagged', 'complete_with_last', 'defer_at', 'planned_at', 'due_at',
  'estimate_minutes', 'review_every', 'review_unit', 'next_review_at', 'last_reviewed_at', 'completed_at',
  'place_id', 'location_trigger', 'location_radius_m', 'repeat_rule');

-- Creation, so history starts at the beginning.
create or replace function public.log_item_created() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  j jsonb := to_jsonb(new); -- projects have no source column, so read fields through jsonb
begin
  insert into public.item_history (user_id, task_id, project_id, field, new_value, source)
  values (new.user_id, case when tg_table_name = 'tasks' then new.id end, case when tg_table_name = 'projects' then new.id end,
          'created', to_jsonb(coalesce(j ->> 'title', j ->> 'name')),
          case when j ->> 'source' = 'repeat' then 'automatic'
               when j ->> 'source' in ('email', 'mcp') then 'agent' else public.history_source() end);
  return null;
end $$;
create trigger tasks_history_created after insert on public.tasks for each row execute function public.log_item_created();
create trigger projects_history_created after insert on public.projects for each row execute function public.log_item_created();

-- Notifications, tags and attachments: added / removed.
create or replace function public.log_related_changes() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  j jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  field text := tg_argv[0];
  val jsonb;
  removed boolean := tg_op = 'DELETE';
  owner uuid := (j ->> 'user_id')::uuid;
  task uuid := (j ->> 'task_id')::uuid;
  project uuid := (j ->> 'project_id')::uuid;
begin
  if field = 'notification' then
    if tg_op = 'UPDATE' then return null; end if; -- fire_at/sent_at bookkeeping isn't a user change
    val := jsonb_build_object('kind', j ->> 'kind', 'offset_minutes', (j ->> 'offset_minutes')::int, 'at', j -> 'at');
  elsif field = 'tag' then
    val := to_jsonb((select coalesce(p.name || ' : ', '') || t.name from public.tags t left join public.tags p on p.id = t.parent_id where t.id = (j ->> 'tag_id')::uuid));
  else -- attachment: added, or archived / restored
    if tg_op = 'UPDATE' then
      if (to_jsonb(old) -> 'archived_at') is not distinct from (j -> 'archived_at') then return null; end if;
      removed := (j ->> 'archived_at') is not null;
    end if;
    val := to_jsonb(j ->> 'name');
  end if;
  -- Skip while an account (or the item) is being deleted.
  if not exists (select 1 from auth.users u where u.id = owner)
     or (task is not null and not exists (select 1 from public.tasks where id = task))
     or (project is not null and not exists (select 1 from public.projects where id = project)) then return null; end if;
  insert into public.item_history (user_id, task_id, project_id, field, old_value, new_value, source)
  values (owner, task, project, field, case when removed then val end, case when not removed then val end, public.history_source());
  return null;
end $$;

create trigger notifications_history after insert or delete on public.notifications
  for each row execute function public.log_related_changes('notification');
create trigger task_tags_history after insert or delete on public.task_tags
  for each row execute function public.log_related_changes('tag');
create trigger project_tags_history after insert or delete on public.project_tags
  for each row execute function public.log_related_changes('tag');
create trigger attachments_history after insert or update of archived_at on public.attachments
  for each row execute function public.log_related_changes('attachment');

revoke execute on function public.log_item_changes() from public, anon, authenticated;
revoke execute on function public.log_item_created() from public, anon, authenticated;
revoke execute on function public.log_related_changes() from public, anon, authenticated;
