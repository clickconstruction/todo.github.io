-- Sidebar: grouped by GTD step (Do, Organize, Lists, Reflect), customizable per account.
--   * user_settings.sidebar: {hidden: [view keys], order: {group: [view keys]}}; collapsed groups are
--     per device (localStorage), since a laptop and a phone want different things open.
--   * perspectives.pinned: pinned perspectives sit in the Do group; the rest live under Perspectives.
alter table public.user_settings add column sidebar jsonb not null default '{}' check (jsonb_typeof(sidebar) = 'object' and pg_column_size(sidebar) <= 8192);
alter table public.perspectives add column pinned boolean not null default true;
