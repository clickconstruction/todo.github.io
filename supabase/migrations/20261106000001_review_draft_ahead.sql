-- Full Review: "Keep Claude ahead". A switch on the review, ticked in the app or set over the MCP
-- (full_review ahead). While it is on, Claude keeps a suggestion waiting on each of the next cards
-- (full_review status says which have none), so a card already has its suggestion when you reach it.
-- Nothing else changes: a drafted suggestion still does nothing until Submit.
alter table public.review_sessions add column draft_ahead boolean not null default false;
