-- A rules object without a "rules" array slipped past the first check (a missing key is NULL,
-- and a NULL check passes). Applied to the live database; 20260928000001 now has it built in.
alter table public.perspectives drop constraint perspectives_rules_check;
alter table public.perspectives add constraint perspectives_rules_check
  check (jsonb_typeof(rules) = 'object' and coalesce(jsonb_typeof(rules->'rules'), '') = 'array' and length(rules::text) <= 20000);
