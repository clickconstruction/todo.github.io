-- Tech tree, cards as requirements (migration 20261104000001). One rolled-back transaction; every row ok = true.
begin;
insert into auth.users (id, instance_id, aud, role, email) values ('00000000-0000-0000-0000-0000001a0001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','tc1@test.invalid'),('00000000-0000-0000-0000-0000001a0002','00000000-0000-0000-0000-000000000000','authenticated','authenticated','tc2@test.invalid');
create temp table r (n int generated always as identity, test text, ok boolean, detail text); grant all on r to authenticated;
insert into public.tasks (id, user_id, title, in_inbox) values ('00000000-0000-0000-0000-0000001a00f1', '00000000-0000-0000-0000-0000001a0002', 'Their card', false);
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000001a0001","role":"authenticated"}', true);
insert into public.projects (id, name) values ('00000000-0000-0000-0000-0000001a0011', 'Real Estate Feeder'), ('00000000-0000-0000-0000-0000001a0012', 'RE Title Feeder');
insert into public.tasks (id, title, in_inbox, project_id) values ('00000000-0000-0000-0000-0000001a0021', 'Find a title attorney', false, '00000000-0000-0000-0000-0000001a0011'), ('00000000-0000-0000-0000-0000001a0022', 'Draft the title chain', false, '00000000-0000-0000-0000-0000001a0012');
insert into public.tasks (id, title, in_inbox) values ('00000000-0000-0000-0000-0000001a0023', 'A card in no project', false);
insert into public.goals (id, title, kind) values ('00000000-0000-0000-0000-0000001a0031', 'Homes', 'destination');

insert into public.tree_links (node_kind, node_id, requires_kind, requires_id) values ('project', '00000000-0000-0000-0000-0000001a0012', 'task', '00000000-0000-0000-0000-0000001a0021');
insert into public.tree_links (node_kind, node_id, requires_kind, requires_id) values ('goal', '00000000-0000-0000-0000-0000001a0031', 'task', '00000000-0000-0000-0000-0000001a0023');
insert into r (test, ok, detail) select 'a project or a goal can require a card', count(*) = 2 and bool_and(requires_kind = 'task'), count(*)::text from public.tree_links;
do $$ begin insert into public.tree_links (node_kind, node_id, requires_kind, requires_id) values ('project', '00000000-0000-0000-0000-0000001a0012', 'task', '00000000-0000-0000-0000-0000001a0022'); insert into r (test, ok, detail) values ('a project can''t require a card inside itself', false, '');
exception when check_violation then insert into r (test, ok, detail) values ('a project can''t require a card inside itself', sqlerrm like '%inside itself%', sqlerrm); end $$;
do $$ begin insert into public.tree_links (node_kind, node_id, requires_kind, requires_id) values ('project', '00000000-0000-0000-0000-0000001a0011', 'task', '00000000-0000-0000-0000-0000001a0022'); insert into r (test, ok, detail) values ('a loop through a card is refused: its project already rests on this one', false, '');
exception when check_violation then insert into r (test, ok, detail) values ('a loop through a card is refused: its project already rests on this one', sqlerrm like '%loop%', sqlerrm); end $$;
do $$ begin insert into public.tree_links (node_kind, node_id, requires_kind, requires_id) values ('task', '00000000-0000-0000-0000-0000001a0021', 'project', '00000000-0000-0000-0000-0000001a0012'); insert into r (test, ok, detail) values ('a card is never the one that is locked (cards use Waits for)', false, '');
exception when check_violation then insert into r (test, ok, detail) values ('a card is never the one that is locked (cards use Waits for)', true, sqlerrm); end $$;
do $$ begin insert into public.tree_links (node_kind, node_id, requires_kind, requires_id) values ('project', '00000000-0000-0000-0000-0000001a0011', 'task', '00000000-0000-0000-0000-0000001a00f1'); insert into r (test, ok, detail) values ('can''t require another user''s card', false, '');
exception when foreign_key_violation then insert into r (test, ok, detail) values ('can''t require another user''s card', true, sqlerrm); end $$;
update public.tasks set completed_at = now() where id = '00000000-0000-0000-0000-0000001a0021';
insert into r (test, ok, detail) select 'finishing the card leaves the link in place (the app reads it as met)', count(*) = 1, '' from public.tree_links l join public.tasks t on t.id = l.requires_id where l.node_id = '00000000-0000-0000-0000-0000001a0012' and t.completed_at is not null;
insert into public.tree_links (node_kind, node_id, requires_kind, requires_id) values ('goal', '00000000-0000-0000-0000-0000001a0031', 'project', '00000000-0000-0000-0000-0000001a0012');
insert into r (test, ok, detail) select 'goals and projects still link as before', count(*) = 3, count(*)::text from public.tree_links where archived_at is null;
select test, ok, detail from r order by n;
rollback;
