-- Attachments on actions and projects: files live in a private Storage bucket under
-- <user_id>/<uuid>/<filename>; the attachments table records them. Removing an attachment
-- archives it (archived_at); nothing is deleted, the file stays in storage.

insert into storage.buckets (id, name, public, file_size_limit)
values ('attachments', 'attachments', false, 26214400) -- 25 MB per file
on conflict (id) do nothing;

-- Each user can read and add files only inside their own folder; no updates or deletes.
create policy "attachments owner read" on storage.objects for select to authenticated
  using (bucket_id = 'attachments' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "attachments owner upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'attachments' and (storage.foldername(name))[1] = (select auth.uid())::text);

create table public.attachments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  task_id uuid references public.tasks(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  path text not null unique,
  name text not null check (length(name) between 1 and 255),
  size bigint not null default 0 check (size >= 0),
  mime text not null default 'application/octet-stream',
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  check ((task_id is null) <> (project_id is null))
);
create index on public.attachments (user_id);
create index on public.attachments (task_id) where task_id is not null;
create index on public.attachments (project_id) where project_id is not null;

alter table public.attachments enable row level security;
create policy "owner select" on public.attachments for select to authenticated using ((select auth.uid()) = user_id);
create policy "owner insert" on public.attachments for insert to authenticated
  with check ((select auth.uid()) = user_id and split_part(path, '/', 1) = (select auth.uid())::text);
create policy "owner update" on public.attachments for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

create trigger attachments_no_delete before delete on public.attachments
  for each row execute function public.forbid_delete();

-- The item it's attached to must belong to the same user.
create or replace function public.attachments_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (new.task_id is not null and not exists (select 1 from public.tasks t where t.id = new.task_id and t.user_id = new.user_id))
     or (new.project_id is not null and not exists (select 1 from public.projects p where p.id = new.project_id and p.user_id = new.user_id)) then
    raise exception 'Item not found.' using errcode = 'foreign_key_violation';
  end if;
  if split_part(new.path, '/', 1) <> new.user_id::text then
    raise exception 'Attachment path must be inside your folder.' using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger attachments_guard before insert or update of task_id, project_id, path on public.attachments
  for each row execute function public.attachments_guard();
