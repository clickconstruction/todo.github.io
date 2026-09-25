-- One read for everything the MCP's rules need: open tasks, tags, tag links, projects, people,
-- places and "waits for" links, as a single JSON object. A Cloudflare Worker gets 50 requests a call;
-- paging 8,000 tasks and 9,500 tag links 1,000 rows at a time used most of them.
-- Tasks come as a table ({cols, rows}): each column name once, not 8,000 times (4.5 MB instead of 11).
-- Rows are in id order, as the paged reads were. Only the MCP (service role) may call it.
-- If you add a column to tasks, add it here too (and to mcp/test.mjs's mirror).
create or replace function public.mcp_snapshot(owner uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'tasks', (select jsonb_build_object('cols', to_jsonb(array['id','project_id','parent_id','in_inbox','title','notes','flagged','defer_at','due_at','completed_at','dropped_at','source','sort','created_at','updated_at','completion_note','planned_at','estimate_minutes','place_id','location_trigger','location_radius_m','repeat_rule','steps_in_order','external_ref','import_id','energy','waiting_on','delegated_at','follow_up_at','agenda_for','tickler','reference_id','scheduled_at','scheduled_minutes','checklist_id','gain','gain_cost','gain_by','gain_met','clarify_skips','reading_type','reading_state','reading_url','reading_notes_done','important','folder_path','steps_single','complete_with_last','on_unblock']),
                                        'rows', coalesce(jsonb_agg(jsonb_build_array(t.id,t.project_id,t.parent_id,t.in_inbox,t.title,t.notes,t.flagged,t.defer_at,t.due_at,t.completed_at,t.dropped_at,t.source,t.sort,t.created_at,t.updated_at,t.completion_note,t.planned_at,t.estimate_minutes,t.place_id,t.location_trigger,t.location_radius_m,t.repeat_rule,t.steps_in_order,t.external_ref,t.import_id,t.energy,t.waiting_on,t.delegated_at,t.follow_up_at,t.agenda_for,t.tickler,t.reference_id,t.scheduled_at,t.scheduled_minutes,t.checklist_id,t.gain,t.gain_cost,t.gain_by,t.gain_met,t.clarify_skips,t.reading_type,t.reading_state,t.reading_url,t.reading_notes_done,t.important,t.folder_path,t.steps_single,t.complete_with_last,t.on_unblock) order by t.id), '[]'::jsonb))
                from public.tasks t where t.user_id = owner and t.completed_at is null and t.dropped_at is null),
    'tags', coalesce((select jsonb_agg(to_jsonb(g) order by g.id) from public.tags g where g.user_id = owner), '[]'::jsonb),
    'task_tags', coalesce((select jsonb_agg(jsonb_build_object('task_id', x.task_id, 'tag_id', x.tag_id) order by x.task_id, x.tag_id)
                            from public.task_tags x where x.user_id = owner), '[]'::jsonb),
    'project_tags', coalesce((select jsonb_agg(jsonb_build_object('project_id', x.project_id, 'tag_id', x.tag_id) order by x.project_id, x.tag_id)
                               from public.project_tags x where x.user_id = owner), '[]'::jsonb),
    'projects', coalesce((select jsonb_agg(to_jsonb(p) order by p.id) from public.projects p where p.user_id = owner), '[]'::jsonb),
    'people', coalesce((select jsonb_agg(to_jsonb(p) order by p.id) from public.people p where p.user_id = owner), '[]'::jsonb),
    'places', coalesce((select jsonb_agg(to_jsonb(p) order by p.id) from public.places p where p.user_id = owner), '[]'::jsonb),
    'task_waits', coalesce((select jsonb_agg(jsonb_build_object('task_id', w.task_id, 'waits_for', w.waits_for) order by w.task_id, w.waits_for)
                             from public.task_waits w where w.user_id = owner), '[]'::jsonb)
  );
$$;
revoke execute on function public.mcp_snapshot(uuid) from public, anon, authenticated;
grant execute on function public.mcp_snapshot(uuid) to service_role;
