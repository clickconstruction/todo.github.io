-- OmniFocus import. The app (and the MCP server) turn an OmniFocus export into one payload
-- (js/omnifocus-import.js); import_omnifocus() saves it in a single transaction:
--   * every item keeps its OmniFocus id in external_ref, so importing again skips what's here
--   * folders and tags with the same name as yours are merged, not duplicated
--   * dry_run = true returns the exact counts and saves nothing (the preview)
--   * each import is a batch that undo_import() can take back (dropped/archived, never deleted)

create table public.imports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  source text not null default 'omnifocus',
  counts jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  undone_at timestamptz
);
create index on public.imports (user_id);
alter table public.imports enable row level security;
create policy "owner select" on public.imports for select to authenticated using ((select auth.uid()) = user_id);
create policy "owner insert" on public.imports for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "owner update" on public.imports for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create trigger imports_no_delete before delete on public.imports for each row execute function public.forbid_delete();

alter table public.folders add column external_ref text, add column import_id uuid references public.imports(id);
alter table public.tags add column external_ref text, add column import_id uuid references public.imports(id);
alter table public.projects add column external_ref text, add column import_id uuid references public.imports(id);
alter table public.tasks add column external_ref text, add column import_id uuid references public.imports(id);
create unique index folders_external_ref on public.folders (user_id, external_ref) where external_ref is not null;
create unique index tags_external_ref on public.tags (user_id, external_ref) where external_ref is not null;
create unique index projects_external_ref on public.projects (user_id, external_ref) where external_ref is not null;
create unique index tasks_external_ref on public.tasks (user_id, external_ref) where external_ref is not null;
create index tasks_import_id on public.tasks (import_id) where import_id is not null;
create index projects_import_id on public.projects (import_id) where import_id is not null;
create index folders_import_id on public.folders (import_id) where import_id is not null;
create index tags_import_id on public.tags (import_id) where import_id is not null;

-- While importing, items arrive with their final state (a completed step under an open task is
-- normal in OmniFocus), so the group rules stand aside.
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
       where p.id = new.parent_id and p.completed_at is null and p.dropped_at is null;
    elsif is_open then
      update public.tasks p set completed_at = null
       where p.id = new.parent_id and p.completed_at is not null;
    end if;
  end if;
  return null;
end $$;

create or replace function public.import_omnifocus(payload jsonb, dry_run boolean default false, owner uuid default null)
returns jsonb language plpgsql set search_path = '' as $$
declare
  uid uuid := coalesce((select auth.uid()), owner);
  imp uuid := gen_random_uuid();
  d int;
  n int;
  c jsonb := '{}'::jsonb;
begin
  if uid is null then raise exception 'Sign in first.'; end if;
  if (select auth.uid()) is not null and owner is not null and owner <> (select auth.uid()) then raise exception 'Not allowed.'; end if;
  if jsonb_typeof(payload) <> 'object' then raise exception 'Nothing to import.'; end if;
  perform set_config('app.importing', 'on', true);
  begin
    insert into public.imports (id, user_id, source) values (imp, uid, coalesce(payload->>'source', 'omnifocus'));

    -- Folders: same ref → already here; same name as one of yours → merge; else create.
    update public.folders f set external_ref = x.ref
      from jsonb_to_recordset(coalesce(payload->'folders', '[]')) as x(ref text, name text)
     where f.user_id = uid and f.external_ref is null and f.archived_at is null and lower(f.name) = lower(x.name)
       and not exists (select 1 from public.folders g where g.user_id = uid and g.external_ref = x.ref);
    get diagnostics n = row_count; c := c || jsonb_build_object('folders_merged', n);
    insert into public.folders (user_id, name, sort, external_ref, import_id, created_at)
      select uid, left(x.name, 200), 1000 + coalesce(x.sort, 0), x.ref, imp, coalesce(x.created_at, now())
        from jsonb_to_recordset(coalesce(payload->'folders', '[]')) as x(ref text, name text, sort float8, created_at timestamptz)
       where x.ref is not null and not exists (select 1 from public.folders g where g.user_id = uid and g.external_ref = x.ref);
    get diagnostics n = row_count; c := c || jsonb_build_object('folders', n);

    -- Tags, parents first: merge by name under the same parent, else create.
    c := c || '{"tags": 0, "tags_merged": 0}';
    for d in 1..8 loop
      update public.tags t set external_ref = x.ref
        from jsonb_to_recordset(coalesce(payload->'tags', '[]')) as x(ref text, name text, parent_ref text, depth int)
       where x.depth = d and t.user_id = uid and t.external_ref is null and lower(t.name) = lower(x.name)
         and t.parent_id is not distinct from (select p.id from public.tags p where p.user_id = uid and p.external_ref = x.parent_ref)
         and not exists (select 1 from public.tags g where g.user_id = uid and g.external_ref = x.ref);
      get diagnostics n = row_count; c := jsonb_set(c, '{tags_merged}', to_jsonb((c->>'tags_merged')::int + n));
      insert into public.tags (user_id, name, parent_id, sort, external_ref, import_id)
        select uid, left(x.name, 200), (select p.id from public.tags p where p.user_id = uid and p.external_ref = x.parent_ref), 1000 + coalesce(x.sort, 0), x.ref, imp
          from jsonb_to_recordset(coalesce(payload->'tags', '[]')) as x(ref text, name text, parent_ref text, depth int, sort float8)
         where x.depth = d and x.ref is not null and not exists (select 1 from public.tags g where g.user_id = uid and g.external_ref = x.ref);
      get diagnostics n = row_count; c := jsonb_set(c, '{tags}', to_jsonb((c->>'tags')::int + n));
    end loop;

    -- Projects.
    select count(*) into n from jsonb_to_recordset(coalesce(payload->'projects', '[]')) as x(ref text)
     where exists (select 1 from public.projects g where g.user_id = uid and g.external_ref = x.ref);
    c := c || jsonb_build_object('projects_skipped', n);
    insert into public.projects (user_id, name, notes, folder_id, status, kind, complete_with_last, flagged, defer_at, planned_at, due_at,
                                 estimate_minutes, repeat_rule, review_every, review_unit, last_reviewed_at, next_review_at, completed_at,
                                 sort, external_ref, import_id, created_at, updated_at)
      select uid, left(coalesce(nullif(x.name, ''), 'Untitled project'), 500), coalesce(x.notes, ''),
             (select f.id from public.folders f where f.user_id = uid and f.external_ref = x.folder_ref),
             case when x.status in ('active', 'on_hold', 'completed', 'dropped') then x.status else 'active' end,
             case when x.kind in ('parallel', 'sequential', 'single_actions') then x.kind else 'parallel' end,
             coalesce(x.complete_with_last, false), coalesce(x.flagged, false), x.defer_at, x.planned_at, x.due_at,
             case when x.estimate_minutes between 0 and 100000 then x.estimate_minutes end, x.repeat_rule,
             greatest(1, least(999, coalesce(x.review_every, 1))), case when x.review_unit in ('day', 'week', 'month', 'year') then x.review_unit else 'week' end,
             x.last_reviewed_at, x.next_review_at, x.completed_at,
             1000 + coalesce(x.sort, 0), x.ref, imp, coalesce(x.created_at, now()), coalesce(x.updated_at, x.created_at, now())
        from jsonb_to_recordset(coalesce(payload->'projects', '[]')) as x(ref text, name text, notes text, folder_ref text, status text, kind text,
             complete_with_last boolean, flagged boolean, defer_at timestamptz, planned_at timestamptz, due_at timestamptz, estimate_minutes int,
             repeat_rule jsonb, review_every int, review_unit text, last_reviewed_at timestamptz, next_review_at timestamptz, completed_at timestamptz,
             sort float8, created_at timestamptz, updated_at timestamptz)
       where x.ref is not null and not exists (select 1 from public.projects g where g.user_id = uid and g.external_ref = x.ref);
    get diagnostics n = row_count; c := c || jsonb_build_object('projects', n);
    insert into public.project_tags (project_id, tag_id, user_id)
      select p.id, g.id, uid
        from jsonb_to_recordset(coalesce(payload->'projects', '[]')) as x(ref text, tag_refs jsonb)
        join public.projects p on p.user_id = uid and p.external_ref = x.ref and p.import_id = imp
        cross join lateral jsonb_array_elements_text(coalesce(x.tag_refs, '[]')) as r(ref)
        join public.tags g on g.user_id = uid and g.external_ref = r.ref
      on conflict do nothing;

    -- Actions, level by level (steps after the task they belong to).
    select count(*) into n from jsonb_to_recordset(coalesce(payload->'tasks', '[]')) as x(ref text)
     where exists (select 1 from public.tasks g where g.user_id = uid and g.external_ref = x.ref);
    c := c || jsonb_build_object('tasks_skipped', n, 'tasks', 0);
    for d in 1..4 loop
      insert into public.tasks (user_id, title, notes, project_id, parent_id, in_inbox, flagged, defer_at, planned_at, due_at, estimate_minutes,
                                repeat_rule, steps_in_order, completed_at, dropped_at, sort, source, external_ref, import_id, created_at, updated_at)
        select uid, left(coalesce(nullif(x.title, ''), 'Untitled'), 1000), coalesce(x.notes, ''),
               (select p.id from public.projects p where p.user_id = uid and p.external_ref = x.project_ref),
               (select t.id from public.tasks t where t.user_id = uid and t.external_ref = x.parent_ref),
               coalesce(x.in_inbox, false), coalesce(x.flagged, false), x.defer_at, x.planned_at, x.due_at,
               case when x.estimate_minutes between 0 and 100000 then x.estimate_minutes end, x.repeat_rule, coalesce(x.steps_in_order, false),
               x.completed_at, case when x.completed_at is null then x.dropped_at end,
               coalesce(x.sort, 0), 'omnifocus', x.ref, imp, coalesce(x.created_at, now()), coalesce(x.updated_at, x.created_at, now())
          from jsonb_to_recordset(coalesce(payload->'tasks', '[]')) as x(ref text, title text, notes text, project_ref text, parent_ref text, depth int,
               in_inbox boolean, flagged boolean, defer_at timestamptz, planned_at timestamptz, due_at timestamptz, estimate_minutes int, repeat_rule jsonb,
               steps_in_order boolean, completed_at timestamptz, dropped_at timestamptz, sort float8, created_at timestamptz, updated_at timestamptz)
         where coalesce(x.depth, 1) = d and x.ref is not null
           and not exists (select 1 from public.tasks g where g.user_id = uid and g.external_ref = x.ref);
      get diagnostics n = row_count; c := jsonb_set(c, '{tasks}', to_jsonb((c->>'tasks')::int + n));
    end loop;
    insert into public.task_tags (task_id, tag_id, user_id)
      select t.id, g.id, uid
        from jsonb_to_recordset(coalesce(payload->'tasks', '[]')) as x(ref text, tag_refs jsonb)
        join public.tasks t on t.user_id = uid and t.external_ref = x.ref and t.import_id = imp
        cross join lateral jsonb_array_elements_text(coalesce(x.tag_refs, '[]')) as r(ref)
        join public.tags g on g.user_id = uid and g.external_ref = r.ref
      on conflict do nothing;

    select count(*) into n from public.tasks where import_id = imp and completed_at is null and dropped_at is null;
    c := c || jsonb_build_object('open_tasks', n);
    select count(*) into n from public.tasks where import_id = imp and in_inbox and completed_at is null and dropped_at is null;
    c := c || jsonb_build_object('inbox', n);
    select count(*) into n from public.projects where import_id = imp and status in ('active', 'on_hold') and next_review_at <= now();
    c := c || jsonb_build_object('review_due', n);
    update public.imports set counts = c where id = imp;

    if dry_run then raise exception using errcode = 'TT001', message = 'dry run'; end if;
  exception when sqlstate 'TT001' then
    -- The preview: everything above is rolled back; the counts are kept.
    perform set_config('app.importing', 'off', true);
    return c || jsonb_build_object('dry_run', true);
  end;
  perform set_config('app.importing', 'off', true);
  return c || jsonb_build_object('import_id', imp, 'dry_run', false);
end $$;

-- Take back an import: its open actions are dropped, its projects dropped, its empty folders archived,
-- and their OmniFocus ids released so a later import brings them in again. Tags stay (they're shared).
create or replace function public.undo_import(batch uuid, owner uuid default null)
returns jsonb language plpgsql set search_path = '' as $$
declare
  uid uuid := coalesce((select auth.uid()), owner);
  n_tasks int; n_projects int; n_folders int;
begin
  if not exists (select 1 from public.imports i where i.id = batch and i.user_id = uid and i.undone_at is null) then
    raise exception 'Import not found or already undone.';
  end if;
  perform set_config('app.importing', 'on', true);
  update public.tasks t set dropped_at = coalesce(t.dropped_at, now())
   where t.user_id = uid and t.import_id = batch and t.completed_at is null and t.dropped_at is null;
  get diagnostics n_tasks = row_count;
  update public.tasks t set external_ref = null where t.user_id = uid and t.import_id = batch;
  update public.projects p set status = 'dropped' where p.user_id = uid and p.import_id = batch and p.status in ('active', 'on_hold');
  get diagnostics n_projects = row_count;
  update public.projects p set external_ref = null where p.user_id = uid and p.import_id = batch;
  update public.folders f set archived_at = now(), external_ref = null
   where f.user_id = uid and f.import_id = batch and f.archived_at is null
     and not exists (select 1 from public.projects p where p.folder_id = f.id and p.status in ('active', 'on_hold'));
  get diagnostics n_folders = row_count;
  update public.imports i set undone_at = now() where i.id = batch;
  perform set_config('app.importing', 'off', true);
  return jsonb_build_object('tasks_dropped', n_tasks, 'projects_dropped', n_projects, 'folders_archived', n_folders);
end $$;

revoke execute on function public.import_omnifocus(jsonb, boolean, uuid) from public, anon;
grant execute on function public.import_omnifocus(jsonb, boolean, uuid) to authenticated, service_role;
revoke execute on function public.undo_import(uuid, uuid) from public, anon;
grant execute on function public.undo_import(uuid, uuid) to authenticated, service_role;
