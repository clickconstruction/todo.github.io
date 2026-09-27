-- Tech tree: goals and projects linked by what they require ("do certain things to unlock future things").
--   goals.kind   goal | milestone (a condition to tick, e.g. "Can afford to pay someone full time") |
--                destination (where a branch leads)
--   tree_links   node requires requirement; both are a goal or a project of the same owner.
--                state accepted | proposed (from Claude or found in the library: drawn, blocks nothing).
--                A proposed link may name its requirement by title only (requires_title): accepting it
--                finds or makes that milestone. Removing a link archives it; nothing is deleted.
-- The database keeps what must hold for the app and the MCP alike: the nodes are the owner's own, a node
-- can't require itself, and no chain of requirements leads back to where it started. Which nodes are open
-- or locked is worked out from the links (js/tree-rules.js, shared by the app and the Worker).
alter table public.goals add column kind text not null default 'goal' check (kind in ('goal', 'milestone', 'destination'));

create table public.tree_links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  node_kind text not null check (node_kind in ('goal', 'project')),
  node_id uuid not null,
  requires_kind text check (requires_kind in ('goal', 'project')),
  requires_id uuid,
  requires_title text check (char_length(requires_title) <= 300),
  state text not null default 'accepted' check (state in ('accepted', 'proposed')),
  proposed_by text not null default 'user' check (proposed_by in ('user', 'agent', 'app')),
  why text not null default '' check (char_length(why) <= 500),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((requires_id is not null and requires_kind is not null)
      or (state = 'proposed' and requires_id is null and length(trim(coalesce(requires_title, ''))) > 0))
);
create index on public.tree_links (user_id) where archived_at is null;
create unique index tree_links_once on public.tree_links (node_kind, node_id, requires_kind, requires_id) where archived_at is null and requires_id is not null;
alter table public.tree_links enable row level security;
create policy "owner select" on public.tree_links for select to authenticated using ((select auth.uid()) = user_id);
create policy "owner insert" on public.tree_links for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "owner update" on public.tree_links for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create trigger tree_links_touch before update on public.tree_links for each row execute function public.touch_updated_at();
create trigger tree_links_no_delete before delete on public.tree_links for each row execute function public.forbid_delete();

create or replace function public.tree_node_owned(kind text, id uuid, owner uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select case kind when 'goal' then exists (select 1 from public.goals g where g.id = tree_node_owned.id and g.user_id = owner)
                   when 'project' then exists (select 1 from public.projects p where p.id = tree_node_owned.id and p.user_id = owner)
                   else false end
$$;

create or replace function public.tree_links_guard() returns trigger language plpgsql security definer set search_path = '' as $$
declare loops boolean;
begin
  if new.archived_at is not null then return new; end if;
  if not public.tree_node_owned(new.node_kind, new.node_id, new.user_id) then
    raise exception 'That goal or project isn''t yours.' using errcode = 'foreign_key_violation';
  end if;
  if new.requires_id is null then return new; end if;
  if not public.tree_node_owned(new.requires_kind, new.requires_id, new.user_id) then
    raise exception 'That goal or project isn''t yours.' using errcode = 'foreign_key_violation';
  end if;
  if new.node_kind = new.requires_kind and new.node_id = new.requires_id then
    raise exception 'A goal or project can''t require itself.' using errcode = 'check_violation';
  end if;
  -- Would what it requires rest, somewhere down the chain, on the node itself?
  with recursive down(kind, id, depth) as (
    select new.requires_kind, new.requires_id, 0
    union
    select l.requires_kind, l.requires_id, d.depth + 1 from down d
      join public.tree_links l on l.node_kind = d.kind and l.node_id = d.id and l.user_id = new.user_id
       and l.archived_at is null and l.requires_id is not null and l.id <> new.id
     where d.depth < 50)
  select exists (select 1 from down where kind = new.node_kind and id = new.node_id) into loops;
  if loops then raise exception 'That would make a loop: it already rests on this one.' using errcode = 'check_violation'; end if;
  return new;
end $$;
create trigger tree_links_guard before insert or update on public.tree_links for each row execute function public.tree_links_guard();

-- Accept a proposed link. One that names its requirement by title finds that milestone (a goal of the same
-- title that isn't dropped) or makes it. → the link.
create or replace function public.tree_accept(link uuid, owner uuid default null) returns jsonb
language plpgsql set search_path = '' as $$
declare
  uid uuid := coalesce((select auth.uid()), tree_accept.owner);
  l public.tree_links;
  gid uuid;
  made boolean := false;
begin
  select * into l from public.tree_links x where x.id = tree_accept.link and x.user_id = uid and x.archived_at is null;
  if l.id is null then raise exception 'Link not found.'; end if;
  if l.requires_id is null then
    select g.id into gid from public.goals g where g.user_id = uid and lower(trim(g.title)) = lower(trim(l.requires_title)) and g.status <> 'dropped' order by g.created_at limit 1;
    if gid is null then
      insert into public.goals (user_id, title, kind) values (uid, left(trim(l.requires_title), 300), 'milestone') returning id into gid;
      made := true;
    end if;
    -- The same link may already be there, accepted: then this proposal is simply done with.
    if exists (select 1 from public.tree_links x where x.user_id = uid and x.archived_at is null and x.id <> l.id
               and x.node_kind = l.node_kind and x.node_id = l.node_id and x.requires_kind = 'goal' and x.requires_id = gid) then
      update public.tree_links x set archived_at = now() where x.id = l.id;
      return jsonb_build_object('id', l.id, 'already', true, 'requires_id', gid);
    end if;
    update public.tree_links x set requires_kind = 'goal', requires_id = gid, state = 'accepted' where x.id = l.id;
  else
    update public.tree_links x set state = 'accepted' where x.id = l.id;
  end if;
  return jsonb_build_object('id', l.id, 'requires_kind', coalesce(l.requires_kind, 'goal'), 'requires_id', coalesce(l.requires_id, gid), 'milestone_made', made);
end $$;
revoke execute on function public.tree_accept(uuid, uuid) from public, anon;
grant execute on function public.tree_accept(uuid, uuid) to authenticated, service_role;
revoke execute on function public.tree_node_owned(text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.tree_node_owned(text, uuid, uuid) to service_role;
