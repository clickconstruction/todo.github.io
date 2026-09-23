// UI smoke test. Open http://localhost:8765/?mock, then in the console (or the
// Browser pane): `const { run } = await import('/dev/smoke.js'); await run()`.
// Returns [{ name, ok, detail }]; also logs a summary. Resets mock data first.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
// Lower-cased so CSS text-transform (uppercase section titles) doesn't matter; compare with lower-case needles.
const text = (s = '#view') => ($(s) ? $(s).innerText.replace(/\s+/g, ' ').toLowerCase() : '');
const has = (s, ...needles) => { const t = text(s); return needles.every((n) => t.includes(n.toLowerCase())); };
const go = async (hash) => { location.hash = hash; await wait(120); };
const T = () => window.__mock.tables;

// Reset mock data and reload it through the app's own modules (same instances the page uses).
async function reload() {
  window.__mock.reset();
  window.__forceSheet = true; window.__forceWide = false; // suites use the sheet unless they opt in
  const insp = await import('/js/state.js'); insp.app.selected = null;
  try { localStorage.removeItem('todo.filter'); localStorage.removeItem('todo.collapsed'); } catch { /* ignore */ }
  const { app } = await import('/js/state.js');
  app.review = null; app.reviewStats = null; app.here = null; app.locationState = null;
  window.__noMaps = true; // never call Google from tests
  (await import('/js/alerts.js')).resetAlertState();
  window.__geo = { state: 'prompt', position: { lat: 29.7610, lng: -95.3705, accuracy: 20 } }; // ~400 ft from mock Home Depot
  try { ['todo.here', 'todo.nearby.within', 'todo.geo.alerts', 'todo.geo.key'].forEach((k) => localStorage.removeItem(k)); } catch { /* ignore */ }
  const { setFilter } = await import('/js/filter.js');
  setFilter({ show: 'remaining', fits: 0 });
  const [{ loadAll }, { render }] = await Promise.all([import('/js/data.js'), import('/js/router.js')]);
  await loadAll();
  location.hash = '#inbox';
  render();
  await wait(100);
}

export async function run({ only } = {}) {
  window.confirm = () => true;
  window.prompt = () => 'Smoke tag';
  const results = [];
  const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: String(detail).slice(0, 160) });
  const suites = { core, planned, projectTypes, groups, signals, filters, forecast, review, inspector, nearby, alerts, errands };
  for (const [name, fn] of Object.entries(suites)) {
    if (only && !only.includes(name)) continue;
    await reload();
    try { await fn(check); } catch (e) { check(`${name}: threw`, false, e.stack || e.message); }
    if ($('#sheet').open) $('#sheet').close();
  }
  window.__forceSheet = false; window.__forceWide = false; window.__geo = undefined; window.__noMaps = false;
  const failed = results.filter((r) => !r.ok);
  console.log(`smoke: ${results.length - failed.length}/${results.length} passed`, failed);
  return { passed: results.length - failed.length, total: results.length, failed, results };
}

// Behaviour that existed before the feature phases; must never regress.
async function core(check) {
  await go('#inbox');
  check('inbox lists inbox items', has(undefined, 'Frog Pond EIN') && has(undefined, '2 items to clarify'), text());

  const input = $('[data-capture] input');
  input.value = 'Smoke capture';
  $('[data-capture]').requestSubmit();
  await wait(150);
  check('capture adds to inbox', has(undefined, 'Smoke capture') && T().tasks.some((t) => t.title === 'Smoke capture' && t.in_inbox !== false));

  $('[data-check="t12"]').click();
  await wait(150);
  check('complete shows Add note + Undo', has('#toast', 'Add note') && has('#toast', 'Undo'), text('#toast'));
  check('completion recorded', !!T().tasks.find((t) => t.id === 't12').completed_at);

  $('[data-task="t13"]').click();
  await wait(100);
  const form = $('#editor');
  check('editor opens', !!form);
  form.elements.project_id.value = 'p1';
  form.elements.project_id.dispatchEvent(new Event('change'));
  form.requestSubmit();
  await wait(150);
  const t13 = T().tasks.find((t) => t.id === 't13');
  check('clarify moves out of inbox', t13.project_id === 'p1' && t13.in_inbox === false, JSON.stringify({ p: t13.project_id, inbox: t13.in_inbox }));

  $('[data-task="t13"]') || (await go('#project/p1'));
  $('[data-task="t13"]').click();
  await wait(100);
  $('[data-drop]').click();
  await wait(150);
  check('drop sets dropped_at', !!T().tasks.find((t) => t.id === 't13').dropped_at);
  check('drop shows Undo', has('#toast', 'Dropped'), text('#toast'));

  await go('#projects');
  check('projects grouped by folder', has(undefined, 'PRIORITIES') && has(undefined, 'Click Plumbing') && has(undefined, 'Personal'), text());

  await go('#project/p1');
  check('project lists its actions', has(undefined, 'Call GVEC') && has(undefined, 'Order fittings'), text());

  await go('#tags');
  check('tags view', has(undefined, 'Laptop') && has(undefined, 'Hiro'), text());

  await go('#search/jodi');
  await wait(350);
  check('search finds open + completed', has(undefined, 'Order fittings for Jodi') && has(undefined, 'Send Jodi the plumbing plans'), text());

  await go('#done/week/all');
  await wait(200);
  check('done view shows completions', has(undefined, 'Send Jodi the plumbing plans'), text());

  await go('#settings');
  await wait(200);
  check('settings lists approved sender', has(undefined, 'robert@douglasmining.com'), text());

  const del = await window.sb.from('tasks').delete().eq('id', 't1');
  check('mock mirrors no-delete rule', !!del.error, del.error && del.error.message);
}

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dayOffset = (n) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + n); return d; };

// P1: Planned date + one-tap date buttons.
async function planned(check) {
  await go('#inbox');
  $('[data-task="t13"]').click();
  await wait(100);
  const form = $('#editor');
  const q = (name, step) => $(`[data-qd="${name}"][data-step="${step}"]`, form).click();
  check('editor has defer/planned/due fields', form.elements.defer_at && form.elements.planned_at && form.elements.due_at);
  q('planned_at', 'today');
  check('Today button', form.elements.planned_at.value === ymd(dayOffset(0)), form.elements.planned_at.value);
  q('planned_at', '+1w');
  check('+1w steps from current value', form.elements.planned_at.value === ymd(dayOffset(7)), form.elements.planned_at.value);
  q('due_at', '+1d');
  check('+1d from empty = tomorrow', form.elements.due_at.value === ymd(dayOffset(1)), form.elements.due_at.value);
  q('due_at', 'clear');
  check('clear empties', form.elements.due_at.value === '');
  q('defer_at', '+1m');
  const m = dayOffset(0); m.setMonth(m.getMonth() + 1);
  check('+1m from empty', form.elements.defer_at.value === ymd(m), form.elements.defer_at.value);
  q('defer_at', 'clear');
  form.requestSubmit();
  await wait(150);
  const t = T().tasks.find((x) => x.id === 't13');
  const pd = new Date(t.planned_at);
  check('planned saved at 9am local, +7 days', pd.getHours() === 9 && ymd(pd) === ymd(dayOffset(7)), t.planned_at);
  check('due and defer stay empty', !t.due_at && !t.defer_at, JSON.stringify({ due: t.due_at, defer: t.defer_at }));
  check('row shows planned date', $('[data-task="t13"] .meta-planned') !== null, $('[data-task="t13"]') && $('[data-task="t13"]').innerText);

  await go('#forecast/today');
  check('Forecast today lists planned-today items', has(undefined, 'Planned', 'Order fittings for Jodi'), text());
  check('Forecast today lists due + overdue banner', has(undefined, 'Get plans released', '1 overdue'), text());
}

// P2: project types, availability, reorder, complete with last action.
async function projectTypes(check) {
  const { isAvailable, nextAction } = await import('/js/availability.js');
  const { db } = await import('/js/state.js');
  const task = (id) => db.tasks.find((t) => t.id === id);
  const proj = (id) => db.projects.find((p) => p.id === id);

  check('sequential: only the head is available', isAvailable(task('t4')) && !isAvailable(task('t5')) && !isAvailable(task('t7')));
  check('sequential: group (not head) and its children blocked', !isAvailable(task('t6')) && !isAvailable(task('t8')));
  check('single actions: all available except deferred', isAvailable(task('t11')) && !isAvailable(task('t10')));
  check('on-hold project: nothing available', !db.tasks.filter((t) => t.project_id === 'p5').some(isAvailable));

  await go('#project/p2');
  check('project view marks Next', $('[data-task="t4"] .chip.next') !== null);
  check('blocked actions dimmed', $('[data-task="t5"]').classList.contains('blocked'));
  check('shows project type chip', has(undefined, 'Sequential'));

  await go('#projects');
  check('project row shows next action', has(undefined, 'Next: Write recovery instructions'), text());

  await go('#project/p2');
  $('[data-check="t4"]').click();
  await wait(200);
  check('completing head advances next', nextAction(proj('p2')).id === 't5', nextAction(proj('p2')) && nextAction(proj('p2')).title);

  // Reorder: move "Order fittings" (t2) above "Call GVEC" (t1) in p1.
  await go('#project/p1');
  $('[data-act="toggle-reorder"]').click();
  await wait(100);
  check('reorder handles appear', $$('[data-move]').length > 0);
  $('[data-move="t2"][data-dir="-1"]').click();
  await wait(200);
  const order = $$('#view [data-task]').map((el) => el.dataset.task);
  check('move up reorders', order.indexOf('t2') < order.indexOf('t1'), order.join(','));
  $('[data-act="toggle-reorder"]').click();

  // New project actions append at the end.
  const input = $('[data-capture] input');
  input.value = 'Smoke last action';
  $('[data-capture]').requestSubmit();
  await wait(200);
  const orderAfter = $$('#view [data-task]').map((el) => el.dataset.task);
  const added = db.tasks.find((t) => t.title === 'Smoke last action');
  check('new action appends to the end', added && orderAfter[orderAfter.length - 1] === added.id, orderAfter.join(','));

  // Complete with last action: p3 has one open action (t9).
  await go('#project/p3');
  $('[data-check="t9"]').click();
  await wait(250);
  check('project auto-completes with last action', proj('p3').status === 'completed', proj('p3').status);
  check('toast says the project is done too', has('#toast', 'is done too'), text('#toast'));
  $$('#toast button').find((b) => b.textContent === 'Undo').click();
  await wait(300);
  check('undo reopens action and project', !task('t9').completed_at && proj('p3').status === 'active', `${task('t9').completed_at} ${proj('p3').status}`);

  // Editor: change type + auto-complete.
  await go('#project/p1');
  $('[data-edit-project="p1"]').click();
  await wait(100);
  const f = $('#project-form');
  f.querySelector('input[name=kind][value=sequential]').checked = true;
  f.querySelector('input[name=kind][value=sequential]').dispatchEvent(new Event('change', { bubbles: true }));
  check('kind hint updates', has('.kind-hint', 'only the next action'), text('.kind-hint'));
  f.elements.complete_with_last.checked = true;
  f.requestSubmit();
  await wait(200);
  check('editor saves type + auto-complete', proj('p1').kind === 'sequential' && proj('p1').complete_with_last === true, `${proj('p1').kind} ${proj('p1').complete_with_last}`);
}

// P3: action groups.
async function groups(check) {
  const { db } = await import('/js/state.js');
  const task = (id) => db.tasks.find((t) => t.id === id);
  try { localStorage.removeItem('todo.collapsed'); } catch { /* ignore */ }
  await go('#project/p2');
  check('group row has disclosure + count', $('[data-toggle-group="t6"]') !== null && has('[data-task="t6"]', '2 of 2 left'), text('[data-task="t6"]'));
  check('children visible when expanded', $('[data-task="t7"]') !== null && $('[data-task="t8"]') !== null);
  $('[data-toggle-group="t6"]').click();
  await wait(100);
  check('collapse hides children', $('[data-task="t7"]') === null && $('[data-toggle-group="t6"]').textContent === '▸');
  check('collapse remembered', JSON.parse(localStorage.getItem('todo.collapsed') || '[]').includes('t6'));
  $('[data-toggle-group="t6"]').click();
  await wait(100);
  check('expand shows children', $('[data-task="t7"]') !== null);

  window.prompt = () => 'Smoke sub-action';
  check('row + only on groups', $('[data-add-sub="t6"]') !== null && $('[data-add-sub="t4"]') === null);
  $('[data-task="t4"]').click();
  await wait(100);
  $('[data-sub]').click();
  await wait(250);
  const sub = db.tasks.find((t) => t.title === 'Smoke sub-action');
  check('editor + Sub-action makes a group', sub && sub.parent_id === 't4' && sub.project_id === 'p2' && $('[data-toggle-group="t4"]') !== null);

  $('[data-task="t6"]').click();
  await wait(100);
  check('group editor: parent disabled', $('#editor').elements.parent_id.disabled && has('#editor', 'This is a group'));
  $('#sheet').close();

  $('[data-check="t7"]').click();
  await wait(200);
  check('group stays open with one child left', !task('t6').completed_at);
  $('[data-check="t8"]').click();
  await wait(250);
  check('group completes with its last child', !!task('t6').completed_at);

  let asked = '';
  window.confirm = (m) => { asked = m; return true; };
  $('[data-check="t4"]').click();
  await wait(250);
  check('completing a group asks first', asked.includes('1 open action'), asked);
  check('group completion closes its open children', !!task('t4').completed_at && !!db.tasks.find((t) => t.title === 'Smoke sub-action').completed_at);
  window.confirm = () => true;
}

// P4: estimates, row signals, project flags and tags.
async function signals(check) {
  const { db } = await import('/js/state.js');
  const task = (id) => db.tasks.find((t) => t.id === id);
  const proj = (id) => db.projects.find((p) => p.id === id);

  await go('#project/p1');
  check('notes icon on rows with notes', $('[data-task="t1"] .sig-note') !== null && $('[data-task="t2"] .sig-note') === null);
  check('estimate chip', has('[data-task="t1"]', '15m'), text('[data-task="t1"]'));
  $('[data-flag="t2"]').click();
  await wait(200);
  check('tap-to-flag sets flag', task('t2').flagged === true && $('[data-flag="t2"]').classList.contains('on'));
  $('[data-flag="t2"]').click();
  await wait(200);
  check('tap again unflags', task('t2').flagged === false);
  check('flag click does not open editor', !$('#sheet').open);

  $('[data-task="t2"]').click();
  await wait(100);
  const f = $('#editor');
  $('[data-qe="15"]', f).click(); $('[data-qe="15"]', f).click();
  check('estimate quick buttons add up', f.elements.estimate_minutes.value === '30', f.elements.estimate_minutes.value);
  f.requestSubmit();
  await wait(200);
  check('estimate saved', task('t2').estimate_minutes === 30, task('t2').estimate_minutes);
  check('estimate shown on row', has('[data-task="t2"]', '30m'));

  $('[data-flag-project="p1"]').click();
  await wait(200);
  check('project flag toggle', proj('p1').flagged === true);

  await go('#project/p3');
  $('[data-edit-project="p3"]').click();
  await wait(100);
  const pf = $('#project-form');
  $('[data-tag="g2"]', pf).click(); // Phone
  pf.requestSubmit();
  await wait(250);
  check('project tags saved', db.projectTags.some((x) => x.project_id === 'p3' && x.tag_id === 'g2'));
  check('project header shows its tags', has(undefined, 'Phone'));

  await go('#tag/g2');
  check('tag view includes actions inherited from tagged project', has(undefined, 'Measure driveway', 'Call GVEC', 'tagged project'), text());
  await go('#tags');
  const laptopRow = $$('#view a.group-row').find((a) => a.textContent.includes('Laptop'));
  check('tag counts include inherited actions', laptopRow && Number(laptopRow.querySelector('.count').textContent) >= 4, laptopRow && laptopRow.textContent);
  await go('#projects');
  check('project row shows flag + tags', has(undefined, 'Laptop') && $$('#view a.group-row .meta-flag').length >= 1);
}

// P5: view filter + Flagged view + More.
async function filters(check) {
  const setSel = async (name, value) => {
    const sel = $(`[data-filter="${name}"]`);
    sel.value = String(value);
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(150);
  };
  const ids = () => $$('#view [data-task]').map((el) => el.dataset.task);

  await go('#project/p2');
  check('filter bar on project view', $('[data-filter="show"]') !== null && $('[data-filter="fits"]') !== null);
  check('remaining shows all open', ['t4', 't5', 't6', 't7', 't8'].every((id) => ids().includes(id)), ids().join(','));
  await setSel('show', 'available');
  check('available: sequential shows only the head', ids().join(',') === 't4', ids().join(','));
  check('filter remembered', JSON.parse(localStorage.getItem('todo.filter')).show === 'available');

  await go('#project/p1');
  await setSel('show', 'remaining');
  await setSel('fits', 15);
  check('fits ≤15 keeps estimated ≤15 only', ids().join(',') === 't1', ids().join(','));
  check('explains hidden unestimated', has('.filter-note', '2 without an estimate'), text('.filter-note'));
  await setSel('fits', 0);

  await go('#project/p3');
  await setSel('show', 'all');
  await wait(250);
  check('all includes dropped items (fetched)', ids().includes('d1'), ids().join(','));
  await setSel('show', 'remaining');
  check('remaining hides dropped', !ids().includes('d1'));

  await go('#flagged');
  check('flagged: flagged actions + flagged project actions', ['t3', 't10', 't11'].every((id) => ids().includes(id)), ids().join(','));
  check('flagged grouped by project', has(undefined, 'Click Plumbing', 'Errands'));
  await setSel('show', 'available');
  check('flagged available hides deferred', ids().includes('t11') && !ids().includes('t10'), ids().join(','));
  check('flagged badge = available count', $('#badge-flagged').textContent === '2', $('#badge-flagged').textContent);
  await setSel('show', 'remaining');

  const more = $('#more-tab');
  check('More tab exists', !!more);
  more.click();
  await wait(100);
  check('More sheet lists Review, Tags, Done, Search, Settings', has('#sheet', 'Review', 'Tags', 'Done', 'Search', 'Settings'), text('#sheet'));
  $('#sheet [href="#tags"]').click();
  await wait(150);
  check('More link navigates and closes', location.hash === '#tags' && !$('#sheet').open);
}

// P6: Forecast (replaces Today) and Past triage.
async function forecast(check) {
  const { db } = await import('/js/state.js');
  const task = (id) => db.tasks.find((t) => t.id === id);
  location.hash = '#today';
  await wait(150);
  check('#today redirects to Forecast', location.hash === '#forecast' && has(undefined, 'Forecast'), location.hash);
  check('strip: Past, Today, 6 days, Future', $$('.fc-day').length === 9, $$('.fc-day').length);
  check('forecast badge = due today + overdue', $('#badge-forecast').textContent === '2', $('#badge-forecast').textContent);
  const d2 = $$('.fc-day')[3]; // Past, Today, +1, +2
  d2.click();
  await wait(150);
  check('future day shows planned item', has(undefined, 'Measure driveway'), text());
  await go('#forecast/future');
  check('future bucket', has(undefined, 'Nothing scheduled beyond') || $$('#view [data-task]').length >= 0);

  await go('#forecast/past');
  check('Past lists overdue deadlines', has(undefined, 'Overdue (due)', 'Call GVEC'), text());
  $('[data-triage="due-to-planned"]').click();
  await wait(250);
  const t1 = task('t1');
  const p = new Date(t1.planned_at);
  check('triage: due cleared, planned today 9am', !t1.due_at && p.getHours() === 9 && p.toDateString() === new Date().toDateString(), JSON.stringify({ due: t1.due_at, planned: t1.planned_at }));
  check('triage toast offers Undo', has('#toast', 'Planned today', 'Undo'), text('#toast'));
  $$('#toast button').find((b) => b.textContent === 'Undo').click();
  await wait(250);
  check('undo restores the deadline', !!task('t1').due_at && !task('t1').planned_at, JSON.stringify({ due: task('t1').due_at, planned: task('t1').planned_at }));

  await go('#forecast/today');
  $('[data-check="t3"]').click();
  await wait(200);
  check('completed item stays visible (struck) for Undo', $('[data-task="t3"]') && $('[data-task="t3"]').classList.contains('completed'));
}

// P7: Review.
async function review(check) {
  const { db } = await import('/js/state.js');
  const proj = (id) => db.projects.find((p) => p.id === id);
  check('review badge counts due projects', $('#badge-review').textContent === '4', $('#badge-review').textContent);
  await go('#review');
  check('queue header', has(undefined, 'Project 1 of 4'), text().slice(0, 120));
  check('oldest-due first (on-hold project)', has('.review-title', 'Doctor integration'), text('.review-title'));

  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true }));
  await wait(150);
  check('j moves to next project', has(undefined, 'Project 2 of 4'), text().slice(0, 80));
  $$('[data-review-go]')[0].click();
  await wait(150);
  check('‹ goes back', has(undefined, 'Project 1 of 4'));

  $('[data-mark-reviewed]').click();
  await wait(250);
  const p5 = proj('p5');
  check('mark reviewed stamps last_reviewed', !!p5.last_reviewed_at && new Date(p5.next_review_at) > new Date(), `${p5.last_reviewed_at} ${p5.next_review_at}`);
  check('advances and shrinks the queue', has(undefined, 'of 3') && !has('.review-title', 'Doctor integration'), text().slice(0, 120));

  // Find Click Plumbing (has an overdue action) in the queue.
  location.hash = '#review/p1';
  await wait(200);
  check('hint: overdue with Forecast fix', has('.hints', '1 overdue') && $('[data-review-fix="forecast"]') !== null, text('.hints'));
  check('next action marked in review list', $('[data-task="t1"] .chip.next') !== null);
  const sel = $('[data-review-interval="p1"]');
  sel.value = '30';
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  await wait(200);
  check('interval change saves + reschedules', proj('p1').review_every_days === 30, proj('p1').review_every_days);
  const notes = $('[data-review-notes="p1"]');
  notes.value = 'Reviewed in smoke';
  notes.dispatchEvent(new Event('change', { bubbles: true }));
  await wait(200);
  check('inline notes save', proj('p1').notes === 'Reviewed in smoke');

  location.hash = '#review/p4';
  await wait(400); // lazy last-completion lookup re-renders
  check('hint: nothing ever completed (lazy history)', has('.hints', 'Nothing has ever been completed'), text('.hints'));
  check('stale hint offers hold/drop', $('[data-review-fix="hold"]') !== null && $('[data-review-fix="drop"]') !== null);
  // Defer Errands' only available action: nothing can be done now.
  const { updateTask } = await import('/js/data.js');
  const future = new Date(); future.setDate(future.getDate() + 5);
  await updateTask(db.tasks.find((t) => t.id === 't11'), { defer_at: future.toISOString() });
  await wait(150);
  check('hint: every action deferred', has('.hints', 'Every action is deferred'), text('.hints'));
  $('[data-review-fix="add"]').click();
  await wait(50);
  check('Add-action fix focuses capture', document.activeElement && document.activeElement.id === 'review-capture');

  for (let i = 0; i < 5 && $('[data-mark-reviewed]'); i++) { $('[data-mark-reviewed]').click(); await wait(250); }
  check('all caught up screen', has(undefined, 'All caught up', 'You reviewed 4 projects'), text());
  check('badge clears', $('#badge-review').textContent === '');
}

// P8: desktop inspector.
async function inspector(check) {
  const { db } = await import('/js/state.js');
  const task = (id) => db.tasks.find((t) => t.id === id);
  const proj = (id) => db.projects.find((p) => p.id === id);
  window.__forceSheet = false; window.__forceWide = true;
  const { renderInspector } = await import('/js/inspector.js');
  await go('#project/p1');
  renderInspector(true);
  check('empty selection shows the page project', $('#inspector [data-inspector-project="p1"]') !== null);
  $('[data-task="t1"] .row-title').click();
  await wait(150);
  const f = () => $('#inspector form');
  check('click selects instead of opening a sheet', !$('#sheet').open && f() && f().dataset.inspectorTask === 't1');
  check('selected row highlighted', $('[data-task="t1"]').classList.contains('selected'));

  f().elements.title.value = 'Call GVEC (inspector)';
  f().elements.title.dispatchEvent(new Event('change', { bubbles: true }));
  await wait(700);
  check('title autosaves', task('t1').title === 'Call GVEC (inspector)', task('t1').title);
  check('save state shown', has('#inspector .save-state', 'Saved'), text('#inspector .save-state'));

  $('#inspector [data-qd="planned_at"][data-step="today"]').click();
  await wait(700);
  check('quick date autosaves', !!task('t1').planned_at);
  $('#inspector [data-tag="g1"]').click();
  await wait(700);
  check('tag toggle autosaves', db.taskTags.some((x) => x.task_id === 't1' && x.tag_id === 'g1'));

  const input = f().elements.notes;
  input.focus();
  input.value = 'typing…';
  const { render } = await import('/js/router.js');
  render(); // e.g. a background refresh while typing
  check('does not re-render while typing', $('#inspector [name=notes]') === input && input.value === 'typing…');
  input.blur();
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await wait(700);
  check('notes save on blur', task('t1').notes === 'typing…', task('t1').notes);

  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  await wait(200);
  check('↓ moves selection', f().dataset.inspectorTask === 't2', f() && f().dataset.inspectorTask);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await wait(150);
  check('Esc clears to the page project', $('#inspector [data-inspector-project="p1"]') !== null);

  const seq = $('#inspector input[name=kind][value=sequential]');
  seq.checked = true;
  seq.dispatchEvent(new Event('change', { bubbles: true }));
  await wait(700);
  check('project inspector autosaves type', proj('p1').kind === 'sequential', proj('p1').kind);
  window.__forceWide = false;
}

// Places, location, Nearby, distance sort and inheritance.
async function nearby(check) {
  const { db } = await import('/js/state.js');
  const task = (id) => db.tasks.find((t) => t.id === id);
  const { placeFor } = await import('/js/places.js');
  window.confirm = () => true;

  await go('#nearby');
  check('no location: asks to turn it on', has(undefined, 'turn on location') && !!$('[data-act="request-location"]'));
  check('no actions at places yet', has(undefined, 'no actions at your places'));
  check('archived place not offered', !has(undefined, 'old storage'));

  // Give an action a place through the editor.
  $('[data-act="request-location"]').click();
  await wait(150);
  check('location granted: card gone, nearest-first sort offered', !$('.loc-card') && !!$('[data-filter="sort"]'));
  await go('#project/p4');
  $('[data-task="t11"] .row-title').click();
  await wait(100);
  const f = $('#editor');
  check('editor has location field, detail hidden with no place', !!f.elements.place_id && $('.loc-detail', f).hidden);
  check('places list distances', [...f.elements.place_id.options].some((o) => /Home Depot · 400 ft/.test(o.text)), [...f.elements.place_id.options].map((o) => o.text).join('|'));
  f.elements.place_id.value = 'pl1';
  f.elements.place_id.dispatchEvent(new Event('change', { bubbles: true }));
  $('input[name=location_trigger][value=arrive]', f).checked = true;
  f.requestSubmit();
  await wait(200);
  check('place + alert saved', task('t11').place_id === 'pl1' && task('t11').location_trigger === 'arrive' && task('t11').location_radius_m === null);
  check('row shows place chip with distance, marked here', has('[data-task="t11"]', 'home depot', '400 ft') && !!$('[data-task="t11"] .meta-place.here'));

  await go('#nearby');
  check('nearby lists the place and you are here', has(undefined, 'home depot', 'you’re here', 'buy fuel filter'));
  check('nearby badge counts actions you are inside', $('#badge-nearby').textContent === '1', $('#badge-nearby').textContent);

  // New place from inside the editor (stacked dialog), using current location.
  await go('#project/p3');
  $('[data-task="t9"] .row-title').click();
  await wait(100);
  const f2 = $('#editor');
  f2.elements.place_id.value = '__new';
  f2.elements.place_id.dispatchEvent(new Event('change', { bubbles: true }));
  check('+ New place opens on top of the editor', $('#sheet2').open && $('#sheet').open);
  const pf = $('#sheet2 form');
  pf.requestSubmit();
  await wait(50);
  check('place needs a location before saving', has('#sheet2', 'choose where it is'));
  $('[data-here]', pf).click();
  await wait(100);
  pf.elements.name.value = 'Jobsite A';
  $('[data-radius="152"]', pf).click();
  pf.requestSubmit();
  await wait(200);
  const jobsite = T().places.find((p) => p.name === 'Jobsite A');
  check('new place saved with radius', jobsite && jobsite.radius_m === 152);
  check('editor selects the new place, defaults to Arriving', f2.elements.place_id.selectedOptions[0].text === 'Jobsite A' && $('input[name=location_trigger]:checked', f2).value === 'arrive');
  $('[data-cancel]', f2).click();

  // Tag places are inherited: by tagged actions, their sub-actions, and project tags.
  await go('#tag/g1');
  $('[data-edit-tag="g1"]').click();
  await wait(100);
  const tf = $('#tag-form');
  tf.elements.place_id.value = 'pl2';
  tf.elements.place_id.dispatchEvent(new Event('change', { bubbles: true }));
  tf.requestSubmit();
  await wait(200);
  check('tag place saved', T().tags.find((t) => t.id === 'g1').place_id === 'pl2');
  check('tagged action inherits', (placeFor(task('t6')) || {}).via?.kind === 'tag');
  check('sub-action inherits through its group', (placeFor(task('t7')) || {}).via?.kind === 'group');
  check('project tag is inherited', (placeFor(task('t2')) || {}).via?.kind === 'project tag');
  $('[data-task="t6"] .row-title').click();
  await wait(100);
  check('editor shows inherited place', has('#editor .loc-field', 'office via tag'));
  $('#editor [data-cancel]').click();

  // Nearest first.
  const { setFilter, sortTasks } = await import('/js/filter.js');
  const { taskSort } = await import('/js/state.js');
  setFilter({ sort: 'distance' });
  const order = sortTasks([task('t6'), task('t12'), task('t11')], taskSort).map((t) => t.id);
  check('nearest first: 400 ft before 2.7 mi, no place last', order.join() === 't11,t6,t12', order.join());
  setFilter({ sort: 'default' });

  // Within filter hides far places.
  await go('#nearby');
  const within = $('[data-within]');
  within.value = '1609';
  within.dispatchEvent(new Event('change', { bubbles: true }));
  await wait(100);
  check('within 1 mi hides the office (2.7 mi)', has(undefined, 'home depot') && !has('.place-section:last-of-type', 'office'));
  $('[data-within]').value = '0';
  $('[data-within]').dispatchEvent(new Event('change', { bubbles: true }));

  // Archive, never delete.
  await go('#places');
  check('places list shows radius and counts', has(undefined, 'home depot', '¼ mi radius'));
  $('[data-edit-place="pl2"]').click();
  await wait(50);
  $('#sheet2 [data-archive]').click();
  await wait(200);
  check('archived place stops applying', !!T().places.find((p) => p.id === 'pl2').archived_at && !placeFor(task('t6')));
  const del = await window.sb.from('places').delete().eq('id', 'pl1');
  check('places cannot be deleted', !!del.error);

  // Denied: explain how to turn it back on, offer retry.
  const { app } = await import('/js/state.js');
  (await import('/js/geo.js')).stopWatching();
  window.__geo.state = 'denied'; // so a background re-watch can't restore a position
  app.here = null; app.locationState = 'denied';
  await go('#nearby');
  check('denied shows how to fix and Try again', has(undefined, 'location is off', 'try again'));
}

// Location alerts engine (while the app is open) and the background-alerts setup screen.
async function alerts(check) {
  const { db } = await import('/js/state.js');
  const { evaluate } = await import('/js/alerts.js');
  const got = [];
  window.__notify = (n) => got.push(n);
  const home = { lat: 29.7600, lng: -95.3700 }; // mock Home Depot, radius 402 m
  const at = (metersNorth, accuracy = 20) => ({ lat: home.lat + metersNorth / 111320, lng: home.lng, accuracy });
  const set = (id, fields) => Object.assign(db.tasks.find((t) => t.id === id), fields);
  set('t11', { place_id: 'pl1', location_trigger: 'arrive' });
  set('t2', { place_id: 'pl1', location_trigger: 'leave' });
  set('t10', { place_id: 'pl1', location_trigger: 'arrive' }); // deferred: must never alert

  let out = evaluate(at(2000));
  check('first fix outside: nothing fires', out.length === 0);
  out = evaluate(at(100));
  check('arriving fires once, grouped per place, skips deferred', out.length === 1 && out[0].event === 'arrive' && out[0].tasks.map((t) => t.id).join() === 't11', JSON.stringify(out.map((o) => [o.event, o.tasks.map((t) => t.id)])));
  check('notification names the place and action', got[0] && got[0].title.includes('Home Depot') && got[0].body.includes('Buy fuel filter') && got[0].url === '#nearby/pl1');
  check('staying inside does not repeat', evaluate(at(50)).length === 0);
  check('edge jitter (inside the margin) does not count as leaving', evaluate(at(420)).length === 0);
  out = evaluate(at(1500));
  check('leaving fires for leave alerts only', out.length === 1 && out[0].event === 'leave' && out[0].tasks[0].id === 't2');
  check('a wildly inaccurate fix is ignored', evaluate(at(50, 5000)).length === 0);

  set('t11', { location_trigger: 'nearby' });
  out = evaluate(at(60), Date.now());
  check('nearby fires while inside', out.some((o) => o.event === 'nearby'));
  check('nearby waits 4 hours before repeating', !evaluate(at(60), Date.now() + 3600e3).some((o) => o.event === 'nearby'));
  check('nearby repeats after 4 hours', evaluate(at(60), Date.now() + 5 * 3600e3).some((o) => o.event === 'nearby'));
  set('t11', { completed_at: new Date().toISOString() });
  check('completed actions never alert', !evaluate(at(60), Date.now() + 10 * 3600e3).some((o) => o.tasks.some((t) => t.id === 't11')));
  window.__notify = undefined;

  // Setup screen.
  await go('#alerts');
  check('alerts screen explains both modes', has(undefined, 'while the app is open', 'in the background (iphone)', 'shortcuts'));
  check('no key yet: URLs hidden, test disabled', !$('[data-copy-geo]') && $('[data-act="test-alert"]').disabled);
  $('[data-act="create-geo-key"]').click();
  await wait(250);
  const key = T().api_tokens.find((t) => t.scope === 'geo');
  check('location key stored hashed with geo scope', key && key.token_hash.length === 64 && !JSON.stringify(key).includes(localStorage.getItem('todo.geo.key')));
  const urls = $$('[data-copy-geo]').map((b) => b.dataset.copyGeo);
  check('per-place Arrive/Leave URLs use the key', urls.length >= 2 && urls.every((u) => u.startsWith('https://mcp.todotooling.com/geo?t=tt_') && /&place=pl\d&event=(arrive|leave)$/.test(u)), urls[0]);
  check('Home Depot marked as needing Leave (t2)', has('.alert-place', 'home depot', 'leave'));
  await go('#settings');
  for (let i = 0; i < 20 && !has(undefined, 'location alerts only'); i++) await wait(100); // tokens load async
  check('settings labels location keys', has(undefined, 'location alerts only'));
}

// Errand run planner (offline fallback order in tests; Google Routes is used live).
async function errands(check) {
  const { db } = await import('/js/state.js');
  // Write through the mock database too, so a background reload can't undo the setup.
  const set = (id, fields) => { Object.assign(T().tasks.find((t) => t.id === id), fields); Object.assign(db.tasks.find((t) => t.id === id), fields); };
  set('t11', { place_id: 'pl1' }); // Home Depot, 400 ft away
  set('t1', { place_id: 'pl2' }); // Office, 2.7 mi
  set('t10', { place_id: 'pl2' }); // deferred: doesn't count
  const { requestLocation } = await import('/js/geo.js');
  await requestLocation();
  await go('#nearby');
  check('errand button shows with 2+ places', !!$('[data-act="errand-run"]'));
  $('[data-act="errand-run"]').click();
  await wait(100);
  const f = $('#sheet form');
  check('planner lists places with available action counts', has('#sheet', 'home depot', '1 action', 'office', '1 action'));
  f.requestSubmit();
  await wait(200);
  check('route ordered nearest-next without Google', $$('.errand-order li').map((li) => li.innerText.split(' ')[0]).join() === 'Home,Office', $$('.errand-order li').map((li) => li.innerText).join('|'));
  const link = $('[data-maps-link]');
  check('opens Google Maps directions with waypoints and a round trip', link && link.href.startsWith('https://www.google.com/maps/dir/?api=1') && link.href.includes('waypoints=') && link.target === '_blank');
  $('#sheet').close();
}
