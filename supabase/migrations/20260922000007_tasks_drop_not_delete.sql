-- Tasks are dropped (dropped_at), never deleted — same rule as folders and projects.
drop policy "owner delete" on public.tasks;
create trigger tasks_no_delete before delete on public.tasks
  for each row execute function public.forbid_delete();
