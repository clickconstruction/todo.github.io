-- Checklists as reflections: a checklist can ask for a line on each item every run (reflect), and a
-- run keeps those lines (notes: {item id: text}). Four ticks say nothing three months later; four
-- sentences do. Runs were already kept; now they carry the words too.
alter table public.checklists add column if not exists reflect boolean not null default false;
alter table public.checklist_runs add column if not exists notes jsonb not null default '{}'
  check (jsonb_typeof(notes) = 'object' and pg_column_size(notes) <= 20000);
