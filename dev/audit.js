// Viewport audit: visits every view and sheet and reports layout/accessibility problems.
window.__audit = async function audit() {
  const w = (ms) => new Promise((r) => setTimeout(r, ms));
  const { db, app } = await import('/js/state.js');
  const results = [];
  const vw = innerWidth;
  const inspect = (name) => {
    const probs = [];
    if (document.documentElement.scrollWidth > vw + 1) probs.push(`page scrolls sideways (${document.documentElement.scrollWidth}px)`);
    const root = document.querySelector('dialog[open]') || document.querySelector('#view');
    const els = [...root.querySelectorAll('*')].filter((e) => e.offsetParent !== null || e.tagName === 'DIALOG');
    const over = els.filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.right > vw + 2 && !e.closest('.fc-strip, .kbd, .import-tree, .tpl-rows') && getComputedStyle(e).position !== 'fixed'; });
    if (over.length) probs.push(`off-screen right: ${[...new Set(over.slice(0, 6).map((e) => (e.className && typeof e.className === 'string' ? '.' + e.className.split(' ')[0] : e.tagName)))].join(', ')}`);
    if (vw < 600) {
      const small = [...root.querySelectorAll('button, a, input[type=checkbox], select')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && (r.height < 24 || r.width < 24) && !e.closest('.kbd, .row-meta, .hint, p, .persp-sub, .section-title') && !(e.matches('input') && e.closest('label') && e.closest('label').getBoundingClientRect().height >= 24) && e.offsetParent; });
      if (small.length) probs.push(`small tap targets: ${small.length} (${[...new Set(small.slice(0, 5).map((e) => (e.getAttribute('aria-label') || e.textContent || e.className).trim().slice(0, 18)))].join(' | ')})`);
    }
    const unlabeled = [...root.querySelectorAll('button, a[href]')].filter((e) => e.offsetParent && !(e.textContent.trim() || e.getAttribute('aria-label') || e.title));
    if (unlabeled.length) probs.push(`buttons without a label: ${unlabeled.length}`);
    const inputs = [...root.querySelectorAll('input:not([type=hidden]), select, textarea')].filter((e) => e.offsetParent && !(e.labels && e.labels.length) && !e.getAttribute('aria-label') && !e.placeholder && !e.title);
    if (inputs.length) probs.push(`fields without a label: ${inputs.length} (${inputs.slice(0, 3).map((e) => e.name || e.dataset && Object.keys(e.dataset)[0] || e.type).join(', ')})`);
    // overlapping fixed FAB over content buttons at the bottom of the view
    results.push({ name, probs });
  };
  const go = async (h) => { location.hash = h; await w(220); };
  const views = ['#inbox', '#forecast', '#forecast/past', '#flagged', '#projects', '#project/p1', '#project/p2', '#tags', '#tag/g1', '#review', '#nearby', '#places', '#alerts', '#done', '#search/jodi', '#settings', '#perspectives', '#import'];
  for (const v of views) { await go(v); inspect(v); }
  // perspectives / templates if seeded
  if (db.perspectives[0]) { await go(`#perspective/${db.perspectives[0].id}`); inspect('#perspective'); }
  if (db.templates && db.templates[0]) { await go(`#template/${db.templates[0].id}`); inspect('#template'); }
  // sheets
  window.__forceSheet = true;
  const sheet = async (name, open) => { await open(); await w(200); inspect(name); const d = document.querySelector('dialog[open]'); if (d) d.close(); document.querySelectorAll('dialog[open]').forEach((x) => x.close()); await w(50); };
  const T = await import('/js/editors/task.js');
  const P = await import('/js/editors/project.js');
  await sheet('sheet: edit action', () => T.openEditor(db.tasks.find((t) => t.id === 't1')));
  await sheet('sheet: new action', () => T.openEditor(null));
  await sheet('sheet: quick entry', () => T.openQuickEntry());
  await sheet('sheet: edit project', () => P.openProjectEditor(db.projects.find((p) => p.id === 'p1')));
  const Pe = await import('/js/editors/perspective.js');
  await sheet('sheet: new perspective', () => Pe.openNewPerspective());
  await sheet('sheet: perspective editor', () => Pe.openPerspectiveEditor(null, { name: 'X', rules: { match: 'all', rules: [{ type: 'tag', tags: ['g2'] }, { match: 'any', rules: [{ type: 'date', field: 'due', when: 'next', days: 7 }] }] } }));
  const Bd = await import('/js/editors/breakdown.js');
  await sheet('sheet: break it down', () => Bd.openBreakdown(db.tasks.find((t) => t.id === 't6')));
  const St = await import('/js/editors/steps.js');
  await sheet('sheet: part-of picker', () => St.openPartOfPicker(db.tasks.find((t) => t.id === 't11'), () => {}));
  const F = await import('/js/editors/focus.js');
  await sheet('sheet: focus', () => F.openFocusPicker());
  const K = await import('/js/shortcuts.js');
  await sheet('sheet: shortcuts', () => K.openShortcuts());
  const Tp = await import('/js/views/templates.js');
  await sheet('sheet: new template', () => Tp.openNewTemplate());
  await sheet('sheet: save as template', () => Tp.openSaveAsTemplate(db.projects.find((p) => p.id === 'p2')));
  if (db.templates && db.templates[0]) await sheet('sheet: use template', () => Tp.openUseTemplate(db.templates[0]));
  document.querySelector('#more-tab').click(); await w(150); inspect('sheet: more'); document.querySelectorAll('dialog[open]').forEach((x) => x.close());
  window.__forceSheet = false;
  await go('#inbox');
  return results.filter((r) => r.probs.length);
};

// Realistic, awkward data for the audit: a perspective, a template, a calendar, long unbroken text.
window.__seedAudit = async () => {
  window.__mock.reset();
  const T = window.__mock.tables;
  const pad = (n) => String(n).padStart(2, '0'); const d = new Date(); const ymd = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  window.__calendarFetch = async () => ['BEGIN:VCALENDAR', 'X-WR-CALNAME:Work', 'BEGIN:VEVENT', 'UID:a', `DTSTART:${ymd}T140000`, `DTEND:${ymd}T150000`, 'SUMMARY:Quarterly planning with the whole Click Construction leadership team and outside advisors', 'LOCATION:1000 Main Street, Suite 400, Houston, TX 77002', 'END:VEVENT', 'BEGIN:VEVENT', 'UID:b', `DTSTART;VALUE=DATE:${ymd}`, 'SUMMARY:Out', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  T.tasks.push({ id: 'long1', user_id: 'u1', project_id: 'p1', parent_id: null, in_inbox: false, title: 'Supercalifragilisticexpialidocious_unbroken_identifier_https://example.com/a/very/long/url/that/does/not/wrap/nicely/at/all', notes: 'x'.repeat(400), flagged: true, due_at: new Date(Date.now() + 86400000).toISOString(), planned_at: null, defer_at: null, estimate_minutes: 90, completed_at: null, dropped_at: null, sort: 9, source: 'app', place_id: null, location_trigger: null, location_radius_m: null, repeat_rule: { every: 2, unit: 'week', from: 'assigned' }, steps_in_order: false, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
  ['g1', 'g2', 'g3', 'g4'].forEach((g) => T.task_tags.push({ task_id: 'long1', tag_id: g, user_id: 'u1' }));
  T.projects.find((p) => p.id === 'p1').name = 'Click Plumbing — commercial remodel for the downtown office building (phase 2)';
  const { loadAll } = await import('/js/data.js'); await loadAll();
  const { savePerspective } = await import('/js/perspectives.js');
  await savePerspective(null, { name: 'Calls and quick wins from every project', icon: '📞', rules: { v: 1, match: 'any', rules: [{ type: 'tag', tags: ['g2'] }, { type: 'duration', op: 'max', minutes: 15 }] }, options: { show: 'remaining', group_by: 'project', sort_by: 'project', layout: 'tree' }, badge: true });
  const { STARTERS } = await import('/js/templates.js');
  const { sb, run, db } = await import('/js/state.js');
  const [tpl] = await run(sb.from('project_templates').insert({ name: STARTERS[0].name, icon: STARTERS[0].icon, body: STARTERS[0].body, sort: 0 }).select()); db.templates.push(tpl);
  const { addCalendar } = await import('/js/calendars.js'); await addCalendar({ name: 'Work', url: 'https://calendar.google.com/calendar/ical/x/private-abc/basic.ics', color: '#1D9E75', count: 2 });
};
