-- What do I gain? One or two sentences on each action (and the project's Purpose, shown under the same
-- label): why doing it is worth it. Asked at capture, used to place ideas and to weed out weak ones.
--   * tasks.gain: what doing it gains you; tasks.gain_cost: "…and if I don't?" (optional)
--   * gain_by / projects.purpose_by: 'agent' while it is Claude's suggestion (cleared when you keep it)
--   * tasks.gain_met: after completing, did you get it? yes | partly | no
--   * tasks.clarify_skips: times Clarify skipped it (a gainless item skipped often is offered Someday)
-- The next occurrence of a repeating action keeps its gain; history records gain changes.
alter table public.tasks
  add column gain text not null default '' check (char_length(gain) <= 500),
  add column gain_cost text not null default '' check (char_length(gain_cost) <= 500),
  add column gain_by text check (gain_by in ('agent')),
  add column gain_met text check (gain_met in ('yes', 'partly', 'no')),
  add column clarify_skips int not null default 0 check (clarify_skips >= 0);
alter table public.projects
  add column purpose_by text check (purpose_by in ('agent'));

drop trigger tasks_history on public.tasks;
create trigger tasks_history after update on public.tasks for each row execute function public.log_item_changes(
  'title', 'notes', 'project_id', 'parent_id', 'flagged', 'defer_at', 'planned_at', 'due_at', 'estimate_minutes', 'completed_at', 'dropped_at',
  'completion_note', 'place_id', 'location_trigger', 'location_radius_m', 'repeat_rule', 'gain', 'gain_cost', 'gain_met');
drop trigger projects_history on public.projects;
create trigger projects_history after update on public.projects for each row execute function public.log_item_changes(
  'name', 'notes', 'status', 'kind', 'folder_id', 'flagged', 'complete_with_last', 'defer_at', 'planned_at', 'due_at', 'estimate_minutes',
  'review_every', 'review_unit', 'next_review_at', 'last_reviewed_at', 'completed_at', 'place_id', 'location_trigger', 'location_radius_m', 'repeat_rule', 'purpose');

-- Repeats carry the gain to the next occurrence.
do $$
declare d text; e text;
begin
  d := pg_get_functiondef('public.repeat_clone_task'::regproc);
  e := replace(d, 'energy, checklist_id, scheduled_at, scheduled_minutes)', 'energy, checklist_id, scheduled_at, scheduled_minutes, gain, gain_cost, gain_by)');
  e := replace(e, 't.energy, t.checklist_id, t.scheduled_at + shift, t.scheduled_minutes);', 't.energy, t.checklist_id, t.scheduled_at + shift, t.scheduled_minutes, t.gain, t.gain_cost, t.gain_by);');
  if e = d or (length(e) - length(d)) <> length(', gain, gain_cost, gain_by') + length(', t.gain, t.gain_cost, t.gain_by') then
    raise exception 'repeat_clone_task changed shape; update this migration';
  end if;
  execute e;
end $$;
