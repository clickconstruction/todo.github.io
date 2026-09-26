-- An event can point at the action it came from ("Add this year's Texas airshows to my calendar"),
-- so the Events list and Forecast can show the card behind it. Optional; set by the app's editor
-- (unlink) and by the events MCP tool (task). Nothing cascades: dropping the card leaves the event.
alter table public.events add column if not exists task_id uuid references public.tasks(id);
create index if not exists events_task_id_idx on public.events (task_id) where task_id is not null;
