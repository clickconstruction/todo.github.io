-- Tag status, like OmniFocus:
--   active   the default
--   on_hold  parks the tag: actions carrying it (or one of its sub-tags, directly, through their
--            project, or through the task they're a step of) are not available anywhere
--   dropped  retires the tag: hidden from pickers and the Tags list; it stays on old actions and
--            doesn't block them
-- Availability is computed by the clients (js/availability.js, mirrored in mcp/src/index.js).
-- The OmniFocus import now brings tag status across.

alter table public.tags add column status text not null default 'active' check (status in ('active', 'on_hold', 'dropped'));

create or replace function public.import_omnifocus(payload jsonb, dry_run boolean default false, owner uuid default null, batch uuid default null)
returns jsonb language plpgsql set search_path = '' as $$
declare
  uid uuid := coalesce((select auth.uid()), owner);
  imp uuid := coalesce(batch, gen_random_uuid());
  d int;
  n int;
  c jsonb := '{}'::jsonb;
begin
  if uid is null then raise exception 'Sign in first.'; end if;
  if (select auth.uid()) is not null and owner is not null and owner <> (select auth.uid()) then raise exception 'Not allowed.'; end if;
  if jsonb_typeof(payload) <> 'object' then raise exception 'Nothing to import.'; end if;
  perform set_config('app.importing', 'on', true);
  begin
    if batch is null then
      insert into public.imports (id, user_id, source) values (imp, uid, coalesce(payload->>'source', 'omnifocus'));
    elsif dry_run or not exists (select 1 from public.imports i where i.id = batch and i.user_id = uid and i.undone_at is null) then
      raise exception 'Import not found (or it was undone).';
    end if;

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
      insert into public.tags (user_id, name, parent_id, sort, status, external_ref, import_id)
        select uid, left(x.name, 200), (select p.id from public.tags p where p.user_id = uid and p.external_ref = x.parent_ref), 1000 + coalesce(x.sort, 0),
               case when x.status in ('active', 'on_hold', 'dropped') then x.status else 'active' end, x.ref, imp
          from jsonb_to_recordset(coalesce(payload->'tags', '[]')) as x(ref text, name text, parent_ref text, depth int, sort float8, status text)
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

    -- This chunk's counts; the import keeps running totals across chunks.
    select count(*) into n from public.tasks where import_id = imp and completed_at is null and dropped_at is null;
    c := c || jsonb_build_object('open_tasks', n);
    select count(*) into n from public.tasks where import_id = imp and in_inbox and completed_at is null and dropped_at is null;
    c := c || jsonb_build_object('inbox', n);
    select count(*) into n from public.projects where import_id = imp and status in ('active', 'on_hold') and next_review_at <= now();
    c := c || jsonb_build_object('review_due', n);
    update public.imports i set counts = (
      select jsonb_object_agg(k, case when k in ('open_tasks', 'inbox', 'review_due') then (c->>k)::int
                                      else coalesce((i.counts->>k)::int, 0) + (c->>k)::int end)
        from jsonb_object_keys(c) as k)
     where i.id = imp;

    if dry_run then raise exception using errcode = 'TT001', message = 'dry run'; end if;
  exception when sqlstate 'TT001' then
    -- The preview: everything above is rolled back; the counts are kept.
    perform set_config('app.importing', 'off', true);
    return c || jsonb_build_object('dry_run', true);
  end;
  perform set_config('app.importing', 'off', true);
  return c || jsonb_build_object('import_id', imp, 'dry_run', false);
end $$;

