-- Inspector parity with OmniFocus, part 1:
--   projects get Defer / Planned / Due dates and a Duration estimate;
--   review cadence is "every N days|weeks|months|years" (calendar months, not 30 days),
--   and the next review date can be set directly (it's recomputed only when you mark the
--   project reviewed or change the cadence).

alter table public.projects
  add column defer_at timestamptz,
  add column planned_at timestamptz,
  add column due_at timestamptz,
  add column estimate_minutes int check (estimate_minutes is null or estimate_minutes between 0 and 100000),
  add column review_every int not null default 1 check (review_every between 1 and 999),
  add column review_unit text not null default 'week' check (review_unit in ('day', 'week', 'month', 'year'));

-- Carry existing day-based intervals over to the closest natural unit.
update public.projects set
  review_unit = case when review_every_days % 365 = 0 then 'year' when review_every_days % 30 = 0 then 'month' when review_every_days % 7 = 0 then 'week' else 'day' end,
  review_every = case when review_every_days % 365 = 0 then review_every_days / 365 when review_every_days % 30 = 0 then review_every_days / 30
                      when review_every_days % 7 = 0 then review_every_days / 7 else review_every_days end;

create index projects_due_idx on public.projects (user_id, due_at) where due_at is not null and status in ('active', 'on_hold');

create or replace function public.review_interval(n int, unit text) returns interval
language sql immutable set search_path = '' as $$
  select case unit when 'day' then make_interval(days => n) when 'week' then make_interval(weeks => n)
                   when 'month' then make_interval(months => n) else make_interval(years => n) end
$$;

-- Keeps review_every_days (older clients and the MCP still send it) in step with every/unit,
-- derives next_review_at when the cadence or last review changes, and records completion time.
create or replace function public.projects_review_schedule() returns trigger
language plpgsql set search_path = '' as $$
declare
  cadence_changed boolean;
begin
  if (tg_op = 'UPDATE' and new.review_every_days is distinct from old.review_every_days
      and new.review_every is not distinct from old.review_every and new.review_unit is not distinct from old.review_unit)
     or (tg_op = 'INSERT' and new.review_every = 1 and new.review_unit = 'week' and new.review_every_days <> 7) then
    -- A client set the interval in days: express it in the most natural unit.
    new.review_unit := case when new.review_every_days % 365 = 0 then 'year' when new.review_every_days % 30 = 0 then 'month'
                            when new.review_every_days % 7 = 0 then 'week' else 'day' end;
    new.review_every := case new.review_unit when 'year' then new.review_every_days / 365 when 'month' then new.review_every_days / 30
                             when 'week' then new.review_every_days / 7 else new.review_every_days end;
  end if;
  new.review_every_days := least(3650, new.review_every * case new.review_unit when 'day' then 1 when 'week' then 7 when 'month' then 30 else 365 end);

  cadence_changed := tg_op = 'INSERT'
    or new.review_every is distinct from old.review_every or new.review_unit is distinct from old.review_unit
    or new.last_reviewed_at is distinct from old.last_reviewed_at;
  if tg_op = 'INSERT' and new.next_review_at is not null then
    null; -- caller chose the first review date
  elsif cadence_changed or new.next_review_at is null then
    new.next_review_at := coalesce(new.last_reviewed_at, new.created_at, now()) + public.review_interval(new.review_every, new.review_unit);
  end if; -- otherwise an explicit next_review_at edit is kept

  if new.status in ('completed', 'dropped') and (tg_op = 'INSERT' or old.status not in ('completed', 'dropped')) then
    new.completed_at := coalesce(new.completed_at, now());
  elsif new.status in ('active', 'on_hold') then
    new.completed_at := null;
  end if;
  return new;
end $$;
