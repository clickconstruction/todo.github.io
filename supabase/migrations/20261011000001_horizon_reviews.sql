-- Quarterly and yearly reviews of the higher horizons: when the quarterly check-in on goals and
-- areas was last done (the yearly read of purpose and vision uses purpose_read_at / vision_read_at).
alter table public.user_settings add column horizons_quarter_at timestamptz;
