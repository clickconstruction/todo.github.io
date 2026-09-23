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
      sort: 0, created_at: at(-20), updated_at: at(-1), ...o });
    const P = (o) => ({ user_id: uid, folder_id: null, notes: '', status: 'active', kind: 'parallel', complete_with_last: false, flagged: false,
      review_every_days: 7, last_reviewed_at: null, next_review_at: null, completed_at: null, sort: 0, created_at: at(-30), updated_at: at(-1), ...o });
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
      api_tokens: [], email_senders: [{ id: 'e1', user_id: uid, email: 'robert@douglasmining.com', created_at: at(-10) }],
    };
  }

  let tables;
  const reset = () => { n = 0; tables = seed(); tables.projects.forEach(reviewSchedule); window.__mock.tables = tables; };

  // ----- mirrored database rules -----
  const isOpen = (t) => !t.completed_at && !t.dropped_at;
  function reviewSchedule(p) {
    const base = new Date(p.last_reviewed_at || p.created_at || now());
    base.setDate(base.getDate() + (p.review_every_days || 7));
    p.next_review_at = base.toISOString();
  }
  function projectStatusChange(p, oldStatus) {
    const closed = (s) => s === 'completed' || s === 'dropped';
    if (closed(p.status) && !closed(oldStatus)) p.completed_at = now();
    else if (!closed(p.status)) p.completed_at = null;
  }
  function taskRules(t, before) {
    const wasOpen = !before || isOpen(before);
    if (wasOpen && !isOpen(t)) {
      tables.tasks.filter((c) => c.parent_id === t.id && isOpen(c)).forEach((c) => {
        if (t.completed_at) c.completed_at = t.completed_at; else c.dropped_at = t.dropped_at;
      });
    }
    if (t.parent_id) {
      const parent = tables.tasks.find((x) => x.id === t.parent_id);
      const kids = tables.tasks.filter((x) => x.parent_id === t.parent_id);
      if (parent && !isOpen(t) && !kids.some(isOpen) && kids.some((k) => k.completed_at) && isOpen(parent)) {
        const b = { ...parent }; parent.completed_at = now(); taskRules(parent, b);
      } else if (parent && isOpen(t) && parent.completed_at) {
        parent.completed_at = null;
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
  // Column defaults the real database fills in (and returns) on insert.
  const DEFAULTS = {
    tasks: () => ({ project_id: null, parent_id: null, in_inbox: true, notes: '', completion_note: '', flagged: false, defer_at: null, planned_at: null,
      due_at: null, estimate_minutes: null, completed_at: null, dropped_at: null, source: 'app' }),
    projects: () => ({ folder_id: null, notes: '', status: 'active', kind: 'parallel', complete_with_last: false, flagged: false, review_every_days: 7,
      last_reviewed_at: null, completed_at: null }),
    folders: () => ({ archived_at: null }),
    tags: () => ({ parent_id: null }),
  };
  const NO_DELETE = { tasks: 'tasks are archived, not deleted.', projects: 'projects are archived, not deleted.', folders: 'folders are archived, not deleted.' };

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
        rows.push(...add);
        add.forEach((r) => { if (table === 'projects') { reviewSchedule(r); projectStatusChange(r, null); } if (table === 'tasks') taskRules(r, null); });
        return { data: add.map(copy), error: null };
      }
      if (st.op === 'update') {
        const hit = rows.filter(match);
        hit.forEach((r) => {
          const before = { ...r };
          Object.assign(r, st.payload, { updated_at: now() });
          if (table === 'projects') { reviewSchedule(r); projectStatusChange(r, before.status); }
          if (table === 'tasks') taskRules(r, before);
        });
        return { data: hit.map(copy), error: null };
      }
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
      auth: {
        onAuthStateChange(cb) { setTimeout(() => cb('SIGNED_IN', { user }), 0); return { data: { subscription: { unsubscribe() {} } } }; },
        signOut() {}, signInWithPassword: async () => ({ error: null }), signUp: async () => ({ data: {}, error: null }),
      },
    }),
  };
})();
