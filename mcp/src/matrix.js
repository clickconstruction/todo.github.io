// Matrix (Eisenhower) for agents: the same four boxes the user sees (rules in js/matrix.js).
import { BOXES, makeMatrix, boxSort } from '../../js/matrix.js';

export function matrixTools({ OPEN, availableTasks }) {
  const inList = (ids) => `in.(${ids.map((id) => `"${id}"`).join(',')})`;
  const ids = (a) => (Array.isArray(a.task_ids) ? a.task_ids : a.task_id ? [a.task_id] : []).map(String).filter(Boolean).slice(0, 500);
  return [{
    name: 'matrix',
    description: `The Eisenhower matrix over the user's available actions (Someday, deferred, Inbox and reading-list items stay out).
urgent = a hard due date overdue or within the user's window (default 7 days), or a Waiting For follow-up that's late. important = the user's override (★/☆), else flagged, its project flagged, or its project serves an active goal.
Boxes and their moves: do (urgent+important → plan for today: update_task planned), schedule (important, not urgent → give a planned date), delegate (urgent, not important → delegate), park (neither → Someday/Maybe).
actions: get {box?: do|schedule|delegate|park, limit?} · park {task_ids} (Someday tag on each; returns the ids parked, for unpark) · unpark {task_ids} (Undo) · mark {task_id, important: true|false|null} (null = back to auto) · urgent_days {days}
Park only what the user agreed to; offer to keep anything they star.`,
    inputSchema: { type: 'object', properties: {
      action: { type: 'string', enum: ['get', 'park', 'unpark', 'mark', 'urgent_days'], default: 'get' },
      box: { type: 'string', enum: BOXES.map((b) => b.key) }, limit: { type: 'integer' },
      task_ids: { type: 'array', items: { type: 'string' } }, task_id: { type: 'string' },
      important: { type: ['boolean', 'null'] }, days: { type: 'integer' } } },
    async run(api, a) {
      const action = a.action || 'get';
      if (action === 'park') {
        const list = ids(a);
        if (!list.length) throw new Error('task_ids is required');
        const r = await api.q('rpc/matrix_park', { method: 'POST', body: { ids: list, owner: api.userId } });
        return { parked: (r.parked || []).length, task_ids: r.parked || [], next: 'Parked in Someday/Maybe. To undo: matrix unpark with these task_ids.' };
      }
      if (action === 'unpark') {
        const list = ids(a);
        if (!list.length) throw new Error('task_ids is required');
        return api.q('rpc/matrix_unpark', { method: 'POST', body: { ids: list, owner: api.userId } });
      }
      if (action === 'mark') {
        if (!a.task_id) throw new Error('task_id is required');
        if (a.important !== true && a.important !== false && a.important !== null) throw new Error('important must be true, false or null');
        const [t] = await api.q(`tasks?${api.u}&id=eq.${a.task_id}`, { method: 'PATCH', prefer: 'return=representation', body: { important: a.important } });
        if (!t) throw new Error('Not found');
        return { id: t.id, title: t.title, important: t.important === null ? 'auto' : t.important };
      }
      if (action === 'urgent_days') {
        const days = Math.round(Number(a.days));
        if (!(days >= 1 && days <= 60)) throw new Error('days must be 1 to 60');
        const rows = await api.q(`user_settings?${api.u}`, { method: 'PATCH', prefer: 'return=representation', body: { matrix_urgent_days: days } });
        if (!rows.length) await api.q('user_settings', { method: 'POST', body: { user_id: api.userId, matrix_urgent_days: days } });
        api.settings = { ...api.settings, matrix_urgent_days: days };
        return { urgent_days: days };
      }
      // get
      const tomorrow = new Date(Date.now() + 86400000).toISOString();
      const [{ tasks, projects }, goals, late] = await Promise.all([
        availableTasks(api),
        api.q(`goals?${api.u}&status=eq.active&select=id,title,status`),
        api.q(`tasks?${api.u}&${OPEN}&waiting_on=not.is.null&follow_up_at=lt.${encodeURIComponent(tomorrow)}&in_inbox=is.false&select=*`),
      ]);
      const classify = makeMatrix({ projects, goals, urgentDays: api.settings.matrix_urgent_days || 7, tz: api.tz });
      const projectName = new Map(projects.map((p) => [p.id, p.name]));
      const boxes = Object.fromEntries(BOXES.map((b) => [b.key, []]));
      const seen = new Set();
      const add = (t, waitingLate) => { if (seen.has(t.id) || t.reading_state) return; seen.add(t.id); const c = classify(t, { waitingLate }); boxes[c.box].push({ t, c }); };
      late.forEach((t) => add(t, true));
      tasks.forEach((t) => add(t, false));
      const limit = Math.min(200, a.limit || (a.box ? 50 : 8));
      const shape = ({ t, c }) => ({ id: t.id, title: t.title, project: projectName.get(t.project_id) || undefined, why: c.why.join(' · ') || undefined, planned: t.planned_at || undefined, override: t.important === null || t.important === undefined ? undefined : (t.important ? '★' : '☆') });
      const out = {};
      BOXES.filter((b) => !a.box || b.key === a.box).forEach((b) => {
        const list = boxes[b.key].sort((x, y) => boxSort(x.t, y.t));
        out[b.key] = { label: b.label, count: list.length, move: b.move, items: list.slice(0, limit).map(shape), ...(b.key === 'schedule' ? { without_planned_date: list.filter((x) => !x.t.planned_at).length } : {}) };
      });
      return { urgent_days: api.settings.matrix_urgent_days || 7, boxes: out };
    },
  }];
}
