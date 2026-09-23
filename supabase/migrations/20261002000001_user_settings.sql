-- Settings that belong to the account (so the app, the MCP server, templates and imports agree):
--   due_minutes / defer_minutes / planned_minutes  the time of day a plain date lands at
--                                                  (minutes after midnight; defaults 5pm, midnight, 9am)
--   forecast_tag_id                                actions with this tag always show in Today
--   timezone                                       the user's zone (the app keeps it current)
create table public.user_settings (
  user_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  due_minutes int not null default 1020 check (due_minutes between 0 and 1439),
  defer_minutes int not null default 0 check (defer_minutes between 0 and 1439),
  planned_minutes int not null default 540 check (planned_minutes between 0 and 1439),
  forecast_tag_id uuid references public.tags(id) on delete set null,
  timezone text check (timezone is null or length(timezone) between 1 and 64),
  updated_at timestamptz not null default now()
);
alter table public.user_settings enable row level security;
create policy "owner select" on public.user_settings for select to authenticated using ((select auth.uid()) = user_id);
create policy "owner insert" on public.user_settings for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "owner update" on public.user_settings for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create trigger user_settings_touch before update on public.user_settings for each row execute function public.touch_updated_at();

-- A day offset from the anchor date at a time of day (minutes after midnight), in the user's zone.
create or replace function public.template_at(anchor date, off jsonb, minutes int, tz text) returns timestamptz
language sql immutable set search_path = '' as $$
  select case when off is null or jsonb_typeof(off) <> 'number' then null
              else ((anchor + (off::text)::numeric::int)::timestamp + make_interval(mins => minutes)) at time zone tz end
$$;

-- Templates use the account's default times.
create or replace function public.template_actions(actions jsonb, project uuid, parent uuid, depth int, anchor date, tz text, uid uuid)
returns int language plpgsql set search_path = '' as $$
declare
  a jsonb;
  i bigint;
  tid uuid;
  n int := 0;
  s public.user_settings;
begin
  select * into s from public.user_settings x where x.user_id = uid;
  if actions is null or jsonb_typeof(actions) <> 'array' then return 0; end if;
  for a, i in select value, ordinality from jsonb_array_elements(actions) with ordinality loop
    if coalesce(trim(a->>'title'), '') = '' then continue; end if;
    insert into public.tasks (user_id, title, notes, project_id, parent_id, in_inbox, flagged, estimate_minutes, steps_in_order,
                              defer_at, planned_at, due_at, sort, source)
    values (uid, left(a->>'title', 1000), coalesce(a->>'notes', ''), project, parent, false, coalesce((a->>'flagged')::boolean, false),
            case when (a->>'estimate_minutes') ~ '^\d+$' and (a->>'estimate_minutes')::int <= 100000 then (a->>'estimate_minutes')::int end,
            coalesce((a->>'steps_in_order')::boolean, false),
            public.template_at(anchor, a->'defer', coalesce(s.defer_minutes, 0), tz), public.template_at(anchor, a->'planned', coalesce(s.planned_minutes, 540), tz),
            public.template_at(anchor, a->'due', coalesce(s.due_minutes, 1020), tz),
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
  s public.user_settings;
begin
  if uid is null then raise exception 'Sign in first.'; end if;
  if (select auth.uid()) is not null and owner is not null and owner <> (select auth.uid()) then raise exception 'Not allowed.'; end if;
  select * into t from public.project_templates x where x.id = create_from_template.template and x.user_id = uid and x.archived_at is null;
  if t.id is null then raise exception 'Template not found.'; end if;
  select * into s from public.user_settings x where x.user_id = uid;
  tz := coalesce(nullif(nullif(tz, ''), 'UTC'), s.timezone, 'UTC'); -- 'UTC' is the parameter's default: prefer the saved zone
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
          public.template_at(d, b->'project_defer', coalesce(s.defer_minutes, 0), tz), public.template_at(d, b->'project_planned', coalesce(s.planned_minutes, 540), tz),
          public.template_at(d, b->'project_due', coalesce(s.due_minutes, 1020), tz),
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

