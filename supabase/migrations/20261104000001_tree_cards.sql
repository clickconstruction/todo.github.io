-- Tech tree: a card (an action or a step) can be what a goal or project requires. "Sometimes it's a little
-- card that needs to be done that opens up a whole other project." Finishing the card unlocks what waits on it.
-- Only the requirement can be a card: cards wait on other cards through "Waits for" (task_waits) already.
-- A project can't require a card inside itself: on hold, it would hide the very card that opens it.
alter table public.tree_links drop constraint tree_links_requires_kind_check;
alter table public.tree_links add constraint tree_links_requires_kind_check check (requires_kind in ('goal', 'project', 'task'));

create or replace function public.tree_node_owned(kind text, id uuid, owner uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select case kind when 'goal' then exists (select 1 from public.goals g where g.id = tree_node_owned.id and g.user_id = owner)
                   when 'project' then exists (select 1 from public.projects p where p.id = tree_node_owned.id and p.user_id = owner)
                   when 'task' then exists (select 1 from public.tasks t where t.id = tree_node_owned.id and t.user_id = owner)
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
    raise exception 'That goal, project or card isn''t yours.' using errcode = 'foreign_key_violation';
  end if;
  if new.node_kind = new.requires_kind and new.node_id = new.requires_id then
    raise exception 'A goal or project can''t require itself.' using errcode = 'check_violation';
  end if;
  if new.requires_kind = 'task' and new.node_kind = 'project'
     and exists (select 1 from public.tasks t where t.id = new.requires_id and t.project_id = new.node_id) then
    raise exception 'A project can''t require a card inside itself: on hold, it would hide the card that opens it.' using errcode = 'check_violation';
  end if;
  -- Would what it requires rest, somewhere down the chain, on the node itself? A card rests on its project.
  with recursive down(kind, id, depth) as (
    select new.requires_kind, new.requires_id, 0
    union
    select x.kind, x.id, d.depth + 1 from down d
      cross join lateral (
        select l.requires_kind as kind, l.requires_id as id from public.tree_links l
         where l.node_kind = d.kind and l.node_id = d.id and l.user_id = new.user_id
           and l.archived_at is null and l.requires_id is not null and l.id <> new.id
        union all
        select 'project', t.project_id from public.tasks t where d.kind = 'task' and t.id = d.id and t.project_id is not null
      ) x
     where d.depth < 50)
  select exists (select 1 from down where kind = new.node_kind and id = new.node_id) into loops;
  if loops then raise exception 'That would make a loop: it already rests on this one.' using errcode = 'check_violation'; end if;
  return new;
end $$;
