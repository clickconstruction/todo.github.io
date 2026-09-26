-- Distance to an event. Its location text is geocoded once (the app's editor or the events MCP tool)
-- into lat/lng; the app shows the straight-line distance from you (your location when it's on, else
-- the place chosen in Settings) and fetches the driving time, cached on the event with the origin it
-- was measured from (drive_from = "lat,lng" rounded to about a kilometre) so it's refetched when you
-- move. Nothing here is required: an event with no coordinates simply shows no distance.
alter table public.events
  add column if not exists lat double precision check (lat is null or lat between -90 and 90),
  add column if not exists lng double precision check (lng is null or lng between -180 and 180),
  add column if not exists drive_minutes int check (drive_minutes is null or drive_minutes between 0 and 100000),
  add column if not exists drive_from text check (drive_from is null or char_length(drive_from) <= 40),
  add constraint events_latlng_pair check ((lat is null) = (lng is null));
-- Settings: where distances are measured from when your location is off.
alter table public.user_settings add column if not exists distance_place_id uuid references public.places(id);
