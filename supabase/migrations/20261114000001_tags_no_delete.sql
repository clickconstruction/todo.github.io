-- Tags are dropped or put on hold (tags.status), never deleted — same rule as folders, projects and tasks.
-- The core schema gave tags an "owner delete" policy; nothing uses it (import undo keeps tags, and
-- neither the app nor the MCP deletes one). Tag links (task_tags, project_tags) may still be removed.
drop policy "owner delete" on public.tags;
create trigger tags_no_delete before delete on public.tags
  for each row execute function public.forbid_delete();
