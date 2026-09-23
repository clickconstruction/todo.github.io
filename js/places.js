// Places: saved locations that actions, tags and projects point at.
// An action's effective place is the first of: its own, one of its tags', its group's,
// its project's, one of its project's tags'. The row that supplies the place also
// supplies the alert (arriving / leaving / nearby) and radius (else the place's radius).
import { sb, db, app, run, byId, syncRow, tagsFor, projectTagsFor, tagLabel, isOpen } from './state.js';
import { distanceM } from './geo.js';

export const TRIGGERS = [['', 'Off'], ['arrive', 'Arriving'], ['leave', 'Leaving'], ['nearby', 'Nearby']];
export const triggerLabel = (v) => (TRIGGERS.find(([k]) => k === (v || '')) || TRIGGERS[0])[1];

export const activePlace = (id) => {
  const p = id && byId(db.places, id);
  return p && !p.archived_at ? p : null;
};
export const activePlaces = () => db.places.filter((p) => !p.archived_at).sort((a, b) => a.name.localeCompare(b.name));

const fromRow = (row, via) => {
  const place = activePlace(row.place_id);
  return place && { place, trigger: row.location_trigger || null, radius: row.location_radius_m || place.radius_m, via };
};

// → { place, trigger, radius, via } or null. via is null for the action's own place,
// else { kind: 'tag'|'group'|'project'|'project tag', label } for "inherited from".
export function placeFor(t) {
  const own = fromRow(t, null);
  if (own) return own;
  for (const tag of tagsFor(t.id)) { const r = fromRow(tag, { kind: 'tag', label: tagLabel(tag) }); if (r) return r; }
  const parent = t.parent_id && byId(db.tasks, t.parent_id);
  if (parent) { const r = placeFor(parent); if (r) return { ...r, via: { kind: 'group', label: parent.title } }; }
  const project = t.project_id && byId(db.projects, t.project_id);
  if (project) {
    const r = fromRow(project, { kind: 'project', label: project.name });
    if (r) return r;
    for (const tag of projectTagsFor(project.id)) { const pr = fromRow(tag, { kind: 'project tag', label: tagLabel(tag) }); if (pr) return pr; }
  }
  return null;
}

// Metres from you to the action's place (null without a place or a location fix).
export function distanceTo(t) {
  const loc = placeFor(t);
  return loc && app.here ? distanceM(app.here, loc.place) : null;
}
export const placeDistance = (place) => (app.here ? distanceM(app.here, place) : null);
export const isInside = (loc) => !!(loc && app.here && distanceM(app.here, loc.place) <= loc.radius);

// Open actions whose effective place is `place`.
export const actionsAt = (place) => db.tasks.filter((t) => isOpen(t) && (placeFor(t) || {}).place === place);

// Open actions you're inside the radius of right now (the Nearby badge).
export const hereNowCount = () => (app.here ? db.tasks.filter((t) => isOpen(t) && isInside(placeFor(t))).length : 0);

// Sort helper: nearest first; actions without a place (or no fix) keep their order at the end.
export function byDistance(tasks, fallback) {
  const d = new Map(tasks.map((t) => [t.id, distanceTo(t)]));
  return [...tasks].sort((a, b) => {
    const da = d.get(a.id); const dbb = d.get(b.id);
    if (da == null && dbb == null) return fallback(a, b);
    if (da == null) return 1;
    if (dbb == null) return -1;
    return da - dbb || fallback(a, b);
  });
}

// ---------- writes ----------
export async function insertPlace(fields) {
  const [row] = await run(sb.from('places').insert(fields).select());
  db.places.push(row);
  app.render();
  return row;
}
export async function updatePlace(place, fields) {
  const [row] = await run(sb.from('places').update(fields).eq('id', place.id).select());
  const saved = syncRow('places', place, row);
  app.render();
  return saved;
}
