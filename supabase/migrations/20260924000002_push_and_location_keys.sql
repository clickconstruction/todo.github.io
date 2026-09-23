-- Background location alerts: devices subscribe to Web Push, and an iPhone Shortcuts
-- automation calls mcp.todotooling.com/geo with a location key. Location keys are
-- api_tokens with scope 'geo': they can trigger alerts and nothing else (no MCP access).

alter table public.api_tokens
  add column scope text not null default 'full' check (scope in ('full', 'geo'));

create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  device text not null default '',
  created_at timestamptz not null default now()
);
create index on public.push_subscriptions (user_id);

-- A subscription is a device registration, not user data: removing one is allowed.
alter table public.push_subscriptions enable row level security;
create policy "owner select" on public.push_subscriptions for select to authenticated using ((select auth.uid()) = user_id);
create policy "owner insert" on public.push_subscriptions for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "owner delete" on public.push_subscriptions for delete to authenticated using ((select auth.uid()) = user_id);
