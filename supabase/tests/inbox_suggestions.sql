-- Inbox suggestions (migration 20261115000001): inbox_suggest writes a pending suggestion on the owner's open
-- Inbox items only, and names what it skipped; the column refuses a decision that isn't one; clarifying an
-- item another way stamps a pending suggestion resolved; a Submit's applied_at is left alone; an Undo that
-- puts the item back leaves it pending; the snapshot carries the column. One rolled-back transaction.
begin;
insert into auth.users (id, instance_id, aud, role, email) values ('00000000-0000-0000-0000-0000000000f8','00000000-0000-0000-0000-000000000000','authenticated','authenticated','is@test.invalid');
create temp table r (n int generated always as identity, test text, ok boolean, detail text); grant all on r to authenticated;
insert into r (test, ok) select 'the snapshot carries the column', (public.mcp_snapshot('00000000-0000-0000-0000-0000000000f8')->'tasks'->'cols') ? 'suggestion';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000f8","role":"authenticated"}', true);
insert into public.projects (id, name) values ('00000000-0000-0000-0000-00000000ea01', 'Click Plumbing');
insert into public.tags (id, name) values ('00000000-0000-0000-0000-00000000eb01', 'Phone');
insert into public.tasks (id, title, in_inbox) values
  ('00000000-0000-0000-0000-00000000ec01', 'Call Hiro about the permit', true),
  ('00000000-0000-0000-0000-00000000ec02', 'Already filed', false),
  ('00000000-0000-0000-0000-00000000ec03', 'Old flyer', true),
  ('00000000-0000-0000-0000-00000000ec04', 'Learn to weld', true);
create temp table res as select public.inbox_suggest('[
  {"id":"00000000-0000-0000-0000-00000000ec01","decision":"next_action","project_id":"00000000-0000-0000-0000-00000000ea01","project_name":"Click Plumbing","tag_ids":["00000000-0000-0000-0000-00000000eb01"],"tag_labels":["Phone"],"note":"A call for the job","applied_at":"2020-01-01T00:00:00Z"},
  {"id":"00000000-0000-0000-0000-00000000ec02","decision":"trash"},
  {"id":"00000000-0000-0000-0000-00000000ec03","decision":"nonsense"},
  {"id":"00000000-0000-0000-0000-00000000dead","decision":"trash"},
  {"id":"not-an-id","decision":"trash"},
  {"id":"00000000-0000-0000-0000-00000000ec04","decision":"someday","category":"Learn"}]'::jsonb) as v;
insert into r (test, ok, detail) select 'writes a pending suggestion, stamped by Claude now, never pre-applied',
  suggestion->>'decision' = 'next_action' and suggestion->>'by' = 'agent' and (suggestion->>'at')::timestamptz > now() - interval '1 minute' and not (suggestion ? 'applied_at') and suggestion->>'note' = 'A call for the job', suggestion::text
  from public.tasks where id = '00000000-0000-0000-0000-00000000ec01';
insert into r (test, ok, detail) select 'two suggested; the filed one, the bad decision, someone else''s and the non-id skipped and named',
  jsonb_array_length(v->'suggested') = 2 and jsonb_array_length(v->'skipped') = 4
  and (select string_agg(x->>'why', ',' order by x->>'why') from jsonb_array_elements(v->'skipped') x) = 'no such decision,not an id,not found,not in the Inbox', v::text from res;
do $$ begin update public.tasks set suggestion = '{"decision":"maybe"}' where id = '00000000-0000-0000-0000-00000000ec03'; insert into r (test, ok) values ('the column refuses a decision that isn''t one', false);
exception when others then insert into r (test, ok, detail) values ('the column refuses a decision that isn''t one', sqlerrm like '%check constraint%', sqlerrm); end $$;
-- Clarified another way: filed by hand into a project.
update public.tasks set in_inbox = false, project_id = '00000000-0000-0000-0000-00000000ea01' where id = '00000000-0000-0000-0000-00000000ec01';
insert into r (test, ok, detail) select 'clarified another way: the pending suggestion is stamped resolved', suggestion ? 'resolved_at' and not (suggestion ? 'applied_at'), suggestion::text from public.tasks where id = '00000000-0000-0000-0000-00000000ec01';
-- Undo: back in the Inbox with the suggestion as it was (pending).
update public.tasks set in_inbox = true, project_id = null, suggestion = suggestion - 'resolved_at' where id = '00000000-0000-0000-0000-00000000ec01';
insert into r (test, ok, detail) select 'Undo puts it back pending', in_inbox and not (suggestion ? 'resolved_at') and not (suggestion ? 'applied_at'), suggestion::text from public.tasks where id = '00000000-0000-0000-0000-00000000ec01';
-- Submit: the client stamps applied_at in the same update that moves the item; the trigger leaves it alone.
update public.tasks set in_inbox = false, suggestion = suggestion || jsonb_build_object('applied_at', now()) where id = '00000000-0000-0000-0000-00000000ec04';
insert into r (test, ok, detail) select 'Submit: applied_at kept, not re-stamped', suggestion ? 'applied_at' and not (suggestion ? 'resolved_at'), suggestion::text from public.tasks where id = '00000000-0000-0000-0000-00000000ec04';
-- Dropped with a suggestion pending: resolved too.
update public.tasks set suggestion = '{"decision":"trash","by":"agent","at":"2026-10-17T00:00:00Z"}' where id = '00000000-0000-0000-0000-00000000ec03';
update public.tasks set dropped_at = now() where id = '00000000-0000-0000-0000-00000000ec03';
insert into r (test, ok, detail) select 'dropped while pending: resolved', suggestion ? 'resolved_at', suggestion::text from public.tasks where id = '00000000-0000-0000-0000-00000000ec03';
reset role;
select count(*) filter (where ok) as passed, count(*) as total, string_agg(case when not ok then test || ': ' || coalesce(detail, '') end, '; ') as failed from r;
rollback;
