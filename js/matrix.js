// Matrix (Eisenhower): pure rules shared by the app and the MCP server.
//   urgent    = a hard due date that's overdue or within N days (default 7), or a Waiting For
//               follow-up that's late
//   important = your ★ override (tasks.important), else flagged, its project flagged, or its
//               project serves an active goal
// Only what's actionable counts (available actions, plus late follow-ups); Someday, deferred and
// Inbox items stay out. Each box has one fitting move: Do, Schedule, Delegate, Park.

export const BOXES = [
  { key: 'do', label: 'Do', urgent: true, important: true, move: 'Plan all for today', hint: 'Urgent and important: plan these for today.' },
  { key: 'schedule', label: 'Schedule', urgent: false, important: true, move: 'Give each a planned date', hint: 'Important, not urgent: the box that matters most. Give each a planned date before it turns urgent.' },
  { key: 'delegate', label: 'Delegate', urgent: true, important: false, move: 'Hand off → Waiting For', hint: 'Urgent, not important: could someone else do it?' },
  { key: 'park', label: 'Park', urgent: false, important: false, move: 'Move to Someday/Maybe', hint: 'Neither urgent nor important: park it in Someday/Maybe.' },
];
export const boxFor = (urgent, important) => BOXES.find((b) => b.urgent === urgent && b.important === important);

const DAY = 86400000;
const dayStart = (d, tz) => {
  if (!tz) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); }
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(new Date(d)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day);
};
const weekday = (iso, tz) => new Date(iso).toLocaleDateString('en-US', { weekday: 'short', ...(tz ? { timeZone: tz } : {}) });

// → classify(t, { waitingLate }) = { box, urgent, important, why: [short reasons] }
export function makeMatrix({ projects = [], goals = [], urgentDays = 7, now = new Date(), tz = null } = {}) {
  const projectById = new Map(projects.map((p) => [p.id, p]));
  const liveGoals = new Map(goals.filter((g) => g.status === 'active').map((g) => [g.id, g]));
  const today = dayStart(now, tz);
  const days = Math.max(1, Number(urgentDays) || 7);
  return (t, { waitingLate = false } = {}) => {
    const why = [];
    let urgent = false;
    if (t.due_at) {
      const d = Math.round((dayStart(t.due_at, tz) - today) / DAY);
      if (d <= days) {
        urgent = true;
        why.push(d < 0 ? `overdue ${-d}d` : d === 0 ? 'due today' : d === 1 ? 'due tomorrow' : d < 7 ? `due ${weekday(t.due_at, tz)}` : `due in ${d}d`);
      }
    }
    if (waitingLate) { urgent = true; why.push('follow-up late'); }
    const p = t.project_id && projectById.get(t.project_id);
    const goal = p && p.goal_id && liveGoals.get(p.goal_id);
    let important;
    if (t.important === true) { important = true; why.push('★ marked'); }
    else if (t.important === false) { important = false; why.push('☆ marked'); }
    else {
      important = !!(t.flagged || (p && p.flagged) || goal);
      if (t.flagged) why.push('flagged');
      else if (p && p.flagged) why.push('project flagged');
      if (goal) why.push(`goal: ${goal.title}`);
    }
    if (!urgent && !important && !why.length && t.created_at) {
      const age = (now - new Date(t.created_at)) / DAY;
      why.push(age > 365 ? `added ${new Date(t.created_at).getFullYear()}` : `added ${Math.max(0, Math.floor(age))}d ago`);
    }
    return { box: boxFor(urgent, important).key, urgent, important, why };
  };
}

// Sort inside a box: most urgent first (earliest due), then flagged, then oldest.
export const boxSort = (a, b) => (a.due_at || '9').localeCompare(b.due_at || '9') || (Number(!!b.flagged) - Number(!!a.flagged)) || String(a.created_at).localeCompare(String(b.created_at));
