-- Capture from anywhere and BCC → Waiting For.
--   * api_tokens scope 'capture': a key that can only add items to the Inbox (the iPhone Shortcut,
--     Siri, the Share sheet). It can't read, change or delete anything.
--   * user_settings.waiting_followup_days: the follow-up for items delegated by email (BCC/CC).
--   * people.added_via: 'email' when a BCC'd email created the person (the app mentions it once).
alter table public.api_tokens drop constraint api_tokens_scope_check;
alter table public.api_tokens add constraint api_tokens_scope_check check (scope in ('full', 'geo', 'capture'));
alter table public.user_settings add column waiting_followup_days int not null default 7 check (waiting_followup_days between 1 and 60);
alter table public.people add column added_via text not null default 'app' check (added_via in ('app', 'email', 'agent'));
