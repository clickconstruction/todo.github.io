-- task_family(): a task, all its steps (every level, open and closed) and the tasks it is part of, in one
-- query. The MCP get_task and break_down build the steps tree from it: Cloudflare allows a Worker 50
-- outgoing requests a call, and walking the tree a level or a parent at a time ran out on big tasks.
-- Security invoker: the caller's row rules apply; the service role passes owner.

create or replace function public.task_family(task_id uuid, owner uuid default null) returns setof public.tasks
language sql stable set search_path = '' as $$
  with recursive
  me as (select coalesce((select auth.uid()), task_family.owner) as uid),
  down (id, d) as (
    select t.id, 1 from public.tasks t, me where t.parent_id = task_family.task_id and t.user_id = me.uid
    union all
    select t.id, down.d + 1 from public.tasks t join down on t.parent_id = down.id, me where t.user_id = me.uid and down.d < 8
  ),
  up (id, parent_id, d) as (
    select t.id, t.parent_id, 0 from public.tasks t, me where t.id = task_family.task_id and t.user_id = me.uid
    union all
    select t.id, t.parent_id, up.d + 1 from public.tasks t join up on t.id = up.parent_id, me where t.user_id = me.uid and up.d < 8
  )
  select t.* from public.tasks t, me
  where t.user_id = me.uid and (t.id in (select id from down) or t.id in (select id from up))
$$;

revoke execute on function public.task_family(uuid, uuid) from public, anon;
grant execute on function public.task_family(uuid, uuid) to authenticated, service_role;
