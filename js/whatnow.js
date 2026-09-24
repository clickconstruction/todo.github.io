// "What now?": GTD's four criteria for choosing an action. Context, time available and energy filter
// the available actions; priority ranks what's left. Pure (shared by the app and the MCP server).
//   Ranking: scheduled within the hour > due today or overdue > flagged > planned for today or earlier > serves an active goal >
//   oldest first. Estimates only decide what fits the time.
export const TIME_OPTIONS = [5, 15, 30, 60, 0]; // 0 = no limit ("2h+")
const LEVEL = { low: 1, medium: 2, high: 3 };
const DAY = 86400000;

// tasks: available actions. opts: { now, endOfToday (Date), minutes (0/null = any), energy ('low'|'medium'|'high'|''),
//   inContext(t) → bool, projects (for goal links), goals, limit }
export function rankNow(tasks, { now = new Date(), endOfToday, minutes = 0, energy = '', inContext = () => true, projects = [], goals = [], limit = 5, tz } = {}) {
  const end = endOfToday || new Date(new Date(now).setHours(23, 59, 59, 999));
  const liveGoals = new Map(goals.filter((g) => g.status === 'active').map((g) => [g.id, g]));
  const projectById = new Map(projects.map((p) => [p.id, p]));
  const fits = (t) => !minutes || !t.estimate_minutes || t.estimate_minutes <= minutes;
  const energyOk = (t) => !energy || !t.energy || LEVEL[t.energy] <= LEVEL[energy];
  // A time block you've set: due within the hour ranks first; later ones wait for their time.
  const nowMs = new Date(now).getTime();
  const notYet = (t) => t.scheduled_at && Date.parse(t.scheduled_at) > nowMs + 60 * 60000;
  const pool = tasks.filter((t) => inContext(t) && fits(t) && energyOk(t) && !notYet(t));
  const scored = pool.map((t) => {
    const reasons = [];
    let score = 0;
    if (t.scheduled_at) {
      const at = Date.parse(t.scheduled_at);
      const hhmm = new Date(at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', ...(tz ? { timeZone: tz } : {}) });
      if (at >= nowMs - 30 * 60000) { score += 2000; reasons.push({ kind: 'sched', text: `scheduled ${hhmm}` }); }
      else { score += 800; reasons.push({ kind: 'sched', text: `scheduled ${hhmm} (missed)` }); }
    }
    const due = t.due_at && new Date(t.due_at);
    if (due && due <= end) { score += 1000; reasons.push({ kind: 'due', text: due < new Date(new Date(now).setHours(0, 0, 0, 0)) ? 'overdue' : 'due today' }); }
    if (t.flagged || (projectById.get(t.project_id) || {}).flagged) { score += 500; reasons.push({ kind: 'flag', text: 'flagged' }); }
    if (t.planned_at && new Date(t.planned_at) <= end && !t.scheduled_at) { score += 300; reasons.push({ kind: 'planned', text: 'planned today' }); }
    const goal = liveGoals.get((projectById.get(t.project_id) || {}).goal_id);
    if (goal) { score += 150; reasons.push({ kind: 'goal', text: `serves: ${goal.title}` }); }
    const age = Math.floor((new Date(now) - new Date(t.created_at || now)) / DAY);
    score += Math.min(age, 100);
    if (age >= 14) reasons.push({ kind: 'age', text: age >= 60 ? `waiting ${Math.round(age / 30)} months` : `waiting ${Math.round(age / 7)} weeks` });
    if (due && due > end && due - end < 3 * DAY) reasons.push({ kind: 'soon', text: 'due soon' });
    if (t.estimate_minutes) reasons.push({ kind: 'time', text: t.estimate_minutes >= 60 ? `${Math.round(t.estimate_minutes / 6) / 10} h` : `${t.estimate_minutes} min` });
    return { t, score, reasons };
  });
  // Ties: shorter first (more likely to fit), then older.
  scored.sort((a, b) => (b.score - a.score) || ((a.t.estimate_minutes || 999) - (b.t.estimate_minutes || 999)) || String(a.t.created_at).localeCompare(String(b.t.created_at)));
  return { total: pool.length, items: scored.slice(0, limit) };
}

// Minutes until the next timed event today (for "45 min until Site walk"), or null.
export function gapUntilNext(events, now = new Date()) {
  const next = events.filter((e) => !e.allDay && Date.parse(e.start) > now.getTime()).sort((a, b) => a.start.localeCompare(b.start))[0];
  if (!next) return null;
  const mins = Math.floor((Date.parse(next.start) - now.getTime()) / 60000);
  return mins > 0 && mins <= 240 ? { minutes: mins, title: next.title } : null;
}

// Areas: an area is quiet when it has nothing active, or nothing completed lately.
export function areaBalance(area, { projects = [], tasks = [], completedSince = null }) {
  const mine = projects.filter((p) => p.area_id === area.id);
  const active = mine.filter((p) => p.status === 'active');
  const open = tasks.filter((t) => active.some((p) => p.id === t.project_id) && !t.completed_at && !t.dropped_at);
  const warnings = [];
  if (!active.length) warnings.push('nothing active');
  else if (!open.length) warnings.push('no next actions');
  if (completedSince === 0 && active.length) warnings.push('nothing done in 60 days');
  return { projects: mine.length, active: active.length, open: open.length, warnings };
}

export const isDueForReview = (x, now = new Date()) => !x.last_reviewed_at || new Date(x.last_reviewed_at).getTime() + (x.review_every_days || 30) * DAY <= new Date(now).getTime();
