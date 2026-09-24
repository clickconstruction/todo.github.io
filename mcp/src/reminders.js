// Custom notifications: every minute the Worker's cron sends reminders whose time has come
// (fire_at in the last 6 hours, not yet sent) as Web Push, then marks them sent. Reminders
// on items that were completed or dropped in the meantime are marked sent without a push.
import { deliver } from './deliver.js';

const inIds = (ids) => `in.(${ids.join(',')})`;

function timeIn(iso, tz) {
  return new Date(iso).toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
}

export function reminderMessage(n, item, tz) {
  const isTask = !!n.task_id;
  const name = isTask ? item.title : item.name;
  const body = {
    before_due: item.due_at ? (n.offset_minutes ? `Due at ${timeIn(item.due_at, tz)}` : 'Due now') : 'Reminder',
    before_planned: item.planned_at ? (n.offset_minutes ? `Planned for ${timeIn(item.planned_at, tz)}` : 'Planned for now') : 'Reminder',
    at_defer: 'Available now',
    at: 'Reminder',
  }[n.kind] || 'Reminder';
  return { title: `⏰ ${name}`, body: isTask ? body : `Project · ${body}`, tag: `reminder:${n.id}`, url: isTask ? `#task/${item.id}` : `#project/${item.id}` };
}

export async function sendDueReminders(env, rest, now = new Date()) {
  const tz = env.TIMEZONE || 'America/Chicago';
  const due = await rest(`notifications?sent_at=is.null&fire_at=lte.${now.toISOString()}&fire_at=gte.${new Date(now - 6 * 3600e3).toISOString()}&order=fire_at.asc&limit=500&select=id,user_id,task_id,project_id,kind,offset_minutes,fire_at`);
  if (!due.length) return { due: 0, sent: 0 };
  const taskIds = [...new Set(due.map((n) => n.task_id).filter(Boolean))];
  const projectIds = [...new Set(due.map((n) => n.project_id).filter(Boolean))];
  const [tasks, projects] = await Promise.all([
    taskIds.length ? rest(`tasks?id=${inIds(taskIds)}&select=id,title,completed_at,dropped_at,due_at,planned_at`) : [],
    projectIds.length ? rest(`projects?id=${inIds(projectIds)}&select=id,name,status,due_at,planned_at`) : [],
  ]);
  // Mark them first so a slow push can never cause a second send on the next run.
  await rest(`notifications?id=${inIds(due.map((n) => n.id))}`, { method: 'PATCH', body: { sent_at: now.toISOString() } });
  let sent = 0;
  for (const n of due) {
    const item = n.task_id ? tasks.find((t) => t.id === n.task_id) : projects.find((p) => p.id === n.project_id);
    const live = item && (n.task_id ? !item.completed_at && !item.dropped_at : ['active', 'on_hold'].includes(item.status));
    if (!live) continue;
    const out = await deliver(env, rest, n.user_id, reminderMessage(n, item, tz), { kind: 'reminder', task_id: n.task_id, project_id: n.project_id });
    sent += out.delivered;
  }
  return { due: due.length, sent };
}

// Weekly Review reminder: on the user's review day, from their review time (up to 2 hours after),
// one push per week, unless they've completed a review in the last 5 days.
export function localDayMinutes(now, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(now).map((x) => [x.type, x.value]));
  return { day: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday), minutes: Number(p.hour) * 60 + Number(p.minute) };
}
export async function sendReviewReminders(env, rest, now = new Date()) {
  const rows = await rest('user_settings?review_notify=is.true&select=user_id,review_day,review_minutes,review_notified_at,timezone');
  let sent = 0;
  for (const s of rows) {
    const { day, minutes } = localDayMinutes(now, s.timezone || env.TIMEZONE || 'America/Chicago');
    if (day !== s.review_day || minutes < s.review_minutes || minutes >= s.review_minutes + 120) continue;
    if (s.review_notified_at && now - new Date(s.review_notified_at) < 5 * 86400000) continue;
    await rest(`user_settings?user_id=eq.${s.user_id}`, { method: 'PATCH', body: { review_notified_at: now.toISOString() } });
    const done = await rest(`weekly_reviews?user_id=eq.${s.user_id}&completed_at=gte.${new Date(now - 5 * 86400000).toISOString()}&select=id&limit=1`);
    if (done.length) continue;
    await deliver(env, rest, s.user_id, { title: '🧭 Weekly Review', body: 'Time to get clear, get current and get creative.', tag: 'weekly-review', url: '#weekly' }, { kind: 'review' });
    sent += 1;
  }
  return sent;
}
