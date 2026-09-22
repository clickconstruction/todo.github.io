-- Personal access tokens for agents (MCP server). Only a SHA-256 hash of each
-- token is stored; the plaintext is shown to the user once at creation.
create table public.api_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  token_hash text not null unique,
  token_hint text not null,
  last_used_at timestamptz,
  created_at timestamptz not null default now()
);
create index on public.api_tokens (user_id);

alter table public.api_tokens enable row level security;
create policy "owner select" on public.api_tokens for select to authenticated using ((select auth.uid()) = user_id);
create policy "owner insert" on public.api_tokens for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "owner delete" on public.api_tokens for delete to authenticated using ((select auth.uid()) = user_id);
