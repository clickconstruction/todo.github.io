-- Slipbox and reading list (migration 20261017000001). One rolled-back transaction; every row should be ok = true.
begin;
insert into auth.users (id, instance_id, aud, role, email) values ('00000000-0000-0000-0000-0000000000f8','00000000-0000-0000-0000-000000000000','authenticated','authenticated','sr@test.invalid');
create temp table r (n int generated always as identity, test text, ok boolean, detail text); grant all on r to authenticated;
create temp table res (k text, v uuid); grant all on res to authenticated;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000f8","role":"authenticated"}', true);
insert into public.tasks (id, title, notes, in_inbox, flagged, created_at, updated_at) values
 ('00000000-0000-0000-0000-00000000d101', 'Read more tales of the nuclear age', '', false, true, '2024-08-15', '2024-08-15'),
 ('00000000-0000-0000-0000-00000000d102', 'Watch the hummingbird video', 'https://youtu.be/x', false, false, '2023-01-01', '2023-01-01'),
 ('00000000-0000-0000-0000-00000000d103', 'Luhmann: surprise makes a note worth keeping', 'From How to Take Smart Notes', true, false, '2024-01-01', '2024-01-01');
insert into r (test, ok, detail) select 'guess: read → book, watch → video, link → article', public.reading_guess('Read more tales of the nuclear age') = 'book' and public.reading_guess('Watch the hummingbird video') = 'video' and public.reading_guess('https://untools.co') = 'article', '';
select public.reading_set('00000000-0000-0000-0000-00000000d101', 'up_next');
insert into r (test, ok, detail) select 'up next: parked in Someday, unflagged, typed', reading_state = 'up_next' and reading_type = 'book' and not flagged
  and exists (select 1 from public.task_tags tt join public.tags g on g.id = tt.tag_id where tt.task_id = t.id and g.name = 'Someday'), '' from public.tasks t where id = '00000000-0000-0000-0000-00000000d101';
select public.reading_set('00000000-0000-0000-0000-00000000d101', 'reading');
insert into r (test, ok, detail) select 'start reading: out of Someday, a live action', reading_state = 'reading' and not exists (select 1 from public.task_tags where task_id = t.id), '' from public.tasks t where id = '00000000-0000-0000-0000-00000000d101';
select public.reading_set('00000000-0000-0000-0000-00000000d101', 'finished');
insert into r (test, ok, detail) select 'finished: completed, notes still to write', reading_state = 'finished' and completed_at is not null and not reading_notes_done, '' from public.tasks where id = '00000000-0000-0000-0000-00000000d101';
select public.reading_set('00000000-0000-0000-0000-00000000d102', 'up_next');
insert into r (test, ok, detail) select 'the link is kept as the source', reading_url = 'https://youtu.be/x' and reading_type = 'video', coalesce(reading_url, '∅') from public.tasks where id = '00000000-0000-0000-0000-00000000d102';
insert into res select 'n', public.slipbox_from_task('00000000-0000-0000-0000-00000000d103', null, null, 'How to Take Smart Notes, p. 112');
insert into r (test, ok, detail) select 'slipbox from an action: a fleeting note with its source, the action dropped',
  (select kind = 'fleeting' and from_task_id = '00000000-0000-0000-0000-00000000d103' and body = 'From How to Take Smart Notes' and source = 'How to Take Smart Notes, p. 112' from public.slipbox_notes where id = (select v from res where k = 'n'))
  and (select dropped_at is not null from public.tasks where id = '00000000-0000-0000-0000-00000000d103'), '';
do $$ begin delete from public.slipbox_notes; insert into r (test, ok) values ('notes are never deleted', (select count(*) from public.slipbox_notes) = 1);
exception when others then insert into r (test, ok, detail) values ('notes are never deleted', true, sqlerrm); end $$;
insert into public.tasks (id, title, in_inbox, created_at, updated_at) values ('00000000-0000-0000-0000-00000000d104', 'Read this caving book', false, '2024-06-24', '2024-06-24'), ('00000000-0000-0000-0000-00000000d105', 'Idea: feeder funnels Austin to Kingsbury', false, '2024-06-24', '2024-06-24');
insert into public.review_sessions (id) values ('00000000-0000-0000-0000-00000000d201');
insert into public.review_items (id, session_id, sort, kind, task_id) values ('00000000-0000-0000-0000-00000000d301', '00000000-0000-0000-0000-00000000d201', 1, 'task', '00000000-0000-0000-0000-00000000d104'), ('00000000-0000-0000-0000-00000000d302', '00000000-0000-0000-0000-00000000d201', 2, 'task', '00000000-0000-0000-0000-00000000d105');
select public.review_decide('00000000-0000-0000-0000-00000000d301', 'reading');
insert into r (test, ok, detail) select 'review → reading list', reading_state = 'up_next', '' from public.tasks where id = '00000000-0000-0000-0000-00000000d104';
select public.review_undo('00000000-0000-0000-0000-00000000d301');
insert into r (test, ok, detail) select 'undo → back as it was', reading_state is null and not exists (select 1 from public.task_tags where task_id = t.id) and updated_at = '2024-06-24', '' from public.tasks t where id = '00000000-0000-0000-0000-00000000d104';
select public.review_decide('00000000-0000-0000-0000-00000000d302', 'slipbox');
insert into r (test, ok, detail) select 'review → slipbox: note made, action dropped', exists (select 1 from public.slipbox_notes where from_task_id = '00000000-0000-0000-0000-00000000d105' and archived_at is null) and (select dropped_at is not null from public.tasks where id = '00000000-0000-0000-0000-00000000d105'), '';
select public.review_undo('00000000-0000-0000-0000-00000000d302');
insert into r (test, ok, detail) select 'undo → note archived (not deleted), action back', (select archived_at is not null from public.slipbox_notes where from_task_id = '00000000-0000-0000-0000-00000000d105') and (select dropped_at is null from public.tasks where id = '00000000-0000-0000-0000-00000000d105'), '';
reset role;
select count(*) filter (where ok) as passed, count(*) as total, string_agg(case when not ok then test || ': ' || coalesce(detail, '') end, '; ') as failed from r;
rollback;
