// Local UI test harness: an in-memory stand-in for Supabase, loaded only on
// localhost with ?mock in the URL (see index.html). It supports the query chains
// the app uses and mirrors the database rules (no deletes, group completion,
// complete-with-last-action, review schedule) so UI tests match production.
// Inspect or reset state from the console: window.__mock.tables, window.__mock.reset().
(function () {
  const uid = 'u1';
  let n = 0;
  const id = () => `m${++n}`;
  const now = () => new Date().toISOString();
  const at = (days, hour = 10) => { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(hour, 0, 0, 0); return d.toISOString(); };

  function seed() {
    const T = (o) => ({ user_id: uid, parent_id: null, project_id: null, in_inbox: false, notes: '', completion_note: '', flagged: false,
      defer_at: null, planned_at: null, due_at: null, estimate_minutes: null, completed_at: null, dropped_at: null, source: 'app',
      energy: null, waiting_on: null, delegated_at: null, follow_up_at: null, agenda_for: null, tickler: false, reference_id: null, sort: 0, created_at: at(-20), updated_at: at(-1), ...o });
    const P = (o) => ({ user_id: uid, folder_id: null, notes: '', status: 'active', kind: 'parallel', complete_with_last: false, flagged: false,
      review_every_days: 7, review_every: 1, review_unit: 'week', last_reviewed_at: null, next_review_at: null, completed_at: null, sort: 0,
      defer_at: null, planned_at: null, due_at: null, estimate_minutes: null, place_id: null, location_trigger: null, location_radius_m: null,
      created_at: at(-30), updated_at: at(-1), ...o });
    return {
      folders: [
        { id: 'f1', user_id: uid, name: 'PRIORITIES', sort: 0, archived_at: null, created_at: at(-40) },
        { id: 'f2', user_id: uid, name: 'Personal', sort: 1, archived_at: null, created_at: at(-40) },
      ],
      projects: [
        P({ id: 'p1', folder_id: 'f1', name: 'Click Plumbing', sort: 0, last_reviewed_at: at(-10) }),
        P({ id: 'p2', folder_id: 'f2', name: 'End of Life Planning', kind: 'sequential', sort: 1, notes: 'Make sure family knows what to do.' }),
        P({ id: 'p3', folder_id: 'f2', name: 'Driveway Trailer', sort: 2, complete_with_last: true, last_reviewed_at: at(-1) }),
        P({ id: 'p4', folder_id: null, name: 'Errands', kind: 'single_actions', sort: 3, flagged: true }),
        P({ id: 'p5', folder_id: 'f1', name: 'Doctor integration', status: 'on_hold', sort: 4, last_reviewed_at: at(-100) }),
      ],
      tags: [
        { id: 'g1', user_id: uid, name: 'Laptop', parent_id: null, sort: 0 },
        { id: 'g2', user_id: uid, name: 'Phone', parent_id: null, sort: 1 },
        { id: 'g3', user_id: uid, name: 'Waiting', parent_id: null, sort: 2 },
        { id: 'g4', user_id: uid, name: 'Hiro', parent_id: 'g3', sort: 0 },
      ],
      task_tags: [
        { task_id: 't1', tag_id: 'g2', user_id: uid },
        { task_id: 't6', tag_id: 'g1', user_id: uid },
        { task_id: 't10', tag_id: 'g4', user_id: uid },
      ],
      project_tags: [{ project_id: 'p1', tag_id: 'g1', user_id: uid }],
      tasks: [
        T({ id: 't1', project_id: 'p1', title: 'Call GVEC about utilities', notes: 'Account 4471', due_at: at(-2, 17), estimate_minutes: 15, sort: 0 }),
        T({ id: 't2', project_id: 'p1', title: 'Order fittings for Jodi', planned_at: at(0, 9), sort: 1 }),
        T({ id: 't3', project_id: 'p1', title: 'Get plans released', due_at: at(0, 17), flagged: true, sort: 2 }),
        T({ id: 't4', project_id: 'p2', title: 'Write recovery instructions', sort: 0, estimate_minutes: 60 }),
        T({ id: 't5', project_id: 'p2', title: 'Make funeral playlist', sort: 1 }),
        T({ id: 't6', project_id: 'p2', title: 'Inside deadmans switch', sort: 2 }),
        T({ id: 't7', project_id: 'p2', parent_id: 't6', title: 'Asset holdings list', sort: 0 }),
        T({ id: 't8', project_id: 'p2', parent_id: 't6', title: 'Last will and testament', sort: 1 }),
        T({ id: 't9', project_id: 'p3', title: 'Measure driveway', planned_at: at(2, 9), sort: 0 }),
        T({ id: 't10', project_id: 'p4', title: 'Pick up cp33', defer_at: at(3, 0), sort: 0, estimate_minutes: 5 }),
        T({ id: 't11', project_id: 'p4', title: 'Buy fuel filter', sort: 1, estimate_minutes: 30 }),
        T({ id: 't12', in_inbox: true, title: 'Frog Pond EIN', notes: 'Emailed by robert@douglasmining.com', source: 'email' }),
        T({ id: 't13', in_inbox: true, title: 'Build a 2m telescope' }),
        T({ id: 'c1', project_id: 'p1', title: 'Send Jodi the plumbing plans', completed_at: at(-1, 9), completion_note: 'Sent all three sets.' }),
        T({ id: 'd1', project_id: 'p3', title: 'Rent a utility trailer', dropped_at: at(-5) }),
      ],
      places: [
        { id: 'pl1', user_id: uid, name: 'Home Depot', address: '1000 Main St', lat: 29.7600, lng: -95.3700, google_place_id: null, radius_m: 402, notes: '', archived_at: null, created_at: at(-9), updated_at: at(-9) },
        { id: 'pl2', user_id: uid, name: 'Office', address: '200 Travis St', lat: 29.8000, lng: -95.3700, google_place_id: null, radius_m: 152, notes: '', archived_at: null, created_at: at(-9), updated_at: at(-9) },
        { id: 'pl3', user_id: uid, name: 'Old storage unit', address: '', lat: 29.9, lng: -95.5, google_place_id: null, radius_m: 402, notes: '', archived_at: at(-2), created_at: at(-30), updated_at: at(-2) },
      ],
      perspectives: [], imports: [], project_templates: [], user_settings: [], calendars: [], people: [], reference_items: [], weekly_reviews: [], areas: [], goals: [], api_tokens: [], push_subscriptions: [], notifications: [], attachments: [], push_log: [], item_history: [], email_senders: [{ id: 'e1', user_id: uid, email: 'robert@douglasmining.com', created_at: at(-10) }],
    };
  }

  let tables;
  let R = null; // js/repeat.js, for mirroring the repeat trigger
  import('/js/repeat.js').then((m) => { R = m; });
  const reset = () => { n = 0; tables = seed(); tables.projects.forEach(reviewSchedule); window.__mock.tables = tables; };

  // ----- mirrored database rules -----
  const isOpen = (t) => !t.completed_at && !t.dropped_at;
  // Mirrors projects_review_schedule(): every N day|week|month|year (calendar months), days kept in step,
  // an explicitly set next_review_at kept until the cadence or last review changes.
  const UNIT_DAYS = { day: 1, week: 7, month: 30, year: 365 };
  function reviewSchedule(p, before) {
    const daysOnly = before ? p.review_every_days !== before.review_every_days && p.review_every === before.review_every && p.review_unit === before.review_unit
      : (p.review_every || 1) === 1 && (p.review_unit || 'week') === 'week' && p.review_every_days && p.review_every_days !== 7;
    if (daysOnly) {
      const d = p.review_every_days;
      p.review_unit = d % 365 === 0 ? 'year' : d % 30 === 0 ? 'month' : d % 7 === 0 ? 'week' : 'day';
      p.review_every = d / UNIT_DAYS[p.review_unit];
    }
    p.review_every = p.review_every || 1; p.review_unit = p.review_unit || 'week';
    p.review_every_days = Math.min(3650, p.review_every * UNIT_DAYS[p.review_unit]);
    const cadence = !before || p.review_every !== before.review_every || p.review_unit !== before.review_unit || p.last_reviewed_at !== before.last_reviewed_at;
    if (!cadence && p.next_review_at) return;
    const base = new Date(p.last_reviewed_at || p.created_at || now());
    if (p.review_unit === 'month' || p.review_unit === 'year') {
      const day = base.getUTCDate();
      base.setUTCDate(1);
      base.setUTCMonth(base.getUTCMonth() + p.review_every * (p.review_unit === 'year' ? 12 : 1));
      const last = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)).getUTCDate();
      base.setUTCDate(Math.min(day, last));
    } else base.setDate(base.getDate() + p.review_every * UNIT_DAYS[p.review_unit]);
    p.next_review_at = base.toISOString();
  }
  function projectStatusChange(p, oldStatus) {
    const closed = (s) => s === 'completed' || s === 'dropped';
    if (closed(p.status) && !closed(oldStatus)) p.completed_at = p.completed_at || now();
    else if (!closed(p.status)) p.completed_at = null;
    if (p.status === 'completed' && oldStatus !== 'completed' && p.repeat_rule) repeatProject(p);
  }
  // Mirrors tasks_repeat(): completing a repeating task clones the next occurrence (tags,
  // sub-actions, dates moved together); the completed one stops repeating.
  function cloneTask(t, shiftMs, parentId, projectId, rule, deferOverride) {
    const move = (iso) => (iso ? new Date(new Date(iso).getTime() + shiftMs).toISOString() : null);
    const c = { ...t, id: id(), parent_id: parentId, project_id: projectId, completed_at: null, dropped_at: null, completion_note: '',
      defer_at: deferOverride || move(t.defer_at), planned_at: move(t.planned_at), due_at: move(t.due_at), source: 'repeat', repeat_rule: rule,
      created_at: now(), updated_at: now() };
    tables.tasks.push(c);
    tables.task_tags.filter((x) => x.task_id === t.id).forEach((x) => tables.task_tags.push({ ...x, task_id: c.id }));
    tables.notifications.filter((n) => n.task_id === t.id).forEach((n) => {
      const copy = { ...n, id: id(), task_id: c.id, sent_at: null, at: n.at ? move(n.at) : null };
      tables.notifications.push(copy); fireAt(copy);
    });
    return c;
  }
  function repeatTask(t) {
    const parent = t.parent_id && tables.tasks.find((x) => x.id === t.parent_id);
    if (!(parent && parent.completed_at) && R) {
      const next = R.nextOccurrence(t, t.completed_at);
      if (next) {
        const rule = { ...t.repeat_rule, n: (t.repeat_rule.n || 1) + 1 };
        const anchor = t.due_at || t.planned_at || t.defer_at;
        const shift = anchor ? next.next - new Date(anchor) : 0;
        const c = cloneTask(t, shift, t.parent_id, t.project_id, rule, anchor ? null : next.defer_at);
        const cloneSteps = (src, dst) => tables.tasks.filter((x) => x.parent_id === src && !x.dropped_at && x.id !== dst).forEach((k) => cloneSteps(k.id, cloneTask(k, shift, dst, k.project_id, k.repeat_rule || null).id));
        cloneSteps(t.id, c.id);
      }
    }
    t.repeat_rule = null;
  }
  function repeatProject(p) {
    if (!R) return;
    const next = R.nextOccurrence(p, p.completed_at || now());
    const rule = p.repeat_rule;
    p.repeat_rule = null;
    if (!next) return;
    const anchor = p.due_at || p.planned_at || p.defer_at || p.created_at;
    const shift = next.next - new Date(anchor);
    const move = (iso) => (iso ? new Date(new Date(iso).getTime() + shift).toISOString() : null);
    const np = { ...p, id: id(), status: 'active', completed_at: null, last_reviewed_at: null, created_at: now(), updated_at: now(),
      defer_at: p.due_at || p.planned_at || p.defer_at ? move(p.defer_at) : next.defer_at, planned_at: move(p.planned_at), due_at: move(p.due_at),
      repeat_rule: { ...rule, n: (rule.n || 1) + 1 } };
    reviewSchedule(np);
    tables.projects.push(np);
    tables.project_tags.filter((x) => x.project_id === p.id).forEach((x) => tables.project_tags.push({ ...x, project_id: np.id }));
    const cloneSteps = (src, dst) => tables.tasks.filter((x) => x.parent_id === src && !x.dropped_at).forEach((k) => cloneSteps(k.id, cloneTask(k, shift, dst, np.id, k.repeat_rule || null).id));
    tables.tasks.filter((t) => t.project_id === p.id && !t.parent_id && !t.dropped_at).forEach((t) => cloneSteps(t.id, cloneTask(t, shift, null, np.id, t.repeat_rule || null).id));
  }

  // Mirrors notifications_fire_at(): fire time follows the item's dates; moving it re-arms.
  function fireAt(n, before) {
    const item = n.task_id ? tables.tasks.find((t) => t.id === n.task_id) : tables.projects.find((p) => p.id === n.project_id);
    const base = n.kind === 'at' ? n.at : item && { before_due: item.due_at, before_planned: item.planned_at, at_defer: item.defer_at }[n.kind];
    const fire = base ? new Date(new Date(base) - (n.kind === 'at' ? 0 : (n.offset_minutes || 0) * 60000)).toISOString() : null;
    if (before && fire !== before.fire_at) n.sent_at = null;
    n.fire_at = fire;
  }

  // Mirrors the item_history triggers (fields the app edits).
  const TRACK = ['title', 'name', 'notes', 'project_id', 'flagged', 'defer_at', 'planned_at', 'due_at', 'estimate_minutes', 'completed_at', 'dropped_at', 'status', 'place_id', 'repeat_rule'];
  function history(row, field, oldV, newV) {
    tables.item_history.push({ id: tables.item_history.length + 1, user_id: uid, task_id: row.task_id || null, project_id: row.task_id ? null : row.project_id || null,
      field, old_value: oldV, new_value: newV, source: 'app', changed_at: now() });
  }
  function logChanges(table, before, r) {
    TRACK.forEach((k) => {
      if (k in r && JSON.stringify(before[k] ?? null) !== JSON.stringify(r[k] ?? null)) {
        tables.item_history.push({ id: tables.item_history.length + 1, user_id: uid, task_id: table === 'tasks' ? r.id : null, project_id: table === 'projects' ? r.id : null,
          field: k, old_value: before[k] ?? null, new_value: r[k] ?? null, source: 'app', changed_at: now() });
      }
    });
  }

  function taskRules(t, before) {
    // tasks_people_guard: delegated_at when waiting_on changes; no follow-up without a person.
    if (t.waiting_on && (!before || before.waiting_on !== t.waiting_on) && !t.delegated_at) t.delegated_at = now();
    if (!t.waiting_on) t.follow_up_at = null;
    const wasOpen = !before || isOpen(before);
    if (wasOpen && t.completed_at && !t.dropped_at && t.repeat_rule) repeatTask(t); // runs first, like tasks_0_repeat
    if (wasOpen && !isOpen(t)) { // closing a task closes its open steps, all the way down
      tables.tasks.filter((c) => c.parent_id === t.id && isOpen(c)).forEach((c) => {
        const b = { ...c };
        if (t.completed_at) c.completed_at = t.completed_at; else c.dropped_at = t.dropped_at;
        taskRules(c, b);
      });
    }
    if (t.parent_id) {
      const parent = tables.tasks.find((x) => x.id === t.parent_id);
      const kids = tables.tasks.filter((x) => x.parent_id === t.parent_id);
      if (parent && !isOpen(t) && !kids.some(isOpen) && kids.some((k) => k.completed_at) && isOpen(parent)) {
        const b = { ...parent }; parent.completed_at = now(); taskRules(parent, b);
      } else if (parent && isOpen(t) && parent.completed_at) {
        const b = { ...parent }; parent.completed_at = null; taskRules(parent, b); // reopen upwards
      }
    }
    if (t.project_id && t.completed_at && (!before || !before.completed_at)) {
      const p = tables.projects.find((x) => x.id === t.project_id);
      if (p && p.complete_with_last && ['active', 'on_hold'].includes(p.status)
          && !tables.tasks.some((x) => x.project_id === p.id && isOpen(x))) {
        const old = p.status; p.status = 'completed'; projectStatusChange(p, old);
      }
    }
  }
  // Mirrors tasks_tree_guard(): steps live in their parent's project, no loops, max 4 levels.
  const byTask = (id) => tables.tasks.find((x) => x.id === id);
  function treeGuard(t) {
    if (!t.parent_id) return null;
    if (t.parent_id === t.id) return 'A task can’t be a step of itself.';
    const p = byTask(t.parent_id);
    if (!p) return 'Parent task not found.';
    let depth = 1; let cur = p.parent_id;
    while (cur) { if (cur === t.id) return 'A task can’t be a step of one of its own steps.'; depth++; cur = (byTask(cur) || {}).parent_id; if (depth > 10) break; }
    const height = (id) => { const kids = tables.tasks.filter((x) => x.parent_id === id); return kids.length ? 1 + Math.max(...kids.map((k) => height(k.id))) : 0; };
    if (depth + 1 + (t.id ? height(t.id) : 0) > 4) return 'Steps can go 4 levels deep. Turn the big step into a project instead.';
    t.project_id = p.project_id; t.in_inbox = false;
    return null;
  }
  // Mirrors tasks_tree_follow(): moving a task moves its steps.
  function follow(t) { tables.tasks.filter((c) => c.parent_id === t.id).forEach((c) => { if (c.project_id !== t.project_id) { c.project_id = t.project_id; follow(c); } }); }

  // Column defaults the real database fills in (and returns) on insert.
  const DEFAULTS = {
    tasks: () => ({ project_id: null, parent_id: null, in_inbox: true, notes: '', completion_note: '', flagged: false, defer_at: null, planned_at: null,
      due_at: null, estimate_minutes: null, completed_at: null, dropped_at: null, source: 'app', place_id: null, location_trigger: null, location_radius_m: null, repeat_rule: null, steps_in_order: false,
      energy: null, waiting_on: null, delegated_at: null, follow_up_at: null, agenda_for: null, tickler: false, reference_id: null }),
    projects: () => ({ folder_id: null, notes: '', status: 'active', kind: 'parallel', complete_with_last: false, flagged: false, review_every_days: 7,
      review_every: 1, review_unit: 'week', last_reviewed_at: null, completed_at: null, defer_at: null, planned_at: null, due_at: null, estimate_minutes: null,
      place_id: null, location_trigger: null, location_radius_m: null, next_review_at: null, repeat_rule: null, outcome: '', area_id: null, goal_id: null, purpose: '', principles: '', plan: null }),
    folders: () => ({ archived_at: null }),
    tags: () => ({ parent_id: null, status: 'active', place_id: null, location_trigger: null, location_radius_m: null }),
    places: () => ({ address: '', google_place_id: null, radius_m: 402, notes: '', archived_at: null }),
    calendars: () => ({ color: '#1D9E75', enabled: true, sort: 0, last_ok_at: null, last_error: null, event_count: null, archived_at: null }),
    user_settings: () => ({ due_minutes: 1020, defer_minutes: 0, planned_minutes: 540, forecast_tag_id: null, timezone: null, review_day: 5, review_minutes: 900, review_notify: true, review_notified_at: null, trigger_hidden: [], trigger_custom: [], purpose: '', purpose_read_at: null, vision: '', vision_year: null, vision_read_at: null }),
    areas: () => ({ standards: '', review_every_days: 30, last_reviewed_at: null, sort: 0, archived_at: null }),
    goals: () => ({ why: '', area_id: null, target_date: null, status: 'active', achieved_at: null, review_every_days: 30, last_reviewed_at: null, sort: 0 }),
    weekly_reviews: () => ({ started_at: new Date().toISOString(), completed_at: null, abandoned_at: null, steps: {}, stats: {} }),
    project_templates: () => ({ icon: '📋', folder_id: null, schedule: null, next_run_at: null, last_run_at: null, sort: 0, archived_at: null }),
    perspectives: () => ({ icon: '🔭', rules: { v: 1, match: 'all', rules: [] }, options: { show: 'available', group_by: 'project', sort_by: 'project', layout: 'tree' }, badge: false, sort: 0, archived_at: null }),
    notifications: () => ({ task_id: null, project_id: null, offset_minutes: 0, at: null, sent_at: null }),
    people: () => ({ email: null, phone: null, notes: '', tag_id: null, sort: 0, archived_at: null }),
    reference_items: () => ({ body: '', topic: '', secret_value: null, project_id: null, archived_at: null }),
    attachments: () => ({ task_id: null, project_id: null, reference_id: null, size: 0, mime: 'application/octet-stream', archived_at: null }),
  };
  const NO_DELETE = { areas: 'areas are archived, not deleted.', goals: 'goals are achieved or dropped, not deleted.', weekly_reviews: 'reviews are kept.', people: 'people are archived, not deleted.', reference_items: 'reference items are archived, not deleted.', calendars: 'calendars are archived, not deleted.', project_templates: 'templates are archived, not deleted.', imports: 'imports are kept.', perspectives: 'perspectives are archived, not deleted.', attachments: 'attachments are archived, not deleted.', places: 'places are archived, not deleted.', tasks: 'tasks are archived, not deleted.', projects: 'projects are archived, not deleted.', folders: 'folders are archived, not deleted.' };

  // ----- PostgREST-ish filter parsing for .or() strings -----
  function splitTop(s) {
    const out = []; let depth = 0; let cur = '';
    for (const ch of s) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
    }
    if (cur) out.push(cur);
    return out;
  }
  function cond(expr) {
    if (expr.startsWith('and(')) { const parts = splitTop(expr.slice(4, -1)).map(cond); return (r) => parts.every((f) => f(r)); }
    if (expr.startsWith('or(')) { const parts = splitTop(expr.slice(3, -1)).map(cond); return (r) => parts.some((f) => f(r)); }
    const [col, op, ...rest] = expr.split('.');
    const val = rest.join('.');
    switch (op) {
      case 'is': return (r) => (val === 'null' ? r[col] == null : String(r[col]) === val);
      case 'not': return (r) => (val === 'is.null' ? r[col] != null : true);
      case 'eq': return (r) => String(r[col]) === val;
      case 'gte': return (r) => r[col] != null && r[col] >= val;
      case 'gt': return (r) => r[col] != null && r[col] > val;
      case 'lt': return (r) => r[col] != null && r[col] < val;
      case 'lte': return (r) => r[col] != null && r[col] <= val;
      case 'ilike': { const needle = val.replace(/\*/g, '').toLowerCase(); return (r) => String(r[col] || '').toLowerCase().includes(needle); }
      case 'in': { const list = val.slice(1, -1).split(',').map((x) => x.replace(/"/g, '')); return (r) => list.includes(String(r[col])); }
      default: return () => true;
    }
  }

  function builder(table) {
    const st = { op: 'select', filters: [], payload: null, order: null, asc: true, limit: Infinity };
    const match = (r) => st.filters.every((f) => f(r));
    const copy = (r) => JSON.parse(JSON.stringify(r));
    const exec = () => {
      if (!tables[table]) return { data: null, error: { message: `relation "${table}" does not exist` } };
      const rows = tables[table];
      if (st.op === 'insert') {
        const add = [].concat(st.payload).map((p) => ({ id: id(), user_id: uid, created_at: now(), updated_at: now(), sort: 0, ...(DEFAULTS[table] ? DEFAULTS[table]() : {}), ...p }));
        if (table === 'tasks') { for (const r of add) { const err = treeGuard(r); if (err) return { data: null, error: { message: err } }; } }
        rows.push(...add);
        add.forEach((r) => { if (table === 'projects') { reviewSchedule(r); projectStatusChange(r, null); } if (table === 'tasks') taskRules(r, null); if (table === 'notifications') { fireAt(r); history(r, 'notification', null, { kind: r.kind, offset_minutes: r.offset_minutes, at: r.at }); } });
        return { data: add.map(copy), error: null };
      }
      if (st.op === 'update') {
        const hit = rows.filter(match);
        if (table === 'tasks' && ('parent_id' in st.payload || 'project_id' in st.payload)) {
          for (const r of hit) { const trial = { ...r, ...st.payload }; const err = treeGuard(trial); if (err) return { data: null, error: { message: err } }; st.payload = { ...st.payload, project_id: trial.project_id, in_inbox: trial.in_inbox }; }
        }
        hit.forEach((r) => {
          const before = { ...r };
          Object.assign(r, st.payload, { updated_at: now() });
          if (table === 'projects') { reviewSchedule(r, before); projectStatusChange(r, before.status); }
          if (table === 'tasks') taskRules(r, before);
          if (table === 'tasks' && r.project_id !== before.project_id) follow(r);
          if (table === 'notifications') fireAt(r, before);
          if (table === 'tasks' || table === 'projects') logChanges(table, before, r);
          if ((table === 'tasks' || table === 'projects') && ['due_at', 'planned_at', 'defer_at'].some((k) => r[k] !== before[k])) {
            tables.notifications.filter((n) => n[table === 'tasks' ? 'task_id' : 'project_id'] === r.id).forEach((n) => { const b = { ...n }; fireAt(n, b); });
          }
        });
        return { data: hit.map(copy), error: null };
      }
      if (st.op === 'delete' && table === 'notifications') rows.filter(match).forEach((n) => history(n, 'notification', { kind: n.kind, offset_minutes: n.offset_minutes, at: n.at }, null));
      if (st.op === 'delete') {
        if (NO_DELETE[table] && rows.some(match)) return { data: null, error: { message: NO_DELETE[table] } };
        tables[table] = rows.filter((r) => !match(r));
        return { data: [], error: null };
      }
      let out = rows.filter(match).map(copy);
      if (st.order) out.sort((a, b) => ((a[st.order] ?? '') < (b[st.order] ?? '') ? -1 : 1) * (st.asc ? 1 : -1));
      return { data: out.slice(0, st.limit), error: null };
    };
    const b = {
      select() { return b; },
      order(k, o) { st.order = k; st.asc = !(o && o.ascending === false); return b; },
      limit(x) { st.limit = x; return b; },
      insert(p) { st.op = 'insert'; st.payload = p; return b; },
      update(p) { st.op = 'update'; st.payload = p; return b; },
      delete() { st.op = 'delete'; return b; },
      eq(k, v) { st.filters.push((r) => r[k] === v); return b; },
      neq(k, v) { st.filters.push((r) => r[k] !== v); return b; },
      is(k, v) { st.filters.push((r) => (v === null ? r[k] == null : r[k] === v)); return b; },
      not(k, op, v) { st.filters.push(op === 'is' && v === null ? (r) => r[k] != null : () => true); return b; },
      gte(k, v) { st.filters.push((r) => r[k] != null && r[k] >= v); return b; },
      lt(k, v) { st.filters.push((r) => r[k] != null && r[k] < v); return b; },
      lte(k, v) { st.filters.push((r) => r[k] != null && r[k] <= v); return b; },
      in(k, vs) { st.filters.push((r) => vs.includes(r[k])); return b; },
      or(expr) { const parts = splitTop(expr).map(cond); st.filters.push((r) => parts.some((f) => f(r))); return b; },
      then(res, rej) { return Promise.resolve(exec()).then(res, rej); },
    };
    return b;
  }

  const user = { id: uid, email: 'test@localhost' };
  window.__mock = { reset, get tables() { return tables; }, set tables(v) { tables = v; } };
  reset();
  window.supabase = {
    createClient: () => ({
      from: builder,
      // Private file storage (in memory): upload + signed URLs as blob: URLs.
      storage: {
        from: (bucket) => ({
          async upload(path, file) {
            window.__mock.files = window.__mock.files || {};
            if (window.__mock.files[path]) return { data: null, error: { message: 'The resource already exists' } };
            window.__mock.files[path] = file;
            return { data: { path }, error: null };
          },
          async createSignedUrl(path) {
            const f = window.__mock.files && window.__mock.files[path];
            return f ? { data: { signedUrl: URL.createObjectURL(f) }, error: null } : { data: null, error: { message: 'Object not found' } };
          },
        }),
      },
      // Database functions the app calls.
      async rpc(name, args) {
        if (name === 'repeat_skip') {
          const t = tables.tasks.find((x) => x.id === args.task_id);
          if (!t || !t.repeat_rule || !R) return { data: null, error: { message: 'Not a repeating action you own.' } };
          const anchor = t.due_at || t.planned_at || t.defer_at;
          const next = R.nextAnchor({ ...t.repeat_rule, from: 'assigned' }, anchor ? new Date(anchor) : new Date(), new Date());
          const shift = next - new Date(anchor || now());
          const move = (iso) => (iso ? new Date(new Date(iso).getTime() + shift).toISOString() : null);
          Object.assign(t, { defer_at: anchor ? move(t.defer_at) : next.toISOString(), planned_at: move(t.planned_at), due_at: move(t.due_at),
            repeat_rule: { ...t.repeat_rule, n: (t.repeat_rule.n || 1) + 1 }, updated_at: now() });
          return { data: JSON.parse(JSON.stringify(t)), error: null };
        }
        if (name === 'convert_to_project') {
          const t = tables.tasks.find((x) => x.id === args.task_id);
          if (!t || t.completed_at || t.dropped_at) return { data: null, error: { message: 'Only open tasks can become projects.' } };
          const src = t.project_id && tables.projects.find((x) => x.id === t.project_id);
          const pid = id();
          const np = { id: pid, user_id: uid, folder_id: src ? src.folder_id : null, name: t.title, notes: t.notes, status: 'active', kind: t.steps_in_order ? 'sequential' : 'parallel',
            complete_with_last: false, flagged: t.flagged, review_every_days: 7, review_every: 1, review_unit: 'week', last_reviewed_at: null, completed_at: null,
            defer_at: t.defer_at, planned_at: t.planned_at, due_at: t.due_at, estimate_minutes: t.estimate_minutes, place_id: t.place_id, location_trigger: t.location_trigger,
            location_radius_m: t.location_radius_m, next_review_at: null, repeat_rule: null, sort: tables.projects.length, created_at: now(), updated_at: now() };
          reviewSchedule(np);
          tables.projects.push(np);
          tables.task_tags.filter((x) => x.task_id === t.id).forEach((x) => tables.project_tags.push({ project_id: pid, tag_id: x.tag_id, user_id: uid }));
          tables.tasks.filter((c) => c.parent_id === t.id).forEach((c) => { c.parent_id = null; c.project_id = pid; follow(c); });
          t.dropped_at = now(); t.completion_note = `Became the project “${t.title}”`;
          return { data: pid, error: null };
        }
        // Mirrors apply_project_plan() / undo_project_plan() (migration 20261007000001).
        if (name === 'apply_project_plan') {
          const p = tables.projects.find((x) => x.id === args.project);
          if (!p) return { data: null, error: { message: 'Project not found.' } };
          const pl = p.plan || {};
          if (pl.applied) return { data: null, error: { message: 'This plan was already created. Undo it first to create it again.' } };
          const ideas = pl.ideas || []; const ids = []; const refs = [];
          let n = Math.max(-1, ...tables.tasks.filter((t) => t.project_id === p.id && !t.parent_id).map((t) => t.sort || 0)) + 1;
          const add = (o) => { const t = { ...DEFAULTS.tasks(), id: id(), user_id: uid, in_inbox: false, created_at: now(), updated_at: now(), ...o }; tables.tasks.push(t); ids.push(t.id); return t; };
          const lead = (list, nx) => [...list.filter((i) => i.id === nx), ...list.filter((i) => i.id !== nx)];
          lead(ideas.filter((i) => !i.bucket || i.bucket === 'action'), (pl.next || {}).project).forEach((i) => add({ title: i.text, project_id: p.id, sort: n++ }));
          (pl.groups || []).forEach((g) => {
            const mine = ideas.filter((i) => i.bucket === `g:${g.id}`);
            if (!mine.length) return;
            const gt = add({ title: g.name, project_id: p.id, sort: n++, steps_in_order: !!g.in_order });
            lead(mine, (pl.next || {})[g.id]).forEach((i, k) => add({ title: i.text, project_id: p.id, parent_id: gt.id, sort: k }));
          });
          const some = ideas.filter((i) => i.bucket === 'someday');
          if (some.length) {
            let tag = tables.tags.find((g) => !g.parent_id && /^someday/i.test(g.name));
            if (!tag) { tag = { id: id(), user_id: uid, name: 'Someday', parent_id: null, status: 'on_hold', sort: 0 }; tables.tags.push(tag); } else tag.status = 'on_hold';
            some.forEach((i) => { const t = add({ title: i.text, project_id: p.id, sort: n++ }); tables.task_tags.push({ task_id: t.id, tag_id: tag.id, user_id: uid, created_at: now() }); });
          }
          ideas.filter((i) => i.bucket === 'reference').forEach((i) => { const r = { ...DEFAULTS.reference_items(), id: id(), user_id: uid, title: i.text, topic: p.name, project_id: p.id, created_at: now(), updated_at: now() }; tables.reference_items.push(r); refs.push(r.id); });
          p.plan = { ...pl, applied: { at: now(), task_ids: ids, reference_ids: refs } };
          return { data: { tasks: ids.length, references: refs.length, task_ids: ids, reference_ids: refs }, error: null };
        }
        if (name === 'undo_project_plan') {
          const p = tables.projects.find((x) => x.id === args.project);
          const a = p && p.plan && p.plan.applied;
          if (!a) return { data: null, error: { message: 'Nothing to undo.' } };
          let d = 0;
          tables.tasks.filter((t) => a.task_ids.includes(t.id) && !t.completed_at && !t.dropped_at).forEach((t) => { t.dropped_at = now(); d += 1; });
          tables.reference_items.filter((r) => a.reference_ids.includes(r.id)).forEach((r) => { r.archived_at = now(); });
          const { applied, ...rest } = p.plan; p.plan = rest;
          return { data: { tasks_dropped: d, references_archived: a.reference_ids.length }, error: null };
        }
        // Mirrors import_omnifocus() / undo_import() (migrations 20260929000001/2).
        if (name === 'import_omnifocus') {
          const P = args.payload || {};
          const snapshot = args.dry_run ? JSON.stringify(tables) : null;
          const imp = args.batch || id();
          if (args.batch && !tables.imports.some((i) => i.id === args.batch && !i.undone_at)) return { data: null, error: { message: 'Import not found (or it was undone).' } };
          if (!args.batch) tables.imports.push({ id: imp, user_id: uid, source: P.source || 'omnifocus', counts: {}, created_at: now(), undone_at: null });
          const c = { folders: 0, folders_merged: 0, tags: 0, tags_merged: 0, projects: 0, projects_skipped: 0, tasks: 0, tasks_skipped: 0 };
          const byRef = (list, r) => list.find((x) => x.external_ref && x.external_ref === r);
          (P.folders || []).forEach((f) => {
            if (byRef(tables.folders, f.ref)) return;
            const same = tables.folders.find((x) => !x.external_ref && !x.archived_at && x.name.toLowerCase() === f.name.toLowerCase());
            if (same) { same.external_ref = f.ref; c.folders_merged++; return; }
            tables.folders.push({ id: id(), user_id: uid, name: f.name, sort: 1000 + (f.sort || 0), archived_at: null, external_ref: f.ref, import_id: imp, created_at: f.created_at || now() });
            c.folders++;
          });
          [...(P.tags || [])].sort((a, b) => a.depth - b.depth).forEach((g) => {
            if (byRef(tables.tags, g.ref)) return;
            const parent = g.parent_ref ? (byRef(tables.tags, g.parent_ref) || {}).id || null : null;
            const same = tables.tags.find((x) => !x.external_ref && x.name.toLowerCase() === g.name.toLowerCase() && (x.parent_id || null) === parent);
            if (same) { same.external_ref = g.ref; c.tags_merged++; return; }
            tables.tags.push({ id: id(), user_id: uid, name: g.name, parent_id: parent, status: g.status || 'active', sort: 1000 + (g.sort || 0), place_id: null, location_trigger: null, location_radius_m: null, external_ref: g.ref, import_id: imp });
            c.tags++;
          });
          (P.projects || []).forEach((x) => {
            if (byRef(tables.projects, x.ref)) { c.projects_skipped++; return; }
            const np = { ...DEFAULTS.projects(), id: id(), user_id: uid, name: x.name, notes: x.notes || '', folder_id: x.folder_ref ? (byRef(tables.folders, x.folder_ref) || {}).id || null : null,
              status: x.status || 'active', kind: x.kind || 'parallel', complete_with_last: !!x.complete_with_last, flagged: !!x.flagged, defer_at: x.defer_at || null, planned_at: x.planned_at || null,
              due_at: x.due_at || null, estimate_minutes: x.estimate_minutes || null, repeat_rule: x.repeat_rule || null, review_every: x.review_every || 1, review_unit: x.review_unit || 'week',
              last_reviewed_at: x.last_reviewed_at || null, next_review_at: x.next_review_at || null, completed_at: x.completed_at || null, sort: 1000 + (x.sort || 0),
              external_ref: x.ref, import_id: imp, created_at: x.created_at || now(), updated_at: x.updated_at || x.created_at || now() };
            reviewSchedule(np);
            tables.projects.push(np);
            (x.tag_refs || []).forEach((r) => { const g = byRef(tables.tags, r); if (g) tables.project_tags.push({ project_id: np.id, tag_id: g.id, user_id: uid }); });
            c.projects++;
          });
          [...(P.tasks || [])].sort((a, b) => (a.depth || 1) - (b.depth || 1)).forEach((x) => {
            if (byRef(tables.tasks, x.ref)) { c.tasks_skipped++; return; }
            const parent = x.parent_ref ? byRef(tables.tasks, x.parent_ref) : null;
            const project = x.project_ref ? byRef(tables.projects, x.project_ref) : null;
            const nt = { ...DEFAULTS.tasks(), id: id(), user_id: uid, title: x.title, notes: x.notes || '', project_id: parent ? parent.project_id : project ? project.id : null, parent_id: parent ? parent.id : null,
              in_inbox: parent ? false : !!x.in_inbox, flagged: !!x.flagged, defer_at: x.defer_at || null, planned_at: x.planned_at || null, due_at: x.due_at || null,
              estimate_minutes: x.estimate_minutes || null, repeat_rule: x.repeat_rule || null, steps_in_order: !!x.steps_in_order, completed_at: x.completed_at || null,
              dropped_at: x.completed_at ? null : x.dropped_at || null, sort: x.sort || 0, source: 'omnifocus', external_ref: x.ref, import_id: imp,
              created_at: x.created_at || now(), updated_at: x.updated_at || x.created_at || now() };
            tables.tasks.push(nt);
            (x.tag_refs || []).forEach((r) => { const g = byRef(tables.tags, r); if (g) tables.task_tags.push({ task_id: nt.id, tag_id: g.id, user_id: uid }); });
            c.tasks++;
          });
          const mine = tables.tasks.filter((t) => t.import_id === imp && !t.completed_at && !t.dropped_at);
          Object.assign(c, { open_tasks: mine.length, inbox: mine.filter((t) => t.in_inbox).length,
            review_due: tables.projects.filter((p) => p.import_id === imp && ['active', 'on_hold'].includes(p.status) && p.next_review_at && p.next_review_at <= now()).length });
          if (args.dry_run) { tables = JSON.parse(snapshot); window.__mock.tables = tables; return { data: { ...c, dry_run: true }, error: null }; }
          const rec = tables.imports.find((i) => i.id === imp);
          Object.keys(c).forEach((k) => { rec.counts[k] = ['open_tasks', 'inbox', 'review_due'].includes(k) ? c[k] : (rec.counts[k] || 0) + c[k]; });
          return { data: { ...c, import_id: imp, dry_run: false }, error: null };
        }
        if (name === 'undo_import') {
          const rec = tables.imports.find((i) => i.id === args.batch && !i.undone_at);
          if (!rec) return { data: null, error: { message: 'Import not found or already undone.' } };
          let tasksDropped = 0; let projectsDropped = 0; let folders = 0;
          tables.tasks.filter((t) => t.import_id === rec.id).forEach((t) => { if (!t.completed_at && !t.dropped_at) { t.dropped_at = now(); tasksDropped++; } t.external_ref = null; });
          tables.projects.filter((p) => p.import_id === rec.id).forEach((p) => { if (['active', 'on_hold'].includes(p.status)) { p.status = 'dropped'; projectsDropped++; } p.external_ref = null; });
          tables.folders.filter((f) => f.import_id === rec.id && !f.archived_at && !tables.projects.some((p) => p.folder_id === f.id && ['active', 'on_hold'].includes(p.status)))
            .forEach((f) => { f.archived_at = now(); f.external_ref = null; folders++; });
          rec.undone_at = now();
          return { data: { tasks_dropped: tasksDropped, projects_dropped: projectsDropped, folders_archived: folders }, error: null };
        }
        // Mirrors create_from_template() (migration 20261001000001), in the device's zone.
        if (name === 'create_from_template') {
          const t = tables.project_templates.find((x) => x.id === args.template && !x.archived_at);
          if (!t) return { data: null, error: { message: 'Template not found.' } };
          const key = args.anchor || new Date().toISOString().slice(0, 10);
          const vars = { ...Object.fromEntries((t.body.blanks || []).map((b) => [b.name, b.default || ''])), ...Object.fromEntries(Object.entries(args.vars || {}).filter(([, v]) => v !== '')) };
          const d = new Date(`${key}T12:00:00Z`);
          const built = { Date: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }), Month: d.toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' }), Year: String(d.getUTCFullYear()) };
          const b = JSON.parse(JSON.stringify(t.body).replace(/«([^«»]{1,40})»/g, (m, n) => (vars[n] !== undefined ? JSON.stringify(String(vars[n])).slice(1, -1) : built[n] !== undefined ? built[n] : m)));
          const at = (o, hour) => { if (typeof o !== 'number') return null; const x = new Date(`${key}T00:00:00`); x.setDate(x.getDate() + o); x.setHours(hour, 0, 0, 0); return x.toISOString(); };
          const pid = id();
          const np = { ...DEFAULTS.projects(), id: pid, user_id: uid, name: (args.name || b.name || t.name), notes: b.notes || '', folder_id: args.folder || t.folder_id || null, kind: b.kind || 'parallel',
            complete_with_last: !!b.complete_with_last, flagged: !!b.flagged, review_every: b.review_every || 1, review_unit: b.review_unit || 'week',
            defer_at: at(b.project_defer, 0), planned_at: at(b.project_planned, 9), due_at: at(b.project_due, 17), template_id: t.id, sort: tables.projects.length, created_at: now(), updated_at: now() };
          reviewSchedule(np);
          tables.projects.push(np);
          (b.tag_ids || []).forEach((g) => { if (tables.tags.some((x) => x.id === g)) tables.project_tags.push({ project_id: pid, tag_id: g, user_id: uid }); });
          const add = (list, parent, depth) => (list || []).forEach((a, i) => {
            if (!String(a.title || '').trim()) return;
            const nt = { ...DEFAULTS.tasks(), id: id(), user_id: uid, title: a.title, notes: a.notes || '', project_id: pid, parent_id: parent, in_inbox: false, flagged: !!a.flagged,
              estimate_minutes: a.estimate_minutes || null, steps_in_order: !!a.steps_in_order, defer_at: at(a.defer, 0), planned_at: at(a.planned, 9), due_at: at(a.due, 17), sort: i, source: 'template', created_at: now(), updated_at: now() };
            tables.tasks.push(nt);
            (a.tag_ids || []).forEach((g) => { if (tables.tags.some((x) => x.id === g)) tables.task_tags.push({ task_id: nt.id, tag_id: g, user_id: uid }); });
            if (depth < 4) add(a.steps, nt.id, depth + 1);
          });
          add(b.actions, null, 1);
          t.last_run_at = now();
          return { data: pid, error: null };
        }
        return { data: null, error: { message: `function ${name} does not exist` } };
      },
      auth: {
        onAuthStateChange(cb) { setTimeout(() => cb('SIGNED_IN', { user }), 0); return { data: { subscription: { unsubscribe() {} } } }; },
        signOut() {}, signInWithPassword: async () => ({ error: null }), signUp: async () => ({ data: {}, error: null }),
        async getSession() { return { data: { session: { access_token: 'mock-jwt', user } } }; },
      },
    }),
  };
})();
