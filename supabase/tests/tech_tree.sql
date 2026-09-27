-- Tech tree (migration 20261103000001). One rolled-back transaction; every row ok = true.
begin;
insert into auth.users (id, instance_id, aud, role, email) values ('00000000-0000-0000-0000-0000000f0001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','tt1@test.invalid'),('00000000-0000-0000-0000-0000000f0002','00000000-0000-0000-0000-000000000000','authenticated','authenticated','tt2@test.invalid');
create temp table r (n int generated always as identity, test text, ok boolean, detail text); grant all on r to authenticated;
insert into public.projects (id, user_id, name) values ('00000000-0000-0000-0000-0000000f00f1', '00000000-0000-0000-0000-0000000f0002', 'Theirs');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000f0001","role":"authenticated"}', true);
insert into public.projects (id, name) values ('00000000-0000-0000-0000-0000000f0011', 'Real Estate Feeder (phase 1)'), ('00000000-0000-0000-0000-0000000f0012', 'RE Title Feeder (phase 2)'), ('00000000-0000-0000-0000-0000000f0013', 'RE Mortgage (phase 3)'), ('00000000-0000-0000-0000-0000000f0014', 'Animal Feeder');
insert into public.goals (id, title, kind) values ('00000000-0000-0000-0000-0000000f0021', 'Significant physical assets', 'destination');
insert into r (test, ok, detail) select 'a goal is a goal unless it says otherwise; a destination is kept', (select kind from public.goals where id = '00000000-0000-0000-0000-0000000f0021') = 'destination', '';
do $$ begin insert into public.goals (title, kind) values ('Bad', 'boss'); insert into r (test, ok, detail) values ('kind is goal, milestone or destination', false, '');
exception when check_violation then insert into r (test, ok, detail) values ('kind is goal, milestone or destination', true, sqlerrm); end $$;

insert into public.tree_links (id, node_kind, node_id, requires_kind, requires_id) values
  ('00000000-0000-0000-0000-0000000f0031', 'project', '00000000-0000-0000-0000-0000000f0012', 'project', '00000000-0000-0000-0000-0000000f0011'),
  ('00000000-0000-0000-0000-0000000f0032', 'project', '00000000-0000-0000-0000-0000000f0013', 'project', '00000000-0000-0000-0000-0000000f0012'),
  ('00000000-0000-0000-0000-0000000f0033', 'goal', '00000000-0000-0000-0000-0000000f0021', 'project', '00000000-0000-0000-0000-0000000f0013');
insert into r (test, ok, detail) select 'links between projects and goals', count(*) = 3 and bool_and(state = 'accepted'), count(*)::text from public.tree_links;
do $$ begin insert into public.tree_links (node_kind, node_id, requires_kind, requires_id) values ('project', '00000000-0000-0000-0000-0000000f0011', 'project', '00000000-0000-0000-0000-0000000f0011'); insert into r (test, ok, detail) values ('a node can''t require itself', false, '');
exception when check_violation then insert into r (test, ok, detail) values ('a node can''t require itself', true, sqlerrm); end $$;
do $$ begin insert into public.tree_links (node_kind, node_id, requires_kind, requires_id) values ('project', '00000000-0000-0000-0000-0000000f0011', 'goal', '00000000-0000-0000-0000-0000000f0021'); insert into r (test, ok, detail) values ('no loops, however long the chain', false, '');
exception when check_violation then insert into r (test, ok, detail) values ('no loops, however long the chain', true, sqlerrm); end $$;
do $$ begin insert into public.tree_links (node_kind, node_id, requires_kind, requires_id, state) values ('project', '00000000-0000-0000-0000-0000000f0011', 'project', '00000000-0000-0000-0000-0000000f0013', 'proposed'); insert into r (test, ok, detail) values ('a proposed link can''t make a loop either', false, '');
exception when check_violation then insert into r (test, ok, detail) values ('a proposed link can''t make a loop either', true, sqlerrm); end $$;
do $$ begin insert into public.tree_links (node_kind, node_id, requires_kind, requires_id) values ('project', '00000000-0000-0000-0000-0000000f0012', 'project', '00000000-0000-0000-0000-0000000f0011'); insert into r (test, ok, detail) values ('the same link only once', false, '');
exception when unique_violation then insert into r (test, ok, detail) values ('the same link only once', true, sqlerrm); end $$;
do $$ begin insert into public.tree_links (node_kind, node_id, requires_kind, requires_id) values ('project', '00000000-0000-0000-0000-0000000f0014', 'project', '00000000-0000-0000-0000-0000000f00f1'); insert into r (test, ok, detail) values ('can''t link to another user''s project', false, '');
exception when foreign_key_violation then insert into r (test, ok, detail) values ('can''t link to another user''s project', true, sqlerrm); end $$;
do $$ begin insert into public.tree_links (node_kind, node_id, requires_title) values ('project', '00000000-0000-0000-0000-0000000f0014', 'Can afford to pay someone full time'); insert into r (test, ok, detail) values ('an accepted link names a real node', false, '');
exception when check_violation then insert into r (test, ok, detail) values ('an accepted link names a real node', true, sqlerrm); end $$;

-- Proposed by title: accepting makes the milestone, and the next one that says the same shares it.
insert into public.tree_links (id, node_kind, node_id, requires_title, state, proposed_by, why) values
  ('00000000-0000-0000-0000-0000000f0041', 'project', '00000000-0000-0000-0000-0000000f0014', 'Can afford to pay someone full time', 'proposed', 'agent', 'Written in an action.'),
  ('00000000-0000-0000-0000-0000000f0042', 'project', '00000000-0000-0000-0000-0000000f0013', 'can afford to pay someone full time ', 'proposed', 'app', '');
select public.tree_accept('00000000-0000-0000-0000-0000000f0041');
select public.tree_accept('00000000-0000-0000-0000-0000000f0042');
insert into r (test, ok, detail) select 'accepting a titled proposal makes the milestone once, and both links point at it',
  (select count(*) from public.goals where kind = 'milestone' and title = 'Can afford to pay someone full time') = 1
  and (select count(distinct requires_id) = 1 and bool_and(state = 'accepted' and requires_kind = 'goal') from public.tree_links where id in ('00000000-0000-0000-0000-0000000f0041', '00000000-0000-0000-0000-0000000f0042')),
  (select count(*)::text from public.goals where kind = 'milestone');
update public.tree_links set archived_at = now() where id = '00000000-0000-0000-0000-0000000f0033';
insert into public.tree_links (node_kind, node_id, requires_kind, requires_id) values ('project', '00000000-0000-0000-0000-0000000f0011', 'goal', '00000000-0000-0000-0000-0000000f0021');
insert into r (test, ok, detail) select 'a removed link is archived, and no longer counts towards a loop', (select archived_at is not null from public.tree_links where id = '00000000-0000-0000-0000-0000000f0033') and (select count(*) from public.tree_links where archived_at is null) = 5, '';
delete from public.tree_links;
insert into r (test, ok, detail) select 'links can''t be deleted', count(*) = 6, count(*)::text from public.tree_links;
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000f0002","role":"authenticated"}', true);
insert into r (test, ok, detail) select 'owner only: another user sees no links', count(*) = 0, count(*)::text from public.tree_links;
do $$ begin perform public.tree_accept('00000000-0000-0000-0000-0000000f0031'); insert into r (test, ok, detail) values ('and can''t accept one', false, '');
exception when others then insert into r (test, ok, detail) values ('and can''t accept one', sqlerrm = 'Link not found.', sqlerrm); end $$;
reset role;
select test, ok, detail from r order by n;
rollback;
