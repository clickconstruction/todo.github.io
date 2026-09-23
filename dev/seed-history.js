// Dev helper: fill the mock database with a realistic history + delivery log for visual checks.
// In the Browser pane (…/?mock): `await (await import('/dev/seed-history.js')).seed()`
export async function seed() {
  const T = window.__mock.tables;
  const ago = (m) => new Date(Date.now() - m * 60000).toISOString();
  const H = (field, o, n, source, m) => T.item_history.push({ id: T.item_history.length + 1, user_id: 'u1', task_id: 't1', project_id: null, field, old_value: o, new_value: n, source, changed_at: ago(m) });
  const long = 'Call GVEC about utilities and confirm the transfer date for the new meter at the Chimney Rock site';
  Object.assign(T.tasks.find((t) => t.id === 't1'), { title: long });
  H('created', null, 'Call GVEC', 'agent', 3000);
  H('title', 'Call GVEC', long, 'app', 2900);
  H('notes', '', 'Account 4471. Ask for Maria in billing; she handled the last transfer and knows about the deposit refund that is still outstanding from March. https://www.gvec.org/start-stop-transfer-service', 'app', 2800);
  H('due_at', null, new Date(Date.now() + 86400e3).toISOString(), 'app', 2000);
  H('notification', null, { kind: 'before_due', offset_minutes: 60, at: null }, 'app', 1990);
  H('notification', null, { kind: 'at', offset_minutes: 0, at: new Date(Date.now() + 3 * 86400e3).toISOString() }, 'app', 1980);
  H('notification', { kind: 'before_due', offset_minutes: 60, at: null }, null, 'app', 1500);
  H('repeat_rule', null, { every: 2, unit: 'week', weekdays: [1, 4], from: 'assigned', n: 1 }, 'agent', 1400);
  H('tag', null, 'Waiting : Hiro', 'agent', 1300);
  H('flagged', false, true, 'app', 900);
  H('project_id', null, 'p1', 'app', 800);
  H('estimate_minutes', null, 15, 'app', 700);
  H('due_at', new Date(Date.now() + 86400e3).toISOString(), new Date(Date.now() + 3 * 86400e3).toISOString(), 'app', 650);
  H('place_id', null, 'pl1', 'app', 600);
  H('location_trigger', null, 'arrive', 'app', 590);
  H('attachment', null, 'utility-transfer-form-2026-final-signed.pdf', 'app', 400);
  H('completed_at', null, ago(300), 'automatic', 300);
  H('completed_at', ago(300), null, 'app', 290);
  for (let i = 0; i < 40; i++) H('estimate_minutes', i, i + 1, 'app', 5000 + i * 60); // long history → "Show more"
  T.push_subscriptions.push({ id: 'ps1', user_id: 'u1', endpoint: 'https://web.push.apple.com/QKx', p256dh: 'k', auth: 'a', device: 'iPhone', created_at: ago(5000) },
    { id: 'ps2', user_id: 'u1', endpoint: 'https://fcm.googleapis.com/fcm/send/abc', p256dh: 'k', auth: 'a', device: 'Mac', created_at: ago(100) });
  window.__thisEndpoint = 'https://web.push.apple.com/QKx';
  const L = (o) => T.push_log.push({ id: `l${T.push_log.length}`, user_id: 'u1', task_id: null, project_id: null, scheduled_for: null, devices: 0, delivered: 0, results: [], created_at: ago(o.m), ...o });
  L({ kind: 'reminder', title: '⏰ Call GVEC about utilities and confirm the transfer date for the new meter', task_id: 't1', sent_at: ago(250), m: 250, devices: 2, delivered: 1,
    results: [{ device: 'iPhone', service: 'web.push.apple.com', status: 201, reason: '' }, { device: 'Mac', service: 'fcm.googleapis.com', status: 403, reason: '{"reason":"BadJwtToken"} the VAPID credentials in the authorization header do not correspond to the credentials used to create the subscriptions' }] });
  L({ kind: 'place', title: '📍 You’re at Home Depot', task_id: 't1', sent_at: ago(120), m: 120, devices: 1, delivered: 1, results: [{ device: 'iPhone', service: 'web.push.apple.com', status: 201, reason: '' }] });
  L({ kind: 'test', title: '🔔 Test notification', sent_at: ago(30), m: 30 });
  L({ kind: 'test', title: '🔔 Scheduled test', sent_at: null, scheduled_for: new Date(Date.now() + 45e3).toISOString(), m: 1 });
  L({ kind: 'test', title: '🔔 Scheduled test', sent_at: null, scheduled_for: ago(200), m: 201 });
  window.__noRefresh = true;
  const { loadAll } = await import('/js/data.js');
  await loadAll();
  (await import('/js/views/settings.js')).resetSettings();
}
