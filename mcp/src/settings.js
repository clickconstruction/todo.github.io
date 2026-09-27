// Settings for agents: what the app's Settings page, Customize sidebar and the mind sweep's own
// prompts keep in user_settings. API tokens and approved senders are not here: they stay app-only.
import { TRIGGERS } from '../../js/weekly.js';

// As js/sidebar.js (GROUPS, FIXED): the views in each sidebar group, and the two that can't be hidden.
const SIDEBAR = {
  do: ['forecast', 'now', 'matrix', 'flagged', 'nearby'],
  organize: ['projects', 'tags', 'perspectives', 'checklists'],
  lists: ['waiting', 'someday', 'tickler', 'events', 'reference', 'reading', 'slipbox'],
  reflect: ['full', 'daily', 'weekly', 'horizons'],
};
const FIXED = ['forecast', 'projects'];
const VIEWS = Object.values(SIDEBAR).flat();
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const TIMES = { due_time: 'due_minutes', planned_time: 'planned_minutes', defer_time: 'defer_minutes', review_time: 'review_minutes', daily_time: 'daily_minutes' };
const FLAGS = ['review_notify', 'daily_notify', 'daily_weekdays_only'];
const RANGES = { waiting_followup_days: [1, 60], matrix_urgent_days: [1, 60] };

export function settingsTools() {
  const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const minutes = (v, field) => {
    const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(v).trim());
    if (!m) throw new Error(`${field} is a time like "17:00"`);
    return Number(m[1]) * 60 + Number(m[2]);
  };
  const named = (rows, v, what, label = 'name') => {
    const key = String(v).trim().toLowerCase();
    const hits = rows.filter((r) => r.id === v || String(r[label]).toLowerCase() === key);
    if (hits.length !== 1) throw new Error(hits.length ? `More than one ${what} is called "${v}". Pass its id.` : `No ${what} called "${v}".`);
    return hits[0].id;
  };
  const shape = (s, tagName, placeName) => ({
    time_zone: s.timezone || undefined,
    due_time: hhmm(s.due_minutes ?? 1020), planned_time: hhmm(s.planned_minutes ?? 540), defer_time: hhmm(s.defer_minutes ?? 0),
    today_tag: tagName || null, distance_from: placeName || null,
    review_day: DAYS[s.review_day ?? 5], review_time: hhmm(s.review_minutes ?? 900), review_notify: s.review_notify ?? true,
    daily_notify: s.daily_notify ?? false, daily_time: hhmm(s.daily_minutes ?? 420), daily_weekdays_only: s.daily_weekdays_only ?? true,
    waiting_followup_days: s.waiting_followup_days ?? 7, matrix_urgent_days: s.matrix_urgent_days ?? 7,
    todo_folder: s.todo_folder || null, folder_shortcut: s.folder_shortcut || 'Open in Finder',
    sidebar: { hidden: (s.sidebar && s.sidebar.hidden) || [], order: (s.sidebar && s.sidebar.order) || {} },
    mind_sweep: { hidden_prompts: (s.trigger_hidden || []).length, yours: (s.trigger_custom || []).map((c) => ({ id: c.id, group: c.group, prompt: c.text })) },
  });

  return [{
    name: 'settings',
    description: `The user's account settings, as on the app's Settings page. Change one only when they ask.
actions: get · set {any of the fields below} · sidebar {hide?, show?, order? ({group: [views, first to last]}), reset?} · sweep_prompt {add: {group: Work|Personal, prompt}} or {hide: a prompt's text} or {remove: id of one of theirs} or {restore_hidden: true}
set fields: due_time, planned_time, defer_time ("HH:MM", the time of day a plain date lands at) · today_tag (a tag whose actions always show in Today; null for none) · distance_from (the saved place distances are measured from; null for none) · review_day (Sunday…Saturday), review_time, review_notify (the Weekly Review reminder) · daily_notify, daily_time, daily_weekdays_only (the morning reminder) · waiting_followup_days, matrix_urgent_days (1 to 60) · todo_folder (the folder on their Mac that holds actions' files), folder_shortcut (the Shortcut that opens one).
Sidebar views: ${Object.entries(SIDEBAR).map(([g, v]) => `${g}: ${v.join(', ')}`).join(' · ')} (${FIXED.join(' and ')} can't be hidden).
The time zone follows their device. API tokens, approved email senders and each device's notifications are set in the app.`,
    inputSchema: { type: 'object', properties: {
      action: { type: 'string', enum: ['get', 'set', 'sidebar', 'sweep_prompt'], default: 'get' },
      due_time: { type: 'string' }, planned_time: { type: 'string' }, defer_time: { type: 'string' },
      today_tag: { type: ['string', 'null'], description: 'Tag name or id' }, distance_from: { type: ['string', 'null'], description: 'Saved place name or id' },
      review_day: { type: 'string', enum: DAYS }, review_time: { type: 'string' }, review_notify: { type: 'boolean' },
      daily_notify: { type: 'boolean' }, daily_time: { type: 'string' }, daily_weekdays_only: { type: 'boolean' },
      waiting_followup_days: { type: 'integer' }, matrix_urgent_days: { type: 'integer' },
      todo_folder: { type: ['string', 'null'] }, folder_shortcut: { type: ['string', 'null'] },
      hide: { type: ['array', 'string'], items: { type: 'string' }, description: 'sidebar: views to hide; sweep_prompt: the text of the prompt to hide' },
      show: { type: 'array', items: { type: 'string' }, description: 'sidebar: views to show again' },
      order: { type: 'object', description: 'sidebar: {group: [views, first to last]}' }, reset: { type: 'boolean', description: 'sidebar: back to the default' },
      add: { type: 'object', properties: { group: { type: 'string', enum: ['Work', 'Personal'] }, prompt: { type: 'string' } } },
      remove: { type: 'string' }, restore_hidden: { type: 'boolean' },
    } },
    async run(api, a) {
      const action = a.action || 'get';
      const [row] = await api.q(`user_settings?${api.u}&select=*`);
      const cur = row || {};
      const save = async (body) => {
        const rows = row ? await api.q(`user_settings?${api.u}`, { method: 'PATCH', prefer: 'return=representation', body })
          : await api.q('user_settings', { method: 'POST', prefer: 'return=representation', body: { user_id: api.userId, ...body } });
        const s = { ...cur, ...body, ...(rows[0] || {}) };
        api.settings = s;
        return s;
      };
      const out = async (s) => {
        const [tags, places] = await Promise.all([
          s.forecast_tag_id ? api.q(`tags?${api.u}&id=eq.${s.forecast_tag_id}&select=id,name`) : [],
          s.distance_place_id ? api.q(`places?${api.u}&id=eq.${s.distance_place_id}&select=id,name`) : [],
        ]);
        return shape(s, (tags[0] || {}).name, (places[0] || {}).name);
      };

      if (action === 'set') {
        const body = {};
        Object.entries(TIMES).forEach(([k, col]) => { if (a[k] !== undefined) body[col] = minutes(a[k], k); });
        FLAGS.forEach((k) => { if (a[k] !== undefined) { if (typeof a[k] !== 'boolean') throw new Error(`${k} is true or false`); body[k] = a[k]; } });
        Object.entries(RANGES).forEach(([k, [lo, hi]]) => { if (a[k] !== undefined) { const n = Number(a[k]); if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`${k} is a whole number from ${lo} to ${hi}`); body[k] = n; } });
        if (a.review_day !== undefined) { const i = DAYS.findIndex((d) => d.toLowerCase() === String(a.review_day).trim().toLowerCase()); if (i < 0) throw new Error('review_day is a day of the week, e.g. Friday'); body.review_day = i; }
        if (a.today_tag !== undefined) body.forecast_tag_id = a.today_tag === null || a.today_tag === '' ? null : named(await api.q(`tags?${api.u}&select=id,name`), a.today_tag, 'tag');
        if (a.distance_from !== undefined) body.distance_place_id = a.distance_from === null || a.distance_from === '' ? null : named(await api.q(`places?${api.u}&archived_at=is.null&select=id,name`), a.distance_from, 'saved place');
        if (a.todo_folder !== undefined) { const v = String(a.todo_folder || '').trim(); if (v.length > 500) throw new Error('todo_folder is at most 500 characters'); body.todo_folder = v || null; }
        if (a.folder_shortcut !== undefined) { const v = String(a.folder_shortcut || '').trim(); if (v.length > 100) throw new Error('folder_shortcut is at most 100 characters'); body.folder_shortcut = v || 'Open in Finder'; }
        if (!Object.keys(body).length) throw new Error('Nothing to change. Pass the settings to set.');
        return out(await save(body));
      }

      if (action === 'sidebar') {
        const known = (list, what) => { const l = (Array.isArray(list) ? list : [list]).map(String); const bad = l.filter((k) => !VIEWS.includes(k)); if (bad.length) throw new Error(`${what}: no sidebar view called ${bad.join(', ')}. Views: ${VIEWS.join(', ')}.`); return l; };
        if (a.reset) return out(await save({ sidebar: {} }));
        const was = { hidden: [], order: {}, ...(cur.sidebar || {}) };
        const hide = a.hide !== undefined ? known(a.hide, 'hide') : [];
        const show = a.show !== undefined ? known(a.show, 'show') : [];
        const stuck = hide.filter((k) => FIXED.includes(k));
        if (stuck.length) throw new Error(`${stuck.join(' and ')} can’t be hidden: the app starts from ${stuck.length > 1 ? 'them' : 'it'}.`);
        const order = { ...was.order };
        if (a.order !== undefined) {
          if (!a.order || typeof a.order !== 'object' || Array.isArray(a.order)) throw new Error('order is {group: [views, first to last]}');
          Object.entries(a.order).forEach(([g, keys]) => {
            if (!SIDEBAR[g]) throw new Error(`No sidebar group called ${g}. Groups: ${Object.keys(SIDEBAR).join(', ')}.`);
            const l = known(keys, `order ${g}`);
            const out = l.filter((k) => !SIDEBAR[g].includes(k));
            if (out.length) throw new Error(`${out.join(', ')} ${out.length > 1 ? 'are' : 'is'} not in ${g} (${SIDEBAR[g].join(', ')}). Views stay in their group.`);
            order[g] = [...new Set(l)];
          });
        }
        if (!hide.length && !show.length && a.order === undefined) throw new Error('Pass hide, show, order or reset.');
        const hidden = [...new Set([...was.hidden, ...hide])].filter((k) => !show.includes(k));
        return out(await save({ sidebar: { ...was, hidden, order } }));
      }

      if (action === 'sweep_prompt') {
        const custom = cur.trigger_custom || []; const hidden = cur.trigger_hidden || [];
        if (a.restore_hidden) return out(await save({ trigger_hidden: [] }));
        if (a.add) {
          const text = String(a.add.prompt || '').trim().slice(0, 200);
          if (!text) throw new Error('add.prompt is required');
          const group = String(a.add.group || 'Personal').toLowerCase() === 'work' ? 'Work' : 'Personal';
          return out(await save({ trigger_custom: [...custom, { id: `c${Date.now().toString(36)}`, group, text }] }));
        }
        if (a.remove) {
          if (!custom.some((c) => c.id === a.remove)) throw new Error('No prompt of theirs with that id. settings get lists them (mind_sweep.yours).');
          return out(await save({ trigger_custom: custom.filter((c) => c.id !== a.remove) }));
        }
        if (typeof a.hide === 'string' && a.hide.trim()) {
          const key = a.hide.trim().toLowerCase();
          const t = TRIGGERS.find((x) => x.id === a.hide || x.text.toLowerCase() === key);
          if (!t) throw new Error(`No built-in prompt "${a.hide}". mind_sweep_prompts lists them; one of their own is taken out with remove.`);
          return out(await save({ trigger_hidden: [...new Set([...hidden, t.id])] }));
        }
        throw new Error('Pass add, hide, remove or restore_hidden.');
      }

      return out(cur);
    },
  }];
}
