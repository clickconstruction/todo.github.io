-- Horizons: purpose and vision text can hold checkboxes. A line that starts with [ ] is a checkbox and
-- [x] a ticked one ("- [ ]" works too); the ticks live in the text. Marking the text as read (its
-- *_read_at changes) clears the ticks, so the next read starts fresh. The rule is here so the app and
-- the MCP agree; js/horizon-text.js has the same pattern for the screen.
create or replace function public.horizon_clear_ticks(t text) returns text
language sql immutable set search_path = '' as $$
  select regexp_replace(coalesce(t, ''), '^([ \t]*(?:[-*][ \t]+)?)\[[xX]\]', '\1[ ]', 'gn')
$$;

create or replace function public.user_settings_read_clears() returns trigger language plpgsql set search_path = '' as $$
begin
  if new.purpose_read_at is not null and (tg_op = 'INSERT' or new.purpose_read_at is distinct from old.purpose_read_at) then
    new.purpose := public.horizon_clear_ticks(new.purpose);
  end if;
  if new.vision_read_at is not null and (tg_op = 'INSERT' or new.vision_read_at is distinct from old.vision_read_at) then
    new.vision := public.horizon_clear_ticks(new.vision);
  end if;
  return new;
end $$;
create trigger user_settings_read_clears before insert or update on public.user_settings
  for each row execute function public.user_settings_read_clears();
