-- Full Review suggestions with new notes for the action (migration 20261031000001). One rolled-back transaction; every row ok = true.
begin;
insert into auth.users (id, instance_id, aud, role, email) values ('00000000-0000-0000-0000-0000000000ff','00000000-0000-0000-0000-000000000000','authenticated','authenticated','rn@test.invalid');
create temp table r (n int generated always as identity, test text, ok boolean, detail text); grant all on r to authenticated;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000ff","role":"authenticated"}', true);
insert into public.tasks (id, title, notes) values ('00000000-0000-0000-0000-00000000f101', 'Send to Tom once a year: the letter about the', 'land, and what we agreed.');
insert into public.review_sessions (id) values ('00000000-0000-0000-0000-00000000f201');
insert into public.review_items (id, session_id, sort, kind, task_id, suggestion) values
 ('00000000-0000-0000-0000-00000000f301', '00000000-0000-0000-0000-00000000f201', 1, 'task', '00000000-0000-0000-0000-00000000f101',
  jsonb_build_object('decision', 'keep', 'title', 'Send to Tom once a year', 'task_notes', E'The letter about the land,\nand what we agreed.\n\nSend it every January.'));
select public.review_apply('00000000-0000-0000-0000-00000000f301');
insert into r (test, ok, detail) select 'submit: the title and the notes are replaced, line breaks kept',
  title = 'Send to Tom once a year' and notes = E'The letter about the land,\nand what we agreed.\n\nSend it every January.', notes
  from public.tasks where id = '00000000-0000-0000-0000-00000000f101';
insert into r (test, ok, detail) select 'the old notes are in the Undo snapshot',
  exists (select 1 from jsonb_array_elements(before) e where e->>'t' = 'fields' and e->>'notes' = 'land, and what we agreed.'), before::text
  from public.review_items where id = '00000000-0000-0000-0000-00000000f301';
select public.review_undo('00000000-0000-0000-0000-00000000f301');
insert into r (test, ok, detail) select 'undo: the old title and notes are back',
  title = 'Send to Tom once a year: the letter about the' and notes = 'land, and what we agreed.', notes
  from public.tasks where id = '00000000-0000-0000-0000-00000000f101';
update public.review_items set suggestion = '{"decision": "keep", "gain": "Tom knows where we stand"}' where id = '00000000-0000-0000-0000-00000000f301';
select public.review_apply('00000000-0000-0000-0000-00000000f301');
insert into r (test, ok, detail) select 'a suggestion without notes leaves them alone',
  notes = 'land, and what we agreed.' and gain = 'Tom knows where we stand', notes from public.tasks where id = '00000000-0000-0000-0000-00000000f101';
select public.review_undo('00000000-0000-0000-0000-00000000f301');
update public.review_items set suggestion = '{"decision": "keep", "task_notes": "  "}' where id = '00000000-0000-0000-0000-00000000f301';
select public.review_apply('00000000-0000-0000-0000-00000000f301');
insert into r (test, ok, detail) select 'blank notes in a suggestion never wipe the notes',
  notes = 'land, and what we agreed.', notes from public.tasks where id = '00000000-0000-0000-0000-00000000f101';
select public.review_undo('00000000-0000-0000-0000-00000000f301');
update public.review_items set suggestion = jsonb_build_object('decision', 'keep', 'task_notes', repeat('x', 7000)) where id = '00000000-0000-0000-0000-00000000f301';
select public.review_apply('00000000-0000-0000-0000-00000000f301');
insert into r (test, ok, detail) select 'notes stop at 6,000 characters', length(notes) = 6000, length(notes)::text from public.tasks where id = '00000000-0000-0000-0000-00000000f101';
-- A card decided before this migration: its snapshot has no notes, so Undo leaves the notes as they are.
update public.review_items set before = (select jsonb_agg(case when e->>'t' = 'fields' then e - 'notes' else e end) from jsonb_array_elements(before) e) where id = '00000000-0000-0000-0000-00000000f301';
select public.review_undo('00000000-0000-0000-0000-00000000f301');
insert into r (test, ok, detail) select 'undo of an older snapshot (no notes in it) leaves the notes alone', length(notes) = 6000, length(notes)::text from public.tasks where id = '00000000-0000-0000-0000-00000000f101';
reset role;
select test, ok, detail from r order by n;
rollback;
