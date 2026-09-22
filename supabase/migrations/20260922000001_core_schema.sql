-- Core GTD schema: folders > projects > tasks (with subtasks), hierarchical tags.
-- Every row is owned by one user; RLS limits all access to the owner.

create table public.folders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  sort double precision not null default 0,
  created_at timestamptz not null default now()
);

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  folder_id uuid references public.folders(id) on delete set null,
  name text not null,
  notes text not null default '',
  status text not null default 'active' check (status in ('active','on_hold','completed','dropped')),
  kind text not null default 'parallel' check (kind in ('parallel','sequential','single_actions')),
  review_every_days int not null default 7,
  next_review_at timestamptz,
  sort double precision not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.tags (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  parent_id uuid references public.tags(id) on delete cascade,
  name text not null,
  sort double precision not null default 0,
  created_at timestamptz not null default now()
);

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,
  parent_id uuid references public.tasks(id) on delete cascade,
  in_inbox boolean not null default true,
  title text not null,
  notes text not null default '',
  flagged boolean not null default false,
  defer_at timestamptz,
  due_at timestamptz,
  completed_at timestamptz,
  dropped_at timestamptz,
  source text not null default 'app',
  sort double precision not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.task_tags (
  task_id uuid not null references public.tasks(id) on delete cascade,
  tag_id uuid not null references public.tags(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  primary key (task_id, tag_id)
);

create index on public.folders (user_id);
create index on public.projects (user_id);
create index on public.projects (folder_id);
create index on public.tags (user_id);
create index on public.tags (parent_id);
create index on public.tasks (user_id) where completed_at is null and dropped_at is null;
create index on public.tasks (project_id);
create index on public.tasks (parent_id);
create index on public.task_tags (tag_id);
create index on public.task_tags (user_id);

create or replace function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin new.updated_at = now(); return new; end $$;

create trigger tasks_touch before update on public.tasks
  for each row execute function public.touch_updated_at();
create trigger projects_touch before update on public.projects
  for each row execute function public.touch_updated_at();

do $$
declare t text;
begin
  foreach t in array array['folders','projects','tags','tasks','task_tags'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format($p$create policy "owner select" on public.%I for select to authenticated using ((select auth.uid()) = user_id)$p$, t);
    execute format($p$create policy "owner insert" on public.%I for insert to authenticated with check ((select auth.uid()) = user_id)$p$, t);
    execute format($p$create policy "owner update" on public.%I for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id)$p$, t);
    execute format($p$create policy "owner delete" on public.%I for delete to authenticated using ((select auth.uid()) = user_id)$p$, t);
  end loop;
end $$;
