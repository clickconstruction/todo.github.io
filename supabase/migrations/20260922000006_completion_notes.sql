-- Optional note captured when a task is completed (completed_at already records when).
alter table public.tasks add column completion_note text not null default '';

-- Fast "what did I finish" queries by user and time, optionally by project.
create index tasks_completed_idx on public.tasks (user_id, completed_at desc) where completed_at is not null;
