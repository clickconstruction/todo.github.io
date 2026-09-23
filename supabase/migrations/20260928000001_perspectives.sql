-- Custom perspectives: saved views built from rules. The rules are evaluated by one shared
-- engine (js/perspective-engine.js) in both the app and the MCP server, so they always agree.
--   rules:   {"v":1,"match":"all"|"any"|"none","rules":[ rule | group, … ]}
--   options: {"show":"available"|"remaining"|"completed"|"dropped"|"all",
--             "group_by":"none"|"project"|"folder"|"tag"|"due"|"flagged",
--             "sort_by":"project"|"due"|"planned"|"defer"|"added"|"changed"|"title"|"duration"|"completed",
--             "layout":"tree"|"flat"}
-- Never deleted: archive instead.

create table public.perspectives (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 100),
  icon text not null default '🔭' check (length(icon) <= 16),
  rules jsonb not null default '{"v":1,"match":"all","rules":[]}'::jsonb
    check (jsonb_typeof(rules) = 'object' and coalesce(jsonb_typeof(rules->'rules'), '') = 'array' and length(rules::text) <= 20000),
  options jsonb not null default '{"show":"available","group_by":"project","sort_by":"project","layout":"tree"}'::jsonb
    check (jsonb_typeof(options) = 'object'),
  badge boolean not null default false,
  sort double precision not null default 0,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.perspectives (user_id);
create unique index perspectives_name_unique on public.perspectives (user_id, lower(name)) where archived_at is null;

alter table public.perspectives enable row level security;
create policy "owner select" on public.perspectives for select to authenticated using ((select auth.uid()) = user_id);
create policy "owner insert" on public.perspectives for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "owner update" on public.perspectives for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

create trigger perspectives_touch before update on public.perspectives
  for each row execute function public.touch_updated_at();
create trigger perspectives_no_delete before delete on public.perspectives
  for each row execute function public.forbid_delete();
