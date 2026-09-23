-- Folders and projects are archived, never deleted.
--   folders.archived_at: set to archive; blocked while the folder holds active/on-hold projects.
--   projects: "archived" means status completed/dropped (existing column).
-- Deletes are removed from RLS so no client can delete them, and triggers keep
-- the rules true for every writer (app, MCP server, SQL).

alter table public.folders add column archived_at timestamptz;

drop policy "owner delete" on public.folders;
drop policy "owner delete" on public.projects;

create or replace function public.folders_guard_archive() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.archived_at is not null and old.archived_at is null and exists (
    select 1 from public.projects p
    where p.folder_id = new.id and p.status in ('active', 'on_hold')
  ) then
    raise exception 'Folder "%" still has active or on-hold projects; move or complete them before archiving.', new.name
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger folders_guard_archive before update of archived_at on public.folders
  for each row execute function public.folders_guard_archive();

create or replace function public.projects_guard_folder() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.folder_id is not null
     and (tg_op = 'INSERT' or new.folder_id is distinct from old.folder_id or new.status is distinct from old.status)
     and new.status in ('active', 'on_hold')
     and exists (select 1 from public.folders f where f.id = new.folder_id and f.archived_at is not null) then
    raise exception 'That folder is archived; unarchive it first or choose another folder.'
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger projects_guard_folder before insert or update of folder_id, status on public.projects
  for each row execute function public.projects_guard_folder();

create or replace function public.forbid_delete() returns trigger security definer
language plpgsql set search_path = '' as $$
begin
  -- Allow the cascade when the owning account itself is being deleted.
  if not exists (select 1 from auth.users u where u.id = old.user_id) then
    return old;
  end if;
  raise exception '% are archived, not deleted.', tg_table_name using errcode = 'insufficient_privilege';
end $$;

create trigger folders_no_delete before delete on public.folders
  for each row execute function public.forbid_delete();
create trigger projects_no_delete before delete on public.projects
  for each row execute function public.forbid_delete();
