-- "What can be done now", answered by the database: the ids of available open tasks (all of them, or
-- just those in only_ids). The same rules as js/availability.js and the MCP's availabilityOf/parkedOf:
--   open; not deferred, nor any open task it's a step of; its project (if found) is active and not
--   deferred; no open steps of its own; not a "single actions" bucket; not parked by an on-hold tag
--   (its own, a parent task's, or those tasks' projects'; a sub-tag of an on-hold tag is on hold; a
--   dropped tag anywhere up the chain holds nothing); not waiting on someone or on an agenda (directly
--   or through a person's tag); not waiting for another open card (its own links or a parent task's);
--   and not waiting its turn in an ordered container (a task with steps in order, or a sequential
--   project, at any level up the tree). Order within a container: sort, then created_at, then id.
-- Returns one array (not rows), so large answers aren't cut at the API's 1,000-row limit.
create or replace function public.available_task_ids(owner uuid, only_ids uuid[] default null, as_of timestamptz default now())
returns uuid[] language sql stable set search_path = '' as $$
with recursive
t as (select id, parent_id, project_id, sort, created_at, defer_at, steps_in_order, steps_single, waiting_on, agenda_for
        from public.tasks where user_id = owner and completed_at is null and dropped_at is null),
-- each asked-about task with itself (depth 0) and every open task above it
chain(id, node, depth) as (
  select id, id, 0 from t where only_ids is null or id = any(only_ids)
  union all
  select c.id, p.id, c.depth + 1 from chain c join t n on n.id = c.node join t p on p.id = n.parent_id where c.depth < 9),
tagchain(id, cur, depth) as (
  select id, id, 0 from public.tags where user_id = owner
  union all
  select tc.id, g.parent_id, tc.depth + 1 from tagchain tc join public.tags g on g.id = tc.cur where g.parent_id is not null and tc.depth < 7),
held as (select tc.id from tagchain tc join public.tags g on g.id = tc.cur group by tc.id
          having bool_or(g.status = 'on_hold') and not bool_or(g.status = 'dropped')),
-- per open task, once: each reason it (as a link in a chain) can block
node_held as (select l.task_id as id from public.task_tags l join held h on h.id = l.tag_id
              union select n.id from t n join public.project_tags l on l.project_id = n.project_id join held h on h.id = l.tag_id),
node_waits as (select distinct w.task_id as id from public.task_waits w join t b on b.id = w.waits_for),
first_child as (select distinct on (parent_id) parent_id, id from t where parent_id is not null
                 order by parent_id, coalesce(sort, 0), created_at, id),
first_top as (select distinct on (project_id) project_id, id from t where parent_id is null and project_id is not null
               order by project_id, coalesce(sort, 0), created_at, id),
node_turn as (select n.id from t n
               left join t p on p.id = n.parent_id
               left join first_child fc on fc.parent_id = p.id
               left join public.projects np on np.id = n.project_id
               left join first_top ft on ft.project_id = n.project_id
              where (p.id is not null and p.steps_in_order and fc.id <> n.id)
                 or (p.id is null and np.kind = 'sequential' and ft.id <> n.id)),
blocked as (select c.id,
                   bool_or(coalesce(n.defer_at > as_of, false)) as deferred,
                   bool_or(c.depth < 8 and nh.id is not null) as held,
                   bool_or(c.depth < 8 and nw.id is not null) as waits,
                   bool_or(nt.id is not null) as turn
              from chain c join t n on n.id = c.node
              left join node_held nh on nh.id = c.node
              left join node_waits nw on nw.id = c.node
              left join node_turn nt on nt.id = c.node
             group by c.id),
has_steps as (select distinct parent_id as id from t where parent_id is not null),
person_tagged as (select distinct l.task_id as id from public.task_tags l join public.people pp on pp.tag_id = l.tag_id
                   where pp.user_id = owner and pp.archived_at is null)
select coalesce(array_agg(x.id order by x.id), '{}') from t x
join blocked b on b.id = x.id
left join public.projects pr on pr.id = x.project_id
left join has_steps hs on hs.id = x.id
left join person_tagged pt on pt.id = x.id
where not x.steps_single
  and x.waiting_on is null and x.agenda_for is null
  and (pr.id is null or (pr.status = 'active' and (pr.defer_at is null or pr.defer_at <= as_of)))
  and hs.id is null and pt.id is null
  and not b.deferred and not b.held and not b.waits and not b.turn
$$;
revoke execute on function public.available_task_ids(uuid, uuid[], timestamptz) from public, anon, authenticated;
grant execute on function public.available_task_ids(uuid, uuid[], timestamptz) to service_role;
