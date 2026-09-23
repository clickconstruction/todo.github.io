// Custom notifications: every minute the Worker's cron sends reminders whose time has come
// (fire_at in the last 6 hours, not yet sent) as Web Push, then marks them sent. Reminders
// on items that were completed or dropped in the meantime are marked sent without a push.
import { sendPush } from './push.js';

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
  const userIds = [...new Set(due.map((n) => n.user_id))];
  const [tasks, projects, subs] = await Promise.all([
    taskIds.length ? rest(`tasks?id=${inIds(taskIds)}&select=id,title,completed_at,dropped_at,due_at,planned_at`) : [],
    projectIds.length ? rest(`projects?id=${inIds(projectIds)}&select=id,name,status,due_at,planned_at`) : [],
    rest(`push_subscriptions?user_id=${inIds(userIds)}&select=id,user_id,endpoint,p256dh,auth`),
  ]);
  let sent = 0;
  const gone = new Set();
  await Promise.all(due.map(async (n) => {
    const item = n.task_id ? tasks.find((t) => t.id === n.task_id) : projects.find((p) => p.id === n.project_id);
    const live = item && (n.task_id ? !item.completed_at && !item.dropped_at : ['active', 'on_hold'].includes(item.status));
    if (!live) return;
    const msg = reminderMessage(n, item, tz);
    await Promise.all(subs.filter((s) => s.user_id === n.user_id).map(async (s) => {
      try {
        const status = await sendPush(s, msg, env);
        if (status === 404 || status === 410) gone.add(s.id);
        else if (status >= 200 && status < 300) sent++;
      } catch { /* one bad device shouldn't stop the rest */ }
    }));
  }));
  await rest(`notifications?id=${inIds(due.map((n) => n.id))}`, { method: 'PATCH', body: { sent_at: now.toISOString() } });
  if (gone.size) await rest(`push_subscriptions?id=${inIds([...gone])}`, { method: 'DELETE' });
  return { due: due.length, sent };
}
