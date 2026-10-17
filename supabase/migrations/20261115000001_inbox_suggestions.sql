-- Inbox suggestions: Claude proposes a clarify decision on an Inbox item and the user presses Submit in
-- Process Inbox (or asks Claude to). Nothing changes before that. The suggestion is Claude's, so it may be
-- replaced or dismissed; once the item is clarified it is stamped and kept, never pending again.
--   tasks.suggestion: {decision: next_action | done | delegate | project | someday | tickler | trash | reference | slipbox | reading,
--     project_id?, project_name?, tag_ids?, tag_labels?, planned?, flagged?, energy?   (next_action)
--     person_id?, person_name?, follow_up?                                              (delegate)
--     name?, first_action?  (project)   date? (tickler)   topic? (reference)   category? (someday)
--     title?, source? (slipbox)   type? (reading)
--     note?, by: 'agent', at, applied_at? (Submit), resolved_at? (dismissed, or clarified some other way)}
--   Pending = a decision and neither applied_at nor resolved_at. The words both sides show come from
--   js/inbox-suggestion.js; applying one goes through the same code as the user's own choices.
alter table public.tasks add column suggestion jsonb
  check (suggestion is null or (jsonb_typeof(suggestion) = 'object'
    and coalesce(suggestion->>'decision', '') in ('next_action','done','delegate','project','someday','tickler','trash','reference','slipbox','reading')));

-- inbox_suggest(items, owner): the pending suggestion on each of the owner's open Inbox items, in one call.
-- items: [{id, decision, ...fields, note}]. Anything that isn't the owner's open Inbox item, or has no valid
-- decision, is skipped and named. Returns {suggested: [ids], skipped: [{id, why}]}.
create or replace function public.inbox_suggest(p_items jsonb, owner uuid default null) returns jsonb
language plpgsql set search_path = '' as $$
declare
  uid uuid := coalesce((select auth.uid()), inbox_suggest.owner);
  it jsonb;
  tid uuid;
  t public.tasks;
  done uuid[] := '{}';
  skipped jsonb := '[]';
begin
  if uid is null then raise exception 'No user.'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then raise exception 'items must be a list.'; end if;
  for it in select * from jsonb_array_elements(p_items) loop
    begin tid := (it->>'id')::uuid; exception when others then tid := null; end;
    if tid is null then skipped := skipped || jsonb_build_object('id', it->>'id', 'why', 'not an id'); continue; end if;
    select * into t from public.tasks x where x.id = tid and x.user_id = uid;
    if t.id is null then skipped := skipped || jsonb_build_object('id', tid, 'why', 'not found'); continue; end if;
    if t.completed_at is not null or t.dropped_at is not null then skipped := skipped || jsonb_build_object('id', tid, 'why', 'closed'); continue; end if;
    if not t.in_inbox then skipped := skipped || jsonb_build_object('id', tid, 'why', 'not in the Inbox'); continue; end if;
    if coalesce(it->>'decision', '') not in ('next_action','done','delegate','project','someday','tickler','trash','reference','slipbox','reading') then
      skipped := skipped || jsonb_build_object('id', tid, 'why', 'no such decision'); continue;
    end if;
    update public.tasks x set suggestion = (it - 'id' - 'applied_at' - 'resolved_at' - 'by' - 'at') || jsonb_build_object('by', 'agent', 'at', now()) where x.id = t.id;
    done := done || t.id;
  end loop;
  return jsonb_build_object('suggested', to_jsonb(done), 'skipped', skipped);
end $$;
revoke execute on function public.inbox_suggest(jsonb, uuid) from public, anon;
grant execute on function public.inbox_suggest(jsonb, uuid) to authenticated, service_role;

-- Clarified some other way (it left the Inbox, or was completed or dropped) while a suggestion was still
-- pending: the suggestion is stamped resolved, so it is never pending again. A Submit writes applied_at in
-- the same update, and an Undo that puts the item back writes the pending suggestion back with it.
create or replace function public.inbox_suggestion_settle() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.suggestion is not null and new.suggestion->>'applied_at' is null and new.suggestion->>'resolved_at' is null
     and ((old.in_inbox and not new.in_inbox) or (new.completed_at is not null and old.completed_at is null) or (new.dropped_at is not null and old.dropped_at is null)) then
    new.suggestion := new.suggestion || jsonb_build_object('resolved_at', now());
  end if;
  return new;
end $$;
drop trigger if exists tasks_suggestion_settle on public.tasks;
create trigger tasks_suggestion_settle before update on public.tasks for each row execute function public.inbox_suggestion_settle();

-- The MCP's whole-library snapshot carries the new column.
create or replace function public.mcp_snapshot(owner uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'tasks', (select jsonb_build_object('cols', to_jsonb(array['id','project_id','parent_id','in_inbox','title','notes','flagged','defer_at','due_at','completed_at','dropped_at','source','sort','created_at','updated_at','completion_note','planned_at','estimate_minutes','place_id','location_trigger','location_radius_m','repeat_rule','steps_in_order','external_ref','import_id','energy','waiting_on','delegated_at','follow_up_at','agenda_for','tickler','reference_id','scheduled_at','scheduled_minutes','checklist_id','gain','gain_cost','gain_by','gain_met','clarify_skips','reading_type','reading_state','reading_url','reading_notes_done','important','folder_path','steps_single','complete_with_last','on_unblock','daily','suggestion']),
                                        'rows', coalesce(jsonb_agg(jsonb_build_array(t.id,t.project_id,t.parent_id,t.in_inbox,t.title,t.notes,t.flagged,t.defer_at,t.due_at,t.completed_at,t.dropped_at,t.source,t.sort,t.created_at,t.updated_at,t.completion_note,t.planned_at,t.estimate_minutes,t.place_id,t.location_trigger,t.location_radius_m,t.repeat_rule,t.steps_in_order,t.external_ref,t.import_id,t.energy,t.waiting_on,t.delegated_at,t.follow_up_at,t.agenda_for,t.tickler,t.reference_id,t.scheduled_at,t.scheduled_minutes,t.checklist_id,t.gain,t.gain_cost,t.gain_by,t.gain_met,t.clarify_skips,t.reading_type,t.reading_state,t.reading_url,t.reading_notes_done,t.important,t.folder_path,t.steps_single,t.complete_with_last,t.on_unblock,t.daily,t.suggestion) order by t.id), '[]'::jsonb))
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
