-- Folders (migration 20261021000001). One rolled-back transaction; every row should be ok = true.
begin;
insert into auth.users (id, instance_id, aud, role, email) values ('00000000-0000-0000-0000-0000000000fd','00000000-0000-0000-0000-000000000000','authenticated','authenticated','fo@test.invalid');
create temp table r (n int generated always as identity, test text, ok boolean, detail text); grant all on r to authenticated;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000fd","role":"authenticated"}', true);
insert into public.tasks (id, title, in_inbox, created_at, updated_at) values ('00000000-0000-0000-0000-00000000d701', 'clean up bookmarks', false, '2018-10-24', '2018-10-24');
insert into public.review_sessions (id) values ('00000000-0000-0000-0000-00000000d801');
insert into public.review_items (id, session_id, sort, kind, task_id, suggestion) values ('00000000-0000-0000-0000-00000000d901', '00000000-0000-0000-0000-00000000d801', 1, 'task', '00000000-0000-0000-0000-00000000d701',
  '{"decision":"keep","folder":"  ~/_SYNC/MAGA/_Todo/Bookmarks cleanup "}');
select public.review_apply('00000000-0000-0000-0000-00000000d901');
insert into r (test, ok, detail) select 'submit sets the folder (trimmed)', folder_path = '~/_SYNC/MAGA/_Todo/Bookmarks cleanup', coalesce(folder_path, '∅') from public.tasks where id = '00000000-0000-0000-0000-00000000d701';
select public.review_undo('00000000-0000-0000-0000-00000000d901');
insert into r (test, ok, detail) select 'undo clears it again', folder_path is null and updated_at = '2018-10-24', coalesce(folder_path, '∅') from public.tasks where id = '00000000-0000-0000-0000-00000000d701';
insert into public.user_settings (todo_folder) values ('~/_SYNC/MAGA/_Todo');
insert into r (test, ok, detail) select 'settings: todo folder, shortcut name defaults to Open in Finder', todo_folder = '~/_SYNC/MAGA/_Todo' and folder_shortcut = 'Open in Finder', '' from public.user_settings;
reset role;
select count(*) filter (where ok) as passed, count(*) as total, string_agg(case when not ok then test || ': ' || coalesce(detail, '') end, '; ') as failed from r;
rollback;
