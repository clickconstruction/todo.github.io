-- Project templates: a project's shape saved as a document, stamped out as a real project with
-- blanks filled in and dates shifted. Kept apart from projects so a template's actions never
-- show up in lists, badges, search, reviews, alerts or the MCP (nothing to exclude anywhere).
--
-- body = { name, notes, kind, complete_with_last, flagged, review_every, review_unit, estimate_minutes,
--          tag_ids: [uuid], project_defer / project_planned / project_due: day offsets or null,
--          blanks: [{ name, default }],           «Name» in any text is replaced when creating
--          actions: [{ title, notes, tag_ids, flagged, estimate_minutes, defer, planned, due (day offsets),
--                      steps_in_order, steps: [ …same shape, up to 4 levels… ] }] }
-- Offsets are days from the date chosen when creating (the start, or the due date for templates
-- that count back from a deadline). Built-in blanks: «Date», «Month», «Year».
-- schedule = { every, unit: day|week|month|year, start: 'YYYY-MM-DD', tz } creates a project automatically.

create table public.project_templates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 200),
  icon text not null default '📋' check (length(icon) <= 16),
  folder_id uuid references public.folders(id),
  body jsonb not null default '{"actions":[]}'::jsonb
    check (jsonb_typeof(body) = 'object' and coalesce(jsonb_typeof(body->'actions'), '') = 'array' and length(body::text) <= 500000),
  schedule jsonb check (schedule is null or (jsonb_typeof(schedule) = 'object' and (schedule->>'unit') in ('day', 'week', 'month', 'year')
                                            and coalesce((schedule->>'every')::int, 0) between 1 and 999)),
  next_run_at timestamptz,
  last_run_at timestamptz,
  sort double precision not null default 0,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.project_templates (user_id);
create index project_templates_due on public.project_templates (next_run_at) where next_run_at is not null and archived_at is null;
alter table public.project_templates enable row level security;
create policy "owner select" on public.project_templates for select to authenticated using ((select auth.uid()) = user_id);
create policy "owner insert" on public.project_templates for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "owner update" on public.project_templates for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create trigger project_templates_touch before update on public.project_templates for each row execute function public.touch_updated_at();
create trigger project_templates_no_delete before delete on public.project_templates for each row execute function public.forbid_delete();

-- Projects remember the template they came from (for "Created from New job setup").
alter table public.projects add column template_id uuid references public.project_templates(id);

-- When a schedule is set or changed, work out the next run (6am local on the run day, never in the past).
create or replace function public.project_templates_schedule() returns trigger
language plpgsql set search_path = '' as $$
declare
  tz text;
  step interval;
  nxt timestamptz;
begin
  if new.schedule is null or new.archived_at is not null then new.next_run_at := null; return new; end if;
  if tg_op = 'UPDATE' and new.schedule is not distinct from old.schedule and new.next_run_at is not null
     and old.archived_at is not distinct from new.archived_at then return new; end if;
  tz := coalesce(new.schedule->>'tz', 'UTC');
  step := public.review_interval((new.schedule->>'every')::int, new.schedule->>'unit');
  nxt := (coalesce((new.schedule->>'start')::date, (now() at time zone tz)::date + 1)::timestamp + interval '6 hours') at time zone tz;
  while nxt <= now() loop nxt := ((nxt at time zone tz) + step) at time zone tz; end loop;
  new.next_run_at := nxt;
  return new;
end $$;
create trigger project_templates_schedule before insert or update on public.project_templates
  for each row execute function public.project_templates_schedule();

-- A day offset from the anchor date, at the usual hour for that kind of date, in the user's zone.
create or replace function public.template_date(anchor date, off jsonb, hour int, tz text) returns timestamptz
language sql immutable set search_path = '' as $$
  select case when off is null or jsonb_typeof(off) <> 'number' then null
              else ((anchor + (off::text)::numeric::int)::timestamp + make_interval(hours => hour)) at time zone tz end
$$;

create or replace function public.template_actions(actions jsonb, project uuid, parent uuid, depth int, anchor date, tz text, uid uuid)
returns int language plpgsql set search_path = '' as $$
declare
  a jsonb;
  i bigint;
  tid uuid;
  n int := 0;
begin
  if actions is null or jsonb_typeof(actions) <> 'array' then return 0; end if;
  for a, i in select value, ordinality from jsonb_array_elements(actions) with ordinality loop
    if coalesce(trim(a->>'title'), '') = '' then continue; end if;
    insert into public.tasks (user_id, title, notes, project_id, parent_id, in_inbox, flagged, estimate_minutes, steps_in_order,
                              defer_at, planned_at, due_at, sort, source)
    values (uid, left(a->>'title', 1000), coalesce(a->>'notes', ''), project, parent, false, coalesce((a->>'flagged')::boolean, false),
            case when (a->>'estimate_minutes') ~ '^\d+$' and (a->>'estimate_minutes')::int <= 100000 then (a->>'estimate_minutes')::int end,
            coalesce((a->>'steps_in_order')::boolean, false),
            public.template_date(anchor, a->'defer', 0, tz), public.template_date(anchor, a->'planned', 9, tz), public.template_date(anchor, a->'due', 17, tz),
            i - 1, 'template')
    returning id into tid;
    insert into public.task_tags (task_id, tag_id, user_id)
      select tid, g.id, uid from public.tags g
       where g.user_id = uid and g.id::text in (select jsonb_array_elements_text(coalesce(a->'tag_ids', '[]')))
      on conflict do nothing;
    n := n + 1;
    if depth < 4 then n := n + public.template_actions(a->'steps', project, tid, depth + 1, anchor, tz, uid); end if;
  end loop;
  return n;
end $$;

-- A value as it appears inside a JSON string (escaped, without the surrounding quotes).
create or replace function public.json_inner(v text) returns text
language sql immutable set search_path = '' as $$ select substr(to_jsonb(coalesce(v, ''))::text, 2, length(to_jsonb(coalesce(v, ''))::text) - 2) $$;

-- Create a project from a template. Returns the new project's id.
create or replace function public.create_from_template(template uuid, anchor date default null, vars jsonb default '{}'::jsonb,
                                                       name text default null, folder uuid default null, tz text default 'UTC', owner uuid default null)
returns uuid language plpgsql set search_path = '' as $$
declare
  uid uuid := coalesce((select auth.uid()), owner);
  t public.project_templates;
  d date;
  txt text;
  b jsonb;
  k text;
  v text;
  pid uuid := gen_random_uuid();
  blank jsonb;
begin
  if uid is null then raise exception 'Sign in first.'; end if;
  if (select auth.uid()) is not null and owner is not null and owner <> (select auth.uid()) then raise exception 'Not allowed.'; end if;
  select * into t from public.project_templates x where x.id = create_from_template.template and x.user_id = uid and x.archived_at is null;
  if t.id is null then raise exception 'Template not found.'; end if;
  tz := coalesce(nullif(tz, ''), 'UTC');
  d := coalesce(anchor, (now() at time zone tz)::date);
  -- Fill in the blanks: given values, then each blank's default, then the built-ins.
  txt := t.body::text;
  for blank in select value from jsonb_array_elements(coalesce(t.body->'blanks', '[]')) loop
    k := blank->>'name';
    v := coalesce(nullif(vars->>k, ''), blank->>'default', '');
    if k is not null then txt := replace(txt, '«' || k || '»', public.json_inner(v)); end if;
  end loop;
  for k, v in select key, value from jsonb_each_text(coalesce(vars, '{}')) loop
    txt := replace(txt, '«' || k || '»', public.json_inner(v));
  end loop;
  txt := replace(txt, '«Date»', to_char(d, 'Mon FMDD'));
  txt := replace(txt, '«Month»', trim(to_char(d, 'Month')));
  txt := replace(txt, '«Year»', to_char(d, 'YYYY'));
  b := txt::jsonb;

  insert into public.projects (id, user_id, name, notes, folder_id, status, kind, complete_with_last, flagged, estimate_minutes,
                               defer_at, planned_at, due_at, review_every, review_unit, sort, template_id)
  values (pid, uid, left(coalesce(nullif(trim(name), ''), nullif(trim(b->>'name'), ''), t.name), 500), coalesce(b->>'notes', ''),
          (select f.id from public.folders f where f.id = coalesce(folder, t.folder_id) and f.user_id = uid and f.archived_at is null),
          'active', case when b->>'kind' in ('parallel', 'sequential', 'single_actions') then b->>'kind' else 'parallel' end,
          coalesce((b->>'complete_with_last')::boolean, false), coalesce((b->>'flagged')::boolean, false),
          case when (b->>'estimate_minutes') ~ '^\d+$' and (b->>'estimate_minutes')::int <= 100000 then (b->>'estimate_minutes')::int end,
          public.template_date(d, b->'project_defer', 0, tz), public.template_date(d, b->'project_planned', 9, tz), public.template_date(d, b->'project_due', 17, tz),
          greatest(1, least(999, coalesce((b->>'review_every')::int, 1))), case when b->>'review_unit' in ('day', 'week', 'month', 'year') then b->>'review_unit' else 'week' end,
          coalesce((select max(p.sort) + 1 from public.projects p where p.user_id = uid), 0), t.id);
  insert into public.project_tags (project_id, tag_id, user_id)
    select pid, g.id, uid from public.tags g
     where g.user_id = uid and g.id::text in (select jsonb_array_elements_text(coalesce(b->'tag_ids', '[]')))
    on conflict do nothing;
  perform public.template_actions(b->'actions', pid, null, 1, d, tz, uid);
  update public.project_templates x set last_run_at = now() where x.id = t.id;
  return pid;
end $$;

-- Cron (the MCP Worker, every minute): create projects for scheduled templates whose time has come.
create or replace function public.run_template_schedules() returns int
language plpgsql set search_path = '' as $$
declare
  t public.project_templates;
  tz text;
  n int := 0;
  vars jsonb;
begin
  for t in select * from public.project_templates where next_run_at <= now() and archived_at is null and schedule is not null for update skip locked loop
    tz := coalesce(t.schedule->>'tz', 'UTC');
    select coalesce(jsonb_object_agg(b->>'name', coalesce(b->>'default', '')), '{}') into vars
      from jsonb_array_elements(coalesce(t.body->'blanks', '[]')) b where b->>'name' is not null;
    perform public.create_from_template(t.id, (t.next_run_at at time zone tz)::date, vars, null, null, tz, t.user_id);
    update public.project_templates x
       set next_run_at = (select min(s) from (select ((t.next_run_at at time zone tz) + public.review_interval((t.schedule->>'every')::int, t.schedule->>'unit') * g) at time zone tz as s
                                               from generate_series(1, 400) g) q where s > now())
     where x.id = t.id;
    n := n + 1;
  end loop;
  return n;
end $$;

revoke execute on function public.create_from_template(uuid, date, jsonb, text, uuid, text, uuid) from public, anon;
grant execute on function public.create_from_template(uuid, date, jsonb, text, uuid, text, uuid) to authenticated, service_role;
revoke execute on function public.template_actions(jsonb, uuid, uuid, int, date, text, uuid) from public, anon;
grant execute on function public.template_actions(jsonb, uuid, uuid, int, date, text, uuid) to authenticated, service_role;
revoke execute on function public.run_template_schedules() from public, anon, authenticated;
grant execute on function public.run_template_schedules() to service_role;
