-- Addresses allowed to email tasks into a user's Inbox via inbox@todotooling.com.
create table public.email_senders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  email text not null,
  created_at timestamptz not null default now(),
  constraint email_senders_email_lower check (email = lower(email)),
  constraint email_senders_email_unique unique (email)
);
create index on public.email_senders (user_id);

alter table public.email_senders enable row level security;
create policy "owner select" on public.email_senders for select to authenticated using ((select auth.uid()) = user_id);
create policy "owner insert" on public.email_senders for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "owner delete" on public.email_senders for delete to authenticated using ((select auth.uid()) = user_id);

-- Seed each existing user's own sign-in address.
insert into public.email_senders (user_id, email)
select id, lower(email) from auth.users where email is not null
on conflict (email) do nothing;
