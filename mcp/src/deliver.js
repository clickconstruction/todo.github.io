// Send one message to all of a user's devices and record the outcome in push_log:
// per device the push service's HTTP status and, when it refuses, its reason (e.g. Apple's
// "BadJwtToken"). Subscriptions the service says are gone (404/410) are removed.
import { encryptPayload, vapidHeader } from './push.js';

export async function pushTo(sub, message, env) {
  const body = await encryptPayload(JSON.stringify(message), { p256dh: sub.p256dh, auth: sub.auth });
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: { Authorization: await vapidHeader(sub.endpoint, env), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '3600', Urgency: 'high' },
    body,
  });
  const reason = res.ok ? '' : (await res.text().catch(() => '')).slice(0, 300);
  return { status: res.status, reason };
}

// meta: { kind: test|reminder|place, task_id?, project_id?, logId? (update a queued row) }
export async function deliver(env, rest, userId, message, meta) {
  const subs = await rest(`push_subscriptions?user_id=eq.${userId}&select=id,endpoint,p256dh,auth,device`);
  const results = await Promise.all(subs.map(async (s) => {
    const service = (() => { try { return new URL(s.endpoint).host; } catch { return '?'; } })();
    try {
      const { status, reason } = await pushTo(s, message, env);
      return { sub: s.id, device: s.device, service, status, reason };
    } catch (e) {
      return { sub: s.id, device: s.device, service, status: 0, reason: e.message };
    }
  }));
  const gone = results.filter((r) => r.status === 404 || r.status === 410).map((r) => r.sub);
  if (gone.length) await rest(`push_subscriptions?id=in.(${gone.join(',')})`, { method: 'DELETE' }).catch(() => {});
  const delivered = results.filter((r) => r.status >= 200 && r.status < 300).length;
  const row = { sent_at: new Date().toISOString(), devices: subs.length, delivered, results: results.map(({ sub, ...r }) => r) };
  if (meta.logId) {
    await rest(`push_log?id=eq.${meta.logId}`, { method: 'PATCH', body: row });
  } else {
    await rest('push_log', { method: 'POST', body: { user_id: userId, kind: meta.kind, title: message.title || '', body: message.body || '',
      task_id: meta.task_id || null, project_id: meta.project_id || null, ...row } });
  }
  return { devices: subs.length, delivered, results: row.results };
}

// Tests queued for later ("send a test in 1 minute"): the cron sends them when due.
export async function sendQueuedTests(env, rest, now = new Date()) {
  const due = await rest(`push_log?sent_at=is.null&scheduled_for=lte.${now.toISOString()}&scheduled_for=gte.${new Date(now - 3600e3).toISOString()}&kind=eq.test&select=id,user_id,title,body&limit=100`);
  for (const t of due) {
    await deliver(env, rest, t.user_id, { title: t.title || '🔔 Test notification', body: t.body || 'Scheduled test from Todo Tooling.', tag: `test:${t.id}`, url: '#settings' }, { kind: 'test', logId: t.id });
  }
  return due.length;
}
