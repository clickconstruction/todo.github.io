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
  (await import('/js/prefs.js')).setFocus(null);
  window.__forceSheet = true; window.__forceWide = false; // suites use the sheet unless they opt in
  const insp = await import('/js/state.js'); insp.app.selected = null;
  try { localStorage.removeItem('todo.filter'); localStorage.removeItem('todo.collapsed'); } catch { /* ignore */ }
  const { app } = await import('/js/state.js');
  app.review = null; app.reviewStats = null; app.here = null; app.locationState = null;
  window.__noMaps = true; // never call Google from tests
  window.__noRefresh = true; // no background reloads mid-suite (the pane's visibility flips)
  (await import('/js/alerts.js')).resetAlertState();
  window.__geo = { state: 'prompt', position: { lat: 29.7610, lng: -95.3705, accuracy: 20 } }; // ~400 ft from mock Home Depot
  try { ['todo.here', 'todo.nearby.within', 'todo.geo.alerts', 'todo.geo.key', 'todo.geo.done', 'todo.alerts.nudge', 'todo.alerts.seen'].forEach((k) => localStorage.removeItem(k)); } catch { /* ignore */ }
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
  const suites = { core, planned, projectTypes, groups, steps, perspectives, layout, omnifocusImport, onHoldTags, templates, focusMode, datesSettings, keyboard, signals, filters, forecast, review, inspector, nearby, alerts, errands, parity, repeat, reminders, attachments, history };
  for (const [name, fn] of Object.entries(suites)) {
    if (only && !only.includes(name)) continue;
    await reload();
    try { await fn(check); } catch (e) { check(`${name}: threw`, false, e.stack || e.message); }
    if ($('#sheet').open) $('#sheet').close();
  }
  window.__forceSheet = false; window.__forceWide = false; window.__geo = undefined; window.__noMaps = false; window.__noRefresh = false;
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
  check('group row has disclosure + progress', $('[data-toggle-group="t6"]') !== null && has('[data-task="t6"]', '0 of 2 done') && !!$('[data-task="t6"] .step-progress'), text('[data-task="t6"]'));
  check('children visible when expanded', $('[data-task="t7"]') !== null && $('[data-task="t8"]') !== null);
  $('[data-toggle-group="t6"]').click();
  await wait(100);
  check('collapse hides children and shows Next', $('[data-task="t7"]') === null && $('[data-toggle-group="t6"]').textContent === '▸' && has('[data-task="t6"]', 'next: asset holdings list'));
  check('collapse remembered', JSON.parse(localStorage.getItem('todo.collapsed') || '[]').includes('t6'));
  $('[data-toggle-group="t6"]').click();
  await wait(100);
  check('expand shows children', $('[data-task="t7"]') !== null);
  check('row + only on groups', $('[data-add-sub="t6"]') !== null && $('[data-add-sub="t4"]') === null);

  $('[data-check="t7"]').click();
  await wait(200);
  check('group stays open with one child left', !task('t6').completed_at);
  $('[data-check="t8"]').click();
  await wait(250);
  check('group completes with its last child', !!task('t6').completed_at);
}

// Steps ("eat the elephant"): break down, in order, progress, move, depth, cascade, convert.
async function steps(check) {
  const { db } = await import('/js/state.js');
  const task = (id) => db.tasks.find((t) => t.id === id);
  const find = (title) => db.tasks.find((t) => t.title === title);
  const { openEditor } = await import('/js/editors/task.js');
  const { splitSteps } = await import('/js/editors/breakdown.js');
  check('pasted lists are cleaned', JSON.stringify(splitSteps('- [ ] Buy screws\n2) Measure\n\n• Clear shelves\n* [x] Sweep')) === '["Buy screws","Measure","Clear shelves","Sweep"]');

  // Break down an Inbox item from its editor: paste a list, type one more, do in order.
  await go('#inbox');
  openEditor(task('t13'));
  await wait(100);
  check('editor offers Break it down', has('#editor .steps-field', 'too big to do in one go') && !!$('#editor [data-breakdown]'));
  $('#editor [data-breakdown]').click();
  await wait(100);
  const dlg = $('#sheet2');
  check('breakdown sheet opens on top', dlg.open && has('#sheet2', 'break it down', 'build a 2m telescope'));
  const dt = new DataTransfer();
  dt.setData('text/plain', '- [ ] Research mirror grinding\n2) Order a 16-inch mirror blank\n• Build the grinding stand');
  $('[name=step]', dlg).dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  await wait(50);
  const inp = $('[name=step]', dlg);
  inp.value = 'Build the tube and mount';
  inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await wait(50);
  check('paste adds one step per line; Enter adds one more', $$('#sheet2 .breakdown-list li').length === 4 && has('#sheet2 [type=submit]', 'add 4 steps'), text('#sheet2'));
  $$('#sheet2 [data-bd-move]').find((b) => b.dataset.bdMove === '3' && b.dataset.dir === '-1').click(); // tube above stand
  $('#sheet2 [name=in_order]').click();
  $('#sheet2 [name=step]').value = 'Grind and polish the mirror'; // typed but not added: kept on submit
  $('#sheet2 form').requestSubmit();
  await wait(400);
  const kids = db.tasks.filter((t) => t.parent_id === 't13').sort((a, b) => a.sort - b.sort).map((t) => t.title);
  check('steps saved in order, typed text kept', JSON.stringify(kids) === JSON.stringify(['Research mirror grinding', 'Order a 16-inch mirror blank', 'Build the tube and mount', 'Build the grinding stand', 'Grind and polish the mirror']), kids.join(' | '));
  check('do in order saved; steps left the Inbox', task('t13').steps_in_order && db.tasks.filter((t) => t.parent_id === 't13').every((t) => !t.in_inbox));
  check('editor Steps section redraws in place', has('#editor .steps-field', '0 of 5 done', 'grind and polish the mirror') && $('#editor [name=steps_in_order]').checked);
  $('#sheet').close();

  // Inbox shows the tree; in order: first step is Next, the rest wait.
  await go('#inbox');
  const first = find('Research mirror grinding'); const second = find('Order a 16-inch mirror blank');
  check('inbox shows the item with its steps', !!$(`[data-task="${first.id}"]`) && has('[data-task="t13"]', '0 of 5 done', 'in order'));
  check('in order: first step is Next, later ones wait', has(`[data-task="${first.id}"]`, 'next') && $(`[data-task="${second.id}"]`).classList.contains('blocked'));
  const { isAvailable } = await import('/js/availability.js');
  check('availability follows the order', isAvailable(first) && !isAvailable(second) && !isAvailable(task('t13')));

  // Break a step down further (+ on the row opens the sheet for that step).
  const grind = find('Grind and polish the mirror');
  const { breakDown } = await import('/js/data.js');
  await breakDown(grind, ['Rough grind', 'Fine grind', 'Polish']);
  await wait(100);
  check('progress counts the smallest steps', has('[data-task="t13"]', '0 of 7 done'), text('[data-task="t13"]'));
  $(`[data-add-sub="${grind.id}"]`).click();
  await wait(100);
  check('row + opens Break it down for that step', $('#sheet2').open && has('#sheet2', 'grind and polish the mirror', 'rough grind'));
  $('#sheet2 [data-bd-cancel]').click();
  await wait(50);

  // Complete a step: progress moves, Next moves on.
  $(`[data-check="${first.id}"]`).click();
  await wait(250);
  check('completing a step advances Next', has('[data-task="t13"]', '1 of 7 done') && has(`[data-task="${second.id}"]`, 'next'));

  // Depth: 4 levels max (the database refuses deeper).
  const rough = find('Rough grind');
  const [lvl4] = await breakDown(rough, ['Buy grit']);
  let err = '';
  try { await breakDown(lvl4, ['Too deep']); } catch (e) { err = e.message || String(e); }
  check('a 5th level is refused', !find('Too deep') && /4 levels/.test(err), err);
  openEditor(lvl4);
  await wait(100);
  check('deepest step says so, no Break it down', has('#editor .steps-field', 'deepest') && !$('#editor [data-breakdown]'));
  $('#sheet').close();

  // Part of: move a project action under another task; it follows that task's project.
  openEditor(task('t11'));
  await wait(100);
  $('#editor [data-part-of]').click();
  await wait(100);
  check('Part of picker lists tasks grouped by project', $('#sheet2').open && has('#sheet2', 'make it a step of', 'click plumbing'));
  const search = $('#sheet2 [data-po-search]');
  search.value = 'fittings'; search.dispatchEvent(new Event('input'));
  check('picker search narrows', $$('#sheet2 [data-po]').filter((b) => b.dataset.po).length === 1);
  $('#sheet2 [data-po="t2"]').click();
  await wait(50);
  check('picking sets the label and locks the project', has('#editor .part-of', 'order fittings for jodi') && $('#editor').elements.project_id.disabled && $('#editor').elements.project_id.value === 'p1' && has('#editor [data-project-follows]', 'click plumbing · from its task'));
  $('#editor').requestSubmit();
  await wait(300);
  check('moved under, into its project', task('t11').parent_id === 't2' && task('t11').project_id === 'p1');
  const { openPartOfPicker } = await import('/js/editors/steps.js');
  openPartOfPicker(task('t2'), () => {});
  check('the picker never offers the task itself or its steps', !$('#sheet2 [data-po="t2"]') && !$('#sheet2 [data-po="t11"]') && !!$('#sheet2 [data-po="t1"]'));
  $('#sheet2').close();
  // Moving the parent to another project takes its steps along.
  const { updateTask } = await import('/js/data.js');
  await updateTask(task('t2'), { project_id: 'p3' });
  await wait(150);
  check('steps follow their parent to another project', task('t11').project_id === 'p3');

  // Reorder mode: ⇥ under the item above, ⇤ back out.
  await go('#project/p2');
  $('[data-act="toggle-reorder"]').click();
  await wait(100);
  $('[data-indent="t5"]').click();
  await wait(250);
  check('⇥ makes it a step of the item above', task('t5').parent_id === 't4');
  $('[data-outdent="t5"]').click();
  await wait(250);
  check('⇤ moves it back up a level, after its old parent', !task('t5').parent_id && task('t5').sort > task('t4').sort && task('t5').sort < task('t6').sort);
  $('[data-act="toggle-reorder"]').click();
  await wait(100);

  // Finish every step: the elephant completes and we celebrate it.
  await go('#inbox');
  const open = () => db.tasks.filter((t) => t.parent_id && !t.completed_at && !t.dropped_at).filter((t) => {
    let p = t; for (let i = 0; i < 6 && p.parent_id; i++) p = task(p.parent_id); return p.id === 't13';
  });
  let toastText = '';
  for (let i = 0; i < 12 && open().length; i++) {
    const leaf = open().find((t) => !db.tasks.some((c) => c.parent_id === t.id && !c.completed_at && !c.dropped_at));
    const { setCompleted } = await import('/js/data.js');
    await setCompleted(leaf, true);
    await wait(60);
    toastText = text('#toast') || toastText;
  }
  check('last step completes the whole task', !!task('t13').completed_at);
  check('and celebrates it', toastText.includes('last step done') && toastText.includes('build a 2m telescope'), toastText);

  // Convert to project.
  await breakDown(task('t12'), ['Fill SS-4', 'Submit to IRS']);
  await wait(50);
  openEditor(task('t12'));
  await wait(100);
  $('#editor [data-to-project]').click();
  await wait(500);
  const proj = db.projects.find((p) => p.name === 'Frog Pond EIN');
  check('turn into a project: steps become its actions', proj && find('Fill SS-4').project_id === proj.id && !find('Fill SS-4').parent_id);
  const was = T().tasks.find((t) => t.id === 't12');
  check('the task is dropped with a note (not deleted)', !!was.dropped_at && /became the project/i.test(was.completion_note || '') && location.hash === `#project/${proj.id}`);
}

// Perspectives: templates, rule editor with live preview, view, menu, save view, archive.
async function perspectives(check) {
  const { db } = await import('/js/state.js');
  const P = () => db.perspectives.filter((p) => !p.archived_at);
  await go('#perspectives');
  check('perspectives: empty state invites a template', has(undefined, 'no perspectives yet'));
  $('[data-act="new-perspective"]').click();
  await wait(100);
  check('template picker lists templates with summaries', $$('#sheet [data-template]').length === 7 && has('#sheet', 'calls', 'available · tagged phone', 'quick wins', 'waiting for'));
  $('#sheet [data-template="calls"]').click();
  await wait(100);
  check('editor opens with a live preview', has('#sheet [data-preview]', '1 match now', 'call gvec about utilities'), text('#sheet [data-preview]'));
  // Add a rule: duration at most 10 → nothing matches (GVEC is 15m).
  $('#sheet [data-rule-add=""]:not([data-group])').click();
  await wait(50);
  const type = $('#sheet [data-rule-type="1"]');
  type.value = 'duration'; type.dispatchEvent(new Event('change', { bubbles: true }));
  await wait(50);
  const mins = $('#sheet [data-rule-field="1"][data-key="minutes"]');
  mins.value = '10'; mins.dispatchEvent(new Event('input', { bubbles: true }));
  await wait(50);
  check('preview updates as rules change', has('#sheet [data-preview]', '0 matches now', '10 min or less'), text('#sheet [data-preview]'));
  mins.value = '30'; mins.dispatchEvent(new Event('input', { bubbles: true }));
  $('#sheet [data-icon="⚡"]').click();
  $('#sheet form').requestSubmit();
  await wait(300);
  const calls = P().find((p) => p.name === 'Calls');
  check('saved and opened', calls && location.hash === `#perspective/${calls.id}` && calls.icon === '⚡' && calls.rules.rules.length === 2);
  check('view shows summary, groups with counts and matches', has(undefined, 'available · tagged phone · 30 min or less', 'click plumbing · 1', 'call gvec about utilities'), text());
  check('sidebar lists it', has('#nav-perspectives', 'calls'));
  // Completing keeps it visible (struck through) so Undo has context.
  $('[data-check="t1"]').click();
  await wait(300);
  check('a completed match stays until reload', !!$('[data-task="t1"].completed'));
  // Menu: badge, duplicate, archive.
  $(`[data-persp-menu="${calls.id}"]`).click();
  await wait(50);
  $('#sheet [data-m="dup"]').click();
  await wait(300);
  check('duplicate', P().some((p) => p.name === 'Calls copy') && location.hash.startsWith('#perspective/'));
  const copy = P().find((p) => p.name === 'Calls copy');
  $(`[data-persp-menu="${copy.id}"]`).click();
  await wait(50);
  $('#sheet [data-m="badge"]').click();
  await wait(250);
  check('badge toggle', db.perspectives.find((p) => p.id === copy.id).badge);
  await go('#perspectives');
  check('list shows both with summaries', $$('.persp-list .persp-row').length === 2 && has('.persp-list', 'calls copy'));
  $(`[data-persp-move="${copy.id}"][data-dir="-1"]`).click();
  await wait(250);
  check('reorder', $$('.persp-list .persp-name')[0].textContent === 'Calls copy');
  await go(`#perspective/${copy.id}`);
  $(`[data-persp-edit="${copy.id}"]`).click();
  await wait(100);
  $('#sheet [data-persp-archive]').click();
  await wait(300);
  check('archive: gone from the sidebar, listed as archived', !has('#nav-perspectives', 'calls copy') && has(undefined, 'archived · 1') && location.hash === '#perspectives');
  $(`[data-persp-restore="${copy.id}"]`).click();
  await wait(250);
  check('restore', has('#nav-perspectives', 'calls copy'));
  // Save the current view.
  await go('#flagged');
  $('[data-act="save-perspective"]').click();
  await wait(100);
  check('save view: flagged becomes a rule', $('#sheet [name=name]').value === 'Flagged' && has('#sheet [data-preview]', 'flagged'));
  $('#sheet [data-cancel]').click();
  // Straight into another sheet: the perspective editor's handlers must not act on it.
  const { openEditor } = await import('/js/editors/task.js');
  openEditor(db.tasks.find((t) => t.id === 't2'));
  await wait(50);
  $('#editor').requestSubmit();
  await wait(250);
  check('a closed perspective editor never acts on the next sheet', !db.perspectives.some((p) => p.name === 'Flagged') && !location.hash.startsWith('#perspective/'), location.hash);
  // A rule from a newer version warns instead of silently hiding things.
  const { savePerspective } = await import('/js/perspectives.js');
  const odd = await savePerspective(null, { name: 'Future', icon: '🔭', rules: { v: 1, match: 'all', rules: [] }, options: {} });
  odd.rules = { v: 2, match: 'all', rules: [{ type: 'near_me' }] };
  await go(`#perspective/${odd.id}`);
  check('unknown rules warn', has(undefined, 'newer version', 'doesn’t understand'));
  // Phones: More lists perspectives.
  $('#more-tab').click();
  await wait(100);
  check('More sheet lists perspectives', has('#sheet', 'perspectives', 'calls', 'calls copy', 'all perspectives'));
  $('#sheet').close();
}

// Editor layout: sections with summaries, rows that open to edit, remembered collapse.
async function layout(check) {
  const { db } = await import('/js/state.js');
  const { openEditor } = await import('/js/editors/task.js');
  try { localStorage.removeItem('todo.inspector.closed'); } catch { /* ignore */ }
  openEditor(db.tasks.find((t) => t.id === 't1'));
  await wait(120);
  const f = $('#editor');
  check('sections: Organize, Dates, Repeat and alerts, Status/files/history', ['organize', 'dates', 'alerts', 'more'].every((k) => $(`[data-sec="${k}"]`, f)));
  check('rows show values, empty ones say None', has('#editor [data-prop="due_at"]', 'due') && !$('[data-prop-val="due_at"]', f).classList.contains('is-empty') && $('[data-prop-val="planned_at"]', f).textContent === 'None');
  check('section summaries', has('#editor [data-sec-sum="organize"]', 'click plumbing', '1 tag') && has('#editor [data-sec-sum="dates"]', 'due'), text('#editor [data-sec-sum="organize"]') + ' | ' + text('#editor [data-sec-sum="dates"]'));
  check('quick buttons hidden until a row opens', !$('[data-qd="planned_at"]', f).offsetParent);
  $('[data-prop-toggle="planned_at"]', f).click();
  check('tapping a row opens its editor', !!$('[data-qd="planned_at"]', f).offsetParent && $('[data-prop="planned_at"]', f).classList.contains('open'));
  $('[data-qd="planned_at"][data-step="today"]', f).click();
  await wait(30);
  check('value updates as you edit', $('[data-prop-val="planned_at"]', f).textContent !== 'None' && has('#editor [data-sec-sum="dates"]', 'planned'));
  $('[data-prop-toggle="due_at"]', f).click();
  check('one row open at a time', !$('[data-prop="planned_at"]', f).classList.contains('open') && $('[data-prop="due_at"]', f).classList.contains('open'));
  check('Status section starts collapsed', $('[data-sec="more"]', f).classList.contains('closed'));
  $('[data-sec-toggle="alerts"]', f).click();
  check('collapse remembered', JSON.parse(localStorage.getItem('todo.inspector.closed')).includes('alerts'));
  f.requestSubmit();
  await wait(250);
  check('saving still reads hidden fields', !!T().tasks.find((t) => t.id === 't1').planned_at && T().tasks.find((t) => t.id === 't1').due_at);
  openEditor(db.tasks.find((t) => t.id === 't1'));
  await wait(80);
  check('collapsed section stays collapsed next time', $('#editor [data-sec="alerts"]').classList.contains('closed'));
  $('#sheet').close();
  try { localStorage.removeItem('todo.inspector.closed'); } catch { /* ignore */ }
  openEditor(db.tasks.find((t) => t.id === 't7')); // a step of “Inside deadmans switch”
  await wait(80);
  check('a step says which project it follows instead of a locked dropdown', $('#editor [name=project_id]').hidden && has('#editor [data-project-follows]', 'end of life planning · from its task'), text('#editor [data-project-follows]'));
  $('#sheet').close();
  const { openProjectEditor } = await import('/js/editors/project.js');
  openProjectEditor(db.projects.find((p) => p.id === 'p2'));
  await wait(120);
  check('project editor uses the same layout, with Review', ['organize', 'dates', 'review', 'alerts', 'more'].every((k) => $(`#sheet [data-sec="${k}"]`)) && has('#sheet [data-sec-sum="review"]', 'every'), text('#sheet [data-sec-sum="review"]'));
  $('#sheet').close();
}

// Import from OmniFocus: paste → preview (dry run) → import → idempotent → undo; TaskPaper; errors.
async function omnifocusImport(check) {
  const { db } = await import('/js/state.js');
  (await import('/js/views/import.js')).resetImport();
  const json = await (await fetch('/dev/fixtures/omnifocus-sample.json', { cache: 'no-store' })).text();
  const tp = await (await fetch('/dev/fixtures/omnifocus-sample.taskpaper', { cache: 'no-store' })).text();
  const until = async (fn, ms = 3000) => { for (let i = 0; i < ms / 50 && !fn(); i++) await wait(50); return fn(); };
  let clip = json;
  const realClip = Object.getOwnPropertyDescriptor(Navigator.prototype, 'clipboard');
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText: async () => clip, writeText: async (t) => { clip = t; } } });
  try {
    await go('#import');
    check('import: two ways in', has(undefined, 'copy from omnifocus', 'open omnifocus', 'or an export file') && $('[data-of-open]').getAttribute('href').startsWith('omnifocus://localhost/omnijs-run?script='));
    $('[data-of-copy-script]').click();
    await wait(50);
    check('copy the script (for the Mac console)', clip.includes('Pasteboard.general.string') && clip.includes('flattenedProjects'));
    clip = json;
    $('[data-of-paste]').click();
    await until(() => has(undefined, 'preview'));
    check('paste → preview, nothing saved yet', has(undefined, 'preview', 'nothing is saved yet') && !T().projects.some((p) => p.import_id) && !T().imports.length, text().slice(0, 200));
    check('preview counts', has('.import-stats', '3', 'projects', '9', 'open actions', '1', 'in the inbox'), text('.import-stats'));
    check('existing tags are shared, not duplicated', has('.import-notes', '3 tags match'), text('.import-notes'));
    check('warnings in plain words', has(undefined, 'moved up', 'repeat rule', 'attachment stays in omnifocus', 'notifications aren’t copied'));
    check('sample tree', has('.import-tree', 'click construction › clients › 🗂️ click plumbing', 'call gvec about utilities', 'inbox'));
    const sel = $('[data-of-completed]');
    sel.value = 'all'; sel.dispatchEvent(new Event('change', { bubbles: true }));
    await until(() => has(undefined, 'preview') && has('.import-notes', 'completed or dropped'));
    check('completed items are an option', has('.import-notes', 'completed or dropped item'), text('.import-notes'));
    const sel2 = $('[data-of-completed]');
    sel2.value = 'none'; sel2.dispatchEvent(new Event('change', { bubbles: true }));
    await until(() => has(undefined, 'preview') && !has('.import-notes', 'completed or dropped'));
    $('[data-of-import]').click();
    await until(() => has(undefined, 'imported'));
    check('import done', has('.import-ok', 'imported 3 projects, 9 actions and 1 new tag'), text('.import-ok'));
    const plumbing = db.projects.find((p) => p.name === 'Click Plumbing' && p.import_id);
    check('projects, folders, nesting and tags arrive', plumbing && plumbing.kind === 'sequential' && plumbing.review_every === 2
      && db.folders.some((f) => f.name === 'Click Construction › Clients') && db.tasks.some((t) => t.title === 'Measure' && t.parent_id)
      && db.taskTags.some((l) => l.tag_id === 'g2' && db.tasks.find((t) => t.id === l.task_id && t.title === 'Call GVEC about utilities' && t.import_id)));
    check('Inbox item lands in the Inbox', db.tasks.some((t) => t.title === 'Frog Pond EIN' && t.in_inbox && t.source === 'omnifocus'));
    check('next steps offered', has(undefined, 'open projects', 'open the inbox') && !!$('[data-of-undo]'));
    // Import the same thing again: nothing new.
    $('[data-of-cancel]').click();
    await wait(50);
    $('[data-of-paste]').click();
    await until(() => has(undefined, 'preview'));
    check('importing again: nothing new, clearly said', has(undefined, 'nothing new to import', 'imported before and are skipped') && !$('[data-of-import]'));
    $('[data-of-cancel]').click();
    await until(() => has(undefined, 'past imports'));
    check('past imports listed', has('.import-list', '3 projects', '9 actions'));
    $('.import-list [data-of-undo]').click();
    await until(() => has('.import-list', 'undone'));
    check('undo drops what it added (nothing deleted)', T().projects.find((p) => p.name === 'Click Plumbing' && p.import_id).status === 'dropped' && T().projects.find((p) => p.id === 'p1').status === 'active' && T().tasks.some((t) => t.title === 'Measure' && t.dropped_at));
    // TaskPaper, pasted as text.
    $('[data-of-paste-text]').click();
    await wait(50);
    $('[data-of-text]').value = tp;
    $('[data-of-check]').click();
    await until(() => has(undefined, 'preview'));
    check('TaskPaper works too', has('.import-stats', '2', 'projects') && has(undefined, 'ignored @weird'), text('.import-stats'));
    $('[data-of-cancel]').click();
    await wait(50);
    clip = 'hello world';
    $('[data-of-paste]').click();
    await until(() => has(undefined, 'doesn’t look like'));
    check('something else on the clipboard: a clear message', has(undefined, 'doesn’t look like an omnifocus export'));
  } finally {
    if (realClip) delete navigator.clipboard; // back to the prototype's
  }
}

// On-hold tags park their actions; dropped tags are retired.
async function onHoldTags(check) {
  const { db } = await import('/js/state.js');
  const task = (id) => db.tasks.find((t) => t.id === id);
  const { isAvailable, nextAction } = await import('/js/availability.js');
  const { forecastBadgeCount } = await import('/js/views/forecast.js');
  const { flaggedBadgeCount } = await import('/js/views/basic.js');
  const badgeBefore = forecastBadgeCount();
  const flagBefore = flaggedBadgeCount();
  await go('#tags');
  check('tags list suggests on hold', has(undefined, 'put a tag like someday on hold') && !$('.chip.hold'));
  await go('#tag/g1'); // Laptop: on task t6 and on project Click Plumbing (p1)
  check('tag page has a status control', !!$('[data-tag-status="g1"][value="on_hold"]') && has('.tag-status', 'available as usual'));
  const hold = $('[data-tag-status="g1"][value="on_hold"]');
  hold.checked = true; hold.dispatchEvent(new Event('change', { bubbles: true }));
  await wait(250);
  check('put on hold: saved, told how many are parked, with Undo', T().tags.find((g) => g.id === 'g1').status === 'on_hold' && has('#toast', 'is on hold', 'parked', 'undo'), text('#toast'));
  check('its actions (direct and via the project) are not available', !isAvailable(task('t6')) && !isAvailable(task('t1')) && !isAvailable(task('t2')) && !nextAction(db.projects.find((p) => p.id === 'p1')));
  check('badges ignore parked items', forecastBadgeCount() < badgeBefore && flaggedBadgeCount() < flagBefore, `${badgeBefore}→${forecastBadgeCount()} ${flagBefore}→${flaggedBadgeCount()}`);
  const { setFilter } = await import('/js/filter.js');
  setFilter({ show: 'available' });
  await go('#project/p1');
  check('available list hides them and says so', !$('[data-task="t1"]') && has(undefined, 'on hold hidden'));
  $('[data-act="show-remaining"]').click();
  await wait(100);
  check('Show reveals them, dimmed, with the on-hold tag', $('[data-task="t1"]').classList.contains('blocked') && has('[data-task="t1"]', '⏸ laptop'));
  const { openEditor } = await import('/js/editors/task.js');
  openEditor(task('t2'));
  await wait(80);
  check('the editor says why it isn’t available', has('#editor .hold-note', 'not available', 'laptop', 'on hold'));
  $('#sheet').close();
  const { healthHints } = await import('/js/views/review.js');
  check('review notices a project that is all on hold', healthHints(db.projects.find((p) => p.id === 'p1')).some((h) => /on hold \(tag “Laptop”\)/.test(h.text)));
  const { evaluate } = await import('/js/perspective-engine.js');
  const { perspectiveData } = await import('/js/perspectives.js');
  const held = evaluate({ rules: { match: 'all', rules: [{ type: 'on_hold' }] }, options: { show: 'remaining' } }, perspectiveData(), { available: isAvailable }).tasks.map((t) => t.id);
  check('perspectives can find on-hold items', held.includes('t1') && held.includes('t6') && !held.includes('t9'), held.join());
  await go('#tags');
  check('tags list marks it', has('.group-row.muted', 'laptop', 'on hold'));
  // Undo from the toast.
  await go('#tag/g1');
  const back = $('[data-tag-status="g1"][value="active"]');
  back.checked = true; back.dispatchEvent(new Event('change', { bubbles: true }));
  await wait(250);
  check('active again: available again', T().tags.find((g) => g.id === 'g1').status === 'active' && isAvailable(task('t1')));
  // A parent tag on hold holds its sub-tags.
  const { setTagStatus } = await import('/js/data.js');
  await setTagStatus(db.tags.find((g) => g.id === 'g3'), 'on_hold'); // Waiting (Hiro is its child)
  await go('#tag/g4');
  check('a sub-tag of an on-hold tag is on hold too, and says why', has('.tag-status', 'its parent “waiting” is on hold'));
  // Dropped: retired, hidden from pickers, doesn't hold actions.
  await setTagStatus(db.tags.find((g) => g.id === 'g3'), 'dropped');
  await go('#tags');
  check('dropped tags move to their own (collapsed) section', /Dropped · 2/.test($('.dropped-tags').textContent) && /Waiting/.test($('.dropped-tags').textContent) && /Hiro/.test($('.dropped-tags').textContent) && !$('.dropped-tags').open);
  openEditor(task('t11'));
  await wait(80);
  check('dropped tags are left out of the tag picker', !$$('#editor .tag-toggle').some((b) => /Waiting|Hiro/.test(b.textContent)));
  $('#sheet').close();
  openEditor(task('t10')); // has Hiro
  await wait(80);
  check('…unless the item has one (so it can be removed)', $$('#editor .tag-toggle.on').some((b) => /Hiro/.test(b.textContent)) && !has('#editor', 'not available: tag'));
  $('#sheet').close();
  await setTagStatus(db.tags.find((g) => g.id === 'g3'), 'active');
  setFilter({ show: 'remaining' });
}

// Project templates: starters, the editor, creating a project (blanks, dates, preview), save as template, archive.
async function templates(check) {
  const { db } = await import('/js/state.js');
  const until = async (fn, ms = 2000) => { for (let i = 0; i < ms / 50 && !fn(); i++) await wait(50); return fn(); };
  await go('#projects');
  check('templates section invites saving one', has('.templates-title', 'templates') && has(undefined, 'tap 📋 on the project'));
  $('[data-act="new-project"]').click();
  await wait(80);
  check('with no templates, + Project goes straight to a blank project', !!$('#project-form'));
  $('#sheet').close();
  $('[data-act="new-template"]').click();
  await wait(80);
  check('starter templates offered', $$('#sheet [data-starter]').length === 4 && has('#sheet', 'new job setup', 'trip prep', 'weekly review'));
  $('#sheet [data-starter="job"]').click();
  await until(() => location.hash.startsWith('#template/'));
  const tid = location.hash.split('/')[1];
  const tpl = () => T().project_templates.find((t) => t.id === tid);
  check('opens the template editor', has(undefined, 'template', 'create a project', 'blanks', '«client» default') && $$('.tpl-row').length === 10);
  // Edit: rename the first action, Enter adds one below, give it a date and make it a step.
  const first = $('.tpl-title[data-row="0"]');
  first.value = 'Site visit with «Client» and «Crew»'; first.dispatchEvent(new Event('input', { bubbles: true }));
  first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await wait(50);
  const added = $('.tpl-title[data-row="1"]');
  check('Enter adds the next action', !!added && added.value === '');
  added.value = 'Measure the kitchen'; added.dispatchEvent(new Event('input', { bubbles: true }));
  $('[data-row-more="1"]').click();
  await wait(50);
  const due = $('[data-row="1"][data-row-k="due"]');
  due.value = '1'; due.dispatchEvent(new Event('input', { bubbles: true }));
  $('[data-row-indent="1"]').click();
  await wait(700);
  const body = tpl().body;
  check('edits save into the template (nested, with a relative date)', body.actions[0].title === 'Site visit with «Client» and «Crew»' && body.actions[0].steps && body.actions[0].steps[0].title === 'Measure the kitchen' && body.actions[0].steps[0].due === 1, JSON.stringify(body.actions[0]).slice(0, 160));
  check('new blanks are picked up', body.blanks.some((b) => b.name === 'Crew') && has(undefined, '«crew» default'));
  // Create a project from it.
  $('[data-tpl-use]').click();
  await wait(200);
  check('create sheet asks for the blanks and a start date', !!$('#sheet [data-var="Client"]') && !!$('#sheet [data-var="Crew"]') && !!$('#sheet [name=anchor]'));
  const c = $('#sheet [data-var="Client"]'); c.value = 'Smith'; c.dispatchEvent(new Event('input', { bubbles: true }));
  const a = $('#sheet [name=anchor]'); a.value = '2026-10-05'; a.dispatchEvent(new Event('input', { bubbles: true }));
  check('live preview fills blanks and shows real dates', has('#sheet [data-preview]', 'smith job', 'site visit with smith and «crew»', 'measure the kitchen', 'oct 6') && has('#sheet [data-preview]', 'fill in «crew»'), text('#sheet [data-preview]').slice(0, 200));
  $('#sheet form').requestSubmit();
  await until(() => location.hash.startsWith('#project/'));
  const pid = location.hash.split('/')[1];
  const proj = db.projects.find((p) => p.id === pid);
  const kids = db.tasks.filter((t) => t.project_id === pid);
  check('project created with its actions, steps and dates', proj && proj.name === 'Smith job' && proj.kind === 'sequential' && proj.template_id === tid
    && kids.some((t) => t.title === 'Measure the kitchen' && t.parent_id && t.due_at && new Date(t.due_at).getDate() === 6) && kids.length === 11, `${proj && proj.name} ${kids.length}`);
  check('it says which template it came from', has('.from-template', 'from the template', 'new job setup'));
  // + Project now offers templates.
  await go('#projects');
  check('templates listed under Projects', has(undefined, '📋 templates', 'new job setup', '11 actions'));
  $('[data-act="new-project"]').click();
  await wait(80);
  check('+ Project offers blank or a template', !!$('#sheet [data-blank]') && !!$(`#sheet [data-use-template="${tid}"]`));
  $('#sheet').close();
  // Save an existing project (with steps) as a template.
  await go('#project/p2');
  $('[data-save-template="p2"]').click();
  await wait(80);
  check('save as template sheet', has('#sheet', 'save as template', 'dates count from', 'words to fill in each time', '5 actions'), text('#sheet').slice(0, 200));
  const find = $('#sheet [data-blank-i="0"][data-k="find"]'); find.value = 'Life'; find.dispatchEvent(new Event('input', { bubbles: true }));
  const nm = $('#sheet [data-blank-i="0"][data-k="name"]'); nm.value = 'Thing'; nm.dispatchEvent(new Event('input', { bubbles: true }));
  check('shows the name with its blank', has('#sheet [data-summary]', 'end of «thing» planning'));
  const tname = $('#sheet [name=name]'); tname.value = 'Planning kit'; tname.dispatchEvent(new Event('input', { bubbles: true }));
  $('#sheet form').requestSubmit();
  await wait(250);
  const saved = T().project_templates.find((t) => t.name === 'Planning kit');
  check('saved with nesting and project settings', saved && saved.body.name === 'End of «Thing» Planning' && saved.body.kind === 'sequential' && saved.body.actions.length === 3
    && saved.body.actions[2].steps.length === 2 && saved.body.blanks[0].name === 'Thing', saved && JSON.stringify(saved.body).slice(0, 200));
  // Schedule and archive.
  await go(`#template/${saved.id}`);
  const sched = $('[data-tpl-sched-on]'); sched.checked = true; sched.dispatchEvent(new Event('change', { bubbles: true }));
  await wait(250);
  check('schedule it', T().project_templates.find((t) => t.id === saved.id).schedule.unit === 'month' && !!$('[data-tpl-sched="every"]'));
  $(`[data-tpl-archive="${saved.id}"]`).click();
  await until(() => location.hash === '#projects');
  check('archive: gone from the list, can be shown and restored', !has(undefined, 'planning kit') && has(undefined, '1 archived template') && !!T().project_templates.find((t) => t.id === saved.id).archived_at);
}

// Focus: narrow the app to folders/projects on this device.
async function focusMode(check) {
  const { db } = await import('/js/state.js');
  const P = await import('/js/prefs.js');
  P.setFocus(null);
  try {
    await go('#flagged');
    check('no banner without focus', !$('.focus-banner'));
    document.querySelector('.nav-focus').click();
    await wait(80);
    check('focus picker lists folders with their projects', has('#sheet', 'focus', 'priorities', 'click plumbing', 'personal', 'end of life planning', 'errands'));
    const f1 = $('#sheet [data-focus-folder="f1"]'); f1.checked = true; f1.dispatchEvent(new Event('change', { bubbles: true }));
    check('ticking a folder ticks its projects', $('#sheet [data-focus-project="p1"]').checked && $('#sheet [data-focus-project="p1"]').disabled);
    $('#sheet form').requestSubmit();
    await wait(150);
    check('banner shows what’s in focus', has('.focus-banner', 'focused on', 'priorities'));
    check('flagged narrows to the focus', has(undefined, 'get plans released') && !has(undefined, 'pick up cp33'), text());
    await go('#projects');
    check('projects list narrows', has(undefined, 'click plumbing') && !has(undefined, 'end of life planning'));
    await go('#inbox');
    check('the Inbox always shows everything', !$('.focus-banner') && has(undefined, 'frog pond ein'));
    await go('#project/p2');
    check('an out-of-focus project still opens (no banner)', has(undefined, 'end of life planning') && !$('.focus-banner'));
    $('[data-focus-here="p2"]').click();
    await wait(100);
    check('🎯 on a project focuses on it', P.getFocus().projects.join() === 'p2' && !P.getFocus().folders.length);
    await go('#forecast');
    check('forecast narrows', !has(undefined, 'call gvec'));
    $('.focus-banner [data-act="unfocus"]').click();
    await wait(100);
    check('unfocus shows everything again', !P.getFocus() && !$('.focus-banner'));
    check('focus is kept on this device', localStorage.getItem('todo.focus') === null);
    void db;
  } finally { P.setFocus(null); }
}

// Settings → Dates: default times (the account's) and the Forecast tag.
async function datesSettings(check) {
  const { db, app } = await import('/js/state.js');
  const { HOURS } = await import('/js/dates.js');
  await go('#settings');
  check('dates section with three times and the Today tag', $$('[data-setting-time]').length === 3 && !!$('[data-setting-forecast-tag]') && has(undefined, 'due dates', 'defer dates', 'planned dates', 'always show in today'));
  const due = $('[data-setting-time="due_minutes"]'); due.value = '15:30'; due.dispatchEvent(new Event('change', { bubbles: true }));
  await wait(200);
  check('saved to the account and used right away', T().user_settings[0].due_minutes === 930 && HOURS.due_at === 15.5);
  const { openEditor } = await import('/js/editors/task.js');
  openEditor(db.tasks.find((t) => t.id === 't9'));
  await wait(80);
  const f = $('#editor');
  f.elements.due_at.value = '2026-10-05';
  f.requestSubmit();
  await wait(250);
  const d = new Date(T().tasks.find((t) => t.id === 't9').due_at);
  check('a plain due date lands at the new time', d.getHours() === 15 && d.getMinutes() === 30, d.toString());
  const tagSel = $('[data-setting-forecast-tag]'); tagSel.value = 'g1'; tagSel.dispatchEvent(new Event('change', { bubbles: true }));
  await wait(200);
  check('forecast tag saved', app.settings.forecast_tag_id === 'g1');
  await go('#forecast');
  check('Today shows the tag’s actions', has(undefined, 'tagged laptop', 'inside deadmans switch') || has(undefined, 'tagged laptop'), text().slice(0, 300));
  // Put everything back.
  const { saveSettings } = await import('/js/prefs.js');
  await saveSettings({ due_minutes: 1020, forecast_tag_id: null }, { quiet: true });
}

// Keyboard shortcuts: keys do things, never while typing; Settings → Keyboard shows them.
async function keyboard(check) {
  const { db, app } = await import('/js/state.js');
  const key = (k, opts = {}) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts }));
  await go('#inbox');
  key('2'); await wait(80);
  check('number keys go to views', location.hash === '#forecast');
  key('4'); await wait(80);
  check('4 → Projects', location.hash === '#projects');
  await go('#project/p1');
  key('j'); await wait(80);
  check('j selects the first item', app.selected && app.selected.id === 't1' && !!$('[data-task="t1"].selected'));
  key('j'); await wait(80);
  check('j again moves down', app.selected.id === 't2');
  key('f'); await wait(250);
  check('f flags the selected item', db.tasks.find((t) => t.id === 't2').flagged === true);
  key('p'); await wait(250);
  check('p plans it for today', !!db.tasks.find((t) => t.id === 't2').planned_at && new Date(db.tasks.find((t) => t.id === 't2').planned_at).toDateString() === new Date().toDateString() && has('#toast', 'undo'));
  key('x'); await wait(300);
  check('x completes it', !!T().tasks.find((t) => t.id === 't2').completed_at);
  key('k'); await wait(80);
  check('k moves up', app.selected.id === 't1');
  key('F', { shiftKey: true }); await wait(120);
  const P = await import('/js/prefs.js');
  check('⇧F focuses on the selected item’s project', P.getFocus() && P.getFocus().projects.join() === 'p1');
  key('U', { shiftKey: true }); await wait(120);
  check('⇧U unfocuses', !P.getFocus());
  key('Escape'); await wait(80);
  check('Esc clears the selection', !app.selected);
  // Not while typing.
  const input = $('[data-capture] input');
  input.focus();
  key('4');
  await wait(60);
  check('keys don’t fire while typing', location.hash.startsWith('#project/p1'));
  input.blur();
  key('?', { shiftKey: true }); await wait(100);
  check('? shows the shortcuts with the drawn keyboard', $('#sheet').open && !!$('#sheet .kbd') && has('#sheet', 'capture to the inbox', 'flag or unflag'));
  $('#sheet [data-kbd="x"]').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  check('hovering a key tells you what it does', has('#sheet [data-kbd-tip]', 'x: complete'));
  $('#sheet').close();
  key('n'); await wait(80);
  check('n captures to the Inbox', $('#sheet').open && !!$('#quick'));
  $('#sheet').close();
  await go('#settings');
  check('Settings → Keyboard: keyboard and every shortcut', !!$('.settings-card .kbd') && $$('.settings-card .kbd-key.on').length > 20 && has(undefined, 'keyboard', 'selected item', 'go to'));
  $('.settings-card [data-kbd="/"]').click();
  check('tapping a key shows its shortcuts', has('.settings-card [data-kbd-tip]', '/: search', '?: show keyboard shortcuts'), text('.settings-card [data-kbd-tip]'));
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

  // Setup screen, as an iPhone user sees it.
  const A = await import('/js/views/alerts.js');
  A.resetAlerts();
  window.__forceIOS = true; window.__forceStandalone = false;
  await go('#alerts');
  await wait(100);
  check('Safari on iPhone: step 1 shows Add to Home Screen with the Share icon', has(undefined, 'add todo tooling to your home screen', 'add to home screen') && !!$('.ios-share'));
  check('turn-on button waits for install', !$('[data-act="alerts-on"]') && has(undefined, 'available after step 1'));

  window.__forceStandalone = true;
  window.__pushState = 'off'; window.__notifyPerm = 'granted';
  window.__fakePush = { endpoint: 'https://push.example/iphone', p256dh: 'k', auth: 'a', device: 'iPhone' };
  window.__fakeTest = async () => 1;
  A.resetAlerts();
  await go('#nearby'); await go('#alerts');
  await wait(100);
  check('installed: one big Turn on alerts button', !!$('[data-act="alerts-on"]') && has(undefined, 'installed'));
  await A.turnOnAlerts();
  await wait(100);
  const key = T().api_tokens.find((t) => t.scope === 'geo');
  check('one tap: device registered, key created (hashed), test sent', T().push_subscriptions.some((x) => x.device === 'iPhone') && key && key.token_hash.length === 64 && !JSON.stringify(key).includes(localStorage.getItem('todo.geo.key')));
  check('alerts show as on', has(undefined, 'alerts are on') && !!$('[data-act="test-alert"]'));
  check('Home Depot listed to set up (Leave, from t2)', has('.alert-jobs', 'leave', 'home depot') && has(undefined, '0 of'));

  const jobBtn = $$('[data-setup-auto]').find((b) => b.dataset.setupAuto.startsWith('pl1:'));
  await A.openAutomationGuide(jobBtn.dataset.setupAuto);
  await wait(50);
  const link = $('#sheet textarea').value;
  check('guide: link uses the key, place and event', /^https:\/\/mcp\.todotooling\.com\/geo\?t=tt_.+&place=pl1&event=(arrive|leave)$/.test(link), link);
  check('guide: steps, the address to search, and Open Shortcuts', has('#sheet', 'automation', 'run immediately', 'get contents of url', '1000 main st') && $('#sheet [data-open-shortcuts]').getAttribute('href') === 'shortcuts://');
  $('#sheet [data-auto-done]').click();
  await wait(100);
  check('ticked off: counts progress', has(undefined, '1 of') && !!$('.alert-jobs li.done'));

  window.__forceIOS = undefined; window.__forceStandalone = undefined; window.__pushState = undefined; window.__notifyPerm = undefined;
  window.__fakePush = undefined; window.__fakeTest = undefined;
  A.resetAlerts();
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

// Inspector parity 1: duration +1m, editable completed/dropped times, Added/Changed,
// project dates + duration, review cadence in units with an editable next review date.
async function parity(check) {
  const { db } = await import('/js/state.js');
  const task = (id) => db.tasks.find((t) => t.id === id);
  const proj = (id) => db.projects.find((p) => p.id === id);
  const { isAvailable } = await import('/js/availability.js');

  // Action: +1m duration, Added/Changed.
  await go('#project/p3');
  $('[data-task="t9"] .row-title').click();
  await wait(100);
  let f = $('#editor');
  check('duration has +1m +5m +15m +1h', $$('[data-qe]', f).map((b) => b.textContent).join() === '+1m,+5m,+15m,+1h,✕');
  check('editor shows Added and Changed', has('#editor .stamps', 'added', 'changed'));
  $('[data-qe="1"]', f).click(); $('[data-qe="5"]', f).click();
  f.requestSubmit();
  await wait(200);
  check('+1m and +5m add up', task('t9').estimate_minutes === 6, task('t9').estimate_minutes);

  // Backdate a completion.
  $('[data-task="t9"] .row-title').click();
  await wait(100);
  f = $('#editor');
  f.elements.status.value = 'completed';
  f.elements.status.dispatchEvent(new Event('change', { bubbles: true }));
  f.requestSubmit();
  await wait(200);
  check('completing via status stamps a time', !!task('t9').completed_at);
  const { openEditor } = await import('/js/editors/task.js');
  openEditor(task('t9'));
  f = $('#editor');
  check('completed time is editable', !!f.elements.completed_at_edit);
  f.elements.completed_at_edit.value = '2026-09-01T08:30';
  f.requestSubmit();
  await wait(200);
  const t9 = T().tasks.find((t) => t.id === 't9'); // read the saved row: a background refresh drops old completions from db
  check('backdated completion saved', new Date(t9.completed_at).getTime() === new Date('2026-09-01T08:30').getTime(), t9.completed_at);

  // Dropped time editable.
  openEditor(task('t5'));
  f = $('#editor');
  f.elements.status.value = 'dropped';
  f.elements.status.dispatchEvent(new Event('change', { bubbles: true }));
  f.requestSubmit();
  await wait(200);
  openEditor(task('t5'));
  f = $('#editor');
  check('dropped time is editable', !!f.elements.dropped_at_edit && !$('[data-dropped-box]', f).hidden);
  f.elements.dropped_at_edit.value = '2026-08-15T12:00';
  f.requestSubmit();
  await wait(200);
  check('backdated drop saved', new Date(task('t5').dropped_at).getTime() === new Date('2026-08-15T12:00').getTime());

  // Project: dates, duration, review cadence.
  const { openProjectEditor } = await import('/js/editors/project.js');
  openProjectEditor(proj('p1'));
  f = $('#project-form');
  check('project editor has defer/planned/due, duration, review', ['defer_at', 'planned_at', 'due_at', 'estimate_minutes', 'next_review_at', 'review_every', 'review_unit'].every((n) => f.elements[n]));
  check('project editor shows last reviewed and Added/Changed', has('#project-form', 'last reviewed', 'added', 'changed'));
  $('[data-qd="due_at"][data-step="today"]', f).click();
  f.elements.estimate_minutes.value = '120';
  f.elements.review_every.value = '2';
  f.elements.review_unit.value = 'month';
  f.requestSubmit();
  await wait(200);
  const p1 = proj('p1');
  check('project due + duration saved', !!p1.due_at && new Date(p1.due_at).getHours() === 17 && p1.estimate_minutes === 120);
  check('review every 2 months', p1.review_every === 2 && p1.review_unit === 'month' && p1.review_every_days === 60);
  const expected = new Date(p1.last_reviewed_at); expected.setUTCMonth(expected.getUTCMonth() + 2);
  check('next review follows calendar months', Math.abs(new Date(p1.next_review_at) - expected) < 3 * 86400e3, p1.next_review_at);

  openProjectEditor(proj('p1'));
  f = $('#project-form');
  f.elements.next_review_at.value = '2027-01-15';
  f.requestSubmit();
  await wait(200);
  check('next review date can be set directly', proj('p1').next_review_at.startsWith(new Date(2027, 0, 15).toISOString().slice(0, 10)), proj('p1').next_review_at);
  openProjectEditor(proj('p1'));
  f = $('#project-form');
  f.elements.notes.value = 'unrelated edit';
  f.requestSubmit();
  await wait(200);
  check('unrelated edits keep the chosen review date', proj('p1').next_review_at.startsWith(new Date(2027, 0, 15).toISOString().slice(0, 10)));

  // Forecast shows the project due today.
  await go('#forecast');
  check('forecast lists a project due today', has(undefined, 'projects', 'click plumbing'));

  // Deferred project hides its actions.
  check('before deferring, its first action is available', isAvailable(task('t4')));
  openProjectEditor(proj('p2'));
  f = $('#project-form');
  $('[data-qd="defer_at"][data-step="+1w"]', f).click();
  f.requestSubmit();
  await wait(200);
  check('deferred project hides its actions', !!proj('p2').defer_at && !isAvailable(task('t4')));
  await go('#projects');
  check('project row shows its defer date', !!$$('.group-row').find((a) => a.innerText.includes('End of Life') && a.innerText.includes('⏸') && a.innerText.includes('Deferred')));

  // Backdate a project's completion.
  openProjectEditor(proj('p5'));
  f = $('#project-form');
  f.elements.status.value = 'completed';
  f.requestSubmit();
  await wait(200);
  openProjectEditor(proj('p5'));
  f = $('#project-form');
  check('project completed time editable', !!f.elements.completed_at_edit);
  f.elements.completed_at_edit.value = '2026-07-04T10:00';
  f.requestSubmit();
  await wait(200);
  check('backdated project completion saved', new Date(proj('p5').completed_at).getTime() === new Date('2026-07-04T10:00').getTime(), proj('p5').completed_at);
}

// Repeat: presets and custom rules in the editor, completing makes the next occurrence,
// skip, undo, groups, repeating projects.
async function repeat(check) {
  const { db } = await import('/js/state.js');
  const task = (id) => db.tasks.find((t) => t.id === id);
  const open = (title) => db.tasks.filter((t) => t.title === title && !t.completed_at && !t.dropped_at);
  const { openEditor } = await import('/js/editors/task.js');
  const { describe, nextOccurrence } = await import('/js/repeat.js');

  // Custom: every 2 weeks on Mon + Thu.
  openEditor(task('t2')); // planned today 9am
  let f = $('#editor');
  check('repeat field defaults to Never', f.elements.repeat_preset.value === '' && $('.repeat-custom', f).hidden);
  f.elements.repeat_preset.value = 'custom';
  f.elements.repeat_preset.dispatchEvent(new Event('change', { bubbles: true }));
  check('custom panel opens', !$('.repeat-custom', f).hidden);
  f.elements.repeat_every.value = '2';
  f.elements.repeat_unit.value = 'week';
  f.elements.repeat_unit.dispatchEvent(new Event('change', { bubbles: true }));
  $$('input[name=repeat_wd]', f).forEach((x) => { x.checked = ['1', '4'].includes(x.value); });
  $('input[name=repeat_wd]', f).dispatchEvent(new Event('change', { bubbles: true }));
  check('summary reads naturally', has('#editor [data-repeat-summary]', 'every 2 weeks on mon, thu', 'next one'), text('#editor [data-repeat-summary]'));
  f.requestSubmit();
  await wait(200);
  const rule = task('t2').repeat_rule;
  check('custom rule saved', rule && rule.every === 2 && rule.unit === 'week' && rule.weekdays.join() === '1,4' && rule.from === 'assigned' && rule.tz, JSON.stringify(rule));
  await go('#project/p1');
  check('row shows 🔁 with the rule as its tooltip', !!$('[data-task="t2"] .meta-repeat') && /every 2 weeks/i.test($('[data-task="t2"] .meta-repeat').title));

  // Preset: every day, then complete → next occurrence tomorrow.
  openEditor(task('t3')); // due today
  f = $('#editor');
  f.elements.repeat_preset.value = 'daily';
  f.elements.repeat_preset.dispatchEvent(new Event('change', { bubbles: true }));
  f.requestSubmit();
  await wait(200);
  check('preset saved', task('t3').repeat_rule && task('t3').repeat_rule.unit === 'day');
  const dueBefore = new Date(task('t3').due_at);
  await go('#project/p1');
  $('[data-check="t3"]').click();
  await wait(300);
  const nexts = open('Get plans released');
  check('completing makes one next occurrence', nexts.length === 1 && nexts[0].id !== 't3', nexts.length);
  check('next occurrence is a day later, same time', nexts[0] && new Date(nexts[0].due_at) - dueBefore === 86400000);
  check('completed one stops repeating', task('t3').completed_at && !task('t3').repeat_rule);
  check('toast says when the next one is', has('#toast', 'next one'));
  check('next occurrence keeps flag and repeat', nexts[0] && nexts[0].flagged && nexts[0].repeat_rule && nexts[0].repeat_rule.n === 2);

  // Undo retires the new occurrence and restores the repeat.
  [...$$('#toast button')].find((b) => b.textContent === 'Undo').click();
  await wait(400);
  check('undo reopens it with its repeat', !task('t3').completed_at && task('t3').repeat_rule);
  check('undo drops the extra occurrence (never deleted)', open('Get plans released').length === 1 && T().tasks.some((t) => t.title === 'Get plans released' && t.dropped_at));

  // Skip.
  openEditor(task('t3'));
  f = $('#editor');
  check('skip button on repeating actions', !!$('[data-skip-occurrence]', f));
  $('[data-skip-occurrence]', f).click();
  await wait(300);
  check('skip moves it to the next occurrence, still open', !task('t3').completed_at && new Date(task('t3').due_at) - dueBefore >= 86400000 && task('t3').repeat_rule.n === 2);

  // Repeating group returns with its sub-actions.
  openEditor(task('t6'));
  f = $('#editor');
  f.elements.repeat_preset.value = 'monthly';
  f.elements.repeat_preset.dispatchEvent(new Event('change', { bubbles: true }));
  f.requestSubmit();
  await wait(200);
  window.confirm = () => true;
  await go('#project/p2');
  $('[data-check="t6"]').click();
  await wait(300);
  const g = open('Inside deadmans switch')[0];
  check('repeating group comes back with its sub-actions open', g && db.tasks.filter((c) => c.parent_id === g.id && !c.completed_at).length === 2);

  // Repeating project.
  const { openProjectEditor } = await import('/js/editors/project.js');
  openProjectEditor(db.projects.find((p) => p.id === 'p3'));
  f = $('#project-form');
  check('projects have a repeat field', !!f.elements.repeat_preset);
  f.elements.repeat_preset.value = 'yearly';
  f.elements.repeat_preset.dispatchEvent(new Event('change', { bubbles: true }));
  f.requestSubmit();
  await wait(200);
  const { updateProject } = await import('/js/data.js');
  await updateProject(db.projects.find((p) => p.id === 'p3'), { status: 'completed' });
  await wait(200);
  const copies = db.projects.filter((p) => p.name === 'Driveway Trailer');
  check('repeating project starts a fresh copy with its actions', copies.length === 2 && copies.some((p) => p.status === 'active' && db.tasks.some((t) => t.project_id === p.id && !t.completed_at)));

  // Library: summaries and end conditions.
  check('describe: weekdays', describe({ every: 1, unit: 'week', weekdays: [1, 2, 3, 4, 5] }) === 'Every week on weekdays');
  check('end after N: last occurrence has no next', nextOccurrence({ due_at: new Date().toISOString(), repeat_rule: { every: 1, unit: 'day', end_count: 3, n: 3 } }) === null);
}

// Custom notifications: add presets / custom / specific time, fire times follow dates,
// saving keeps unchanged reminders, bell on rows, reminders come along with repeats.
async function reminders(check) {
  const { db } = await import('/js/state.js');
  const task = (id) => db.tasks.find((t) => t.id === id);
  const mine = (id) => db.notifications.filter((n) => n.task_id === id);
  const { openEditor } = await import('/js/editors/task.js');
  const pick = (f, v) => { const s = $('[data-notify-add]', f); s.value = v; s.dispatchEvent(new Event('change', { bubbles: true })); };

  openEditor(task('t3')); // due today 5pm
  let f = $('#editor');
  check('notifications field present, empty', !!$('[data-notify-add]', f) && !$$('[data-notify-list] li', f).length);
  pick(f, 'before_due:60');
  check('preset added with its fire time', has('#editor [data-notify-list]', '1 hour before due') && /4:00/.test(text('#editor [data-notify-list]')), text('#editor [data-notify-list]'));
  pick(f, 'before_planned:0');
  check('warns when the date it needs is missing', has('#editor [data-notify-list]', 'needs a planned date'));
  window.prompt = () => '3h';
  pick(f, 'custom');
  check('custom offset (3h) added', has('#editor [data-notify-list]', '3 hours before due'));
  pick(f, 'at');
  $('[data-notify-at]', f).value = '2026-12-24T08:00';
  $('[data-notify-at-add]', f).click();
  check('specific time added', has('#editor [data-notify-list]', 'at ', 'dec 24'));
  $$('[data-notify-remove]', f)[1].click(); // remove "when planned"
  check('remove works', !has('#editor [data-notify-list]', 'when planned'));
  f.requestSubmit();
  await wait(250);
  check('three reminders saved', mine('t3').length === 3, mine('t3').map((n) => n.kind).join());
  const hourBefore = mine('t3').find((n) => n.kind === 'before_due' && n.offset_minutes === 60);
  check('fire time = due − 1 hour', new Date(task('t3').due_at) - new Date(hourBefore.fire_at) === 3600e3);
  window.prompt = () => 'Smoke tag';

  await go('#project/p1');
  check('row shows 🔔', !!$('[data-task="t3"] .meta-bell'));

  // Saving again keeps unchanged reminders (a fired one isn't re-sent).
  window.__mock.tables.notifications.find((n) => n.id === hourBefore.id).sent_at = '2026-01-01T00:00:00Z';
  const { loadAll } = await import('/js/data.js');
  await loadAll();
  openEditor(task('t3'));
  f = $('#editor');
  f.elements.notes.value = 'edited';
  f.requestSubmit();
  await wait(250);
  check('unrelated save keeps reminders (and sent state)', mine('t3').length === 3 && window.__mock.tables.notifications.find((n) => n.id === hourBefore.id).sent_at);

  // Moving the due date moves and re-arms.
  openEditor(task('t3'));
  f = $('#editor');
  $('[data-qd="due_at"][data-step="+1d"]', f).click();
  f.requestSubmit();
  await wait(250);
  const moved = window.__mock.tables.notifications.find((n) => n.id === hourBefore.id);
  check('moving the due date moves and re-arms the reminder', new Date(task('t3').due_at) - new Date(moved.fire_at) === 3600e3 && !moved.sent_at);

  // Projects have the field too.
  const { openProjectEditor } = await import('/js/editors/project.js');
  openProjectEditor(db.projects.find((p) => p.id === 'p2'));
  f = $('#project-form');
  pick(f, 'at_defer:0');
  f.requestSubmit();
  await wait(250);
  check('project reminder saved', db.notifications.some((n) => n.project_id === 'p2' && n.kind === 'at_defer'));

  // Reminders come along with a repeat.
  openEditor(task('t1'));
  f = $('#editor');
  f.elements.repeat_preset.value = 'weekly';
  f.elements.repeat_preset.dispatchEvent(new Event('change', { bubbles: true }));
  pick(f, 'before_due:1440');
  f.requestSubmit();
  await wait(250);
  await go('#project/p1');
  $('[data-check="t1"]').click();
  await wait(400);
  const next = db.tasks.find((t) => t.title === 'Call GVEC about utilities' && !t.completed_at);
  const nextRem = next && window.__mock.tables.notifications.find((n) => n.task_id === next.id);
  check('next occurrence brings its reminder', !!nextRem && new Date(next.due_at) - new Date(nextRem.fire_at) === 86400e3);

  // #task/<id> links (from a notification) open the item.
  location.hash = `#task/${next ? next.id : 't2'}`;
  await wait(250);
  check('#task link opens the action in its project', location.hash === '#project/p1' && $('#sheet').open);
  $('#sheet').close();
}

// Attachments: upload on existing items, pending until save on new ones, open via signed URL,
// remove = archive with Undo, 📎 on rows.
async function attachments(check) {
  const { db } = await import('/js/state.js');
  const { openEditor } = await import('/js/editors/task.js');
  const pickFiles = async (f, files) => {
    const input = $('[data-attach-input]', f);
    const dt = new DataTransfer(); files.forEach((x) => dt.items.add(x));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(250);
  };
  const png = new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], 'photo.png', { type: 'image/png' });
  const pdf = new File(['%PDF-1.4 plans'], 'plans.pdf', { type: 'application/pdf' });

  openEditor(db.tasks.find((t) => t.id === 't2'));
  let f = $('#editor');
  check('attachments field present', !!$('[data-attach-input]', f));
  await pickFiles(f, [png, pdf]);
  const rows = db.attachments.filter((a) => a.task_id === 't2');
  check('existing item uploads right away', rows.length === 2 && rows.every((a) => a.path.startsWith('u1/')) && Object.keys(window.__mock.files).length >= 2);
  check('list shows name, size and an image thumbnail', has('#editor [data-attach-list]', 'photo.png', 'plans.pdf') && !!$('#editor img.attach-thumb'));
  const opened = [];
  const realOpen = window.open;
  window.open = () => ({ close() {}, set location(u) { opened.push(u); } });
  $('[data-attach-open]', f).click();
  await wait(100);
  window.open = realOpen;
  check('opening uses a signed URL', opened.length === 1 && opened[0].startsWith('blob:'));
  $(`[data-attach-remove="${rows[1].id}"]`, f).click();
  await wait(200);
  check('remove archives (not deleted)', !!window.__mock.tables.attachments.find((a) => a.id === rows[1].id).archived_at && !has('#editor [data-attach-list]', 'plans.pdf'));
  [...$$('#toast button')].find((b) => b.textContent === 'Undo').click();
  await wait(200);
  check('undo restores it', !window.__mock.tables.attachments.find((a) => a.id === rows[1].id).archived_at);
  $('[data-cancel]', f).click();
  await go('#project/p1');
  check('row shows 📎 with count', has('[data-task="t2"] .meta-clip', '📎2'));

  // New item: pending until saved.
  openEditor(null, {});
  f = $('#editor');
  f.elements.title.value = 'Send drawings';
  await pickFiles(f, [pdf]);
  check('new item: file waits for save', has('#editor [data-attach-list]', 'uploads when saved') && !db.attachments.some((a) => a.name === 'plans.pdf' && !a.task_id));
  f.requestSubmit();
  await wait(300);
  const made = db.tasks.find((t) => t.title === 'Send drawings');
  check('saved item gets its attachment', made && db.attachments.some((a) => a.task_id === made.id && a.name === 'plans.pdf'));
}

// Settings → Notifications (devices, test now, test in 1 minute with countdown, delivery history)
// and History on actions.
async function history(check) {
  const { db } = await import('/js/state.js');
  const T2 = () => db.tasks.find((t) => t.id === 't2');
  const { openEditor } = await import('/js/editors/task.js');

  // Item history.
  openEditor(T2());
  let f = $('#editor');
  $('[data-qd="due_at"][data-step="+1w"]', f).click();
  f.elements.title.value = 'Order fittings for Jodi (rush)';
  f.requestSubmit();
  await wait(250);
  openEditor(T2());
  f = $('#editor');
  const box = $('[data-history]', f);
  check('editor has a History section', !!box);
  box.open = true;
  box.dispatchEvent(new Event('toggle'));
  await wait(250);
  check('history reads naturally, grouped by day, with who', has('#editor .history-list', 'today', 'title', 'order fittings for jodi', '(rush)', '· you') && has('#editor .history-list', 'due'));
  const filter = $('[data-history-filter]', f);
  filter.value = 'due_at';
  filter.dispatchEvent(new Event('change', { bubbles: true }));
  const rowsShown = $$('#editor .history-list li:not(.history-day)');
  check('filter to one field', rowsShown.length > 0 && rowsShown.every((li) => li.dataset.field === 'due_at') && !!$('#editor .history-day'));
  $('#sheet').close();

  // Inspector: History refreshes after an in-place save.
  window.__forceSheet = false; window.__forceWide = true;
  const { select } = await import('/js/inspector.js');
  await go('#project/p1');
  select('task', 't2');
  await wait(300);
  const insBox = $('#inspector [data-history]');
  insBox.open = true; insBox.dispatchEvent(new Event('toggle'));
  await wait(250);
  const before = $$('#inspector .history-list li:not(.history-day)').length;
  $('#inspector [data-qe="15"]').click();
  await wait(900);
  check('inspector History refreshes after it saves', $$('#inspector .history-list li:not(.history-day)').length === before + 1 && has('#inspector .history-list', 'duration'), `${before} → ${$$('#inspector .history-list li:not(.history-day)').length}`);
  window.__forceSheet = true; window.__forceWide = false;

  // Settings: devices + tests.
  T().push_subscriptions.push({ id: 'ps1', user_id: 'u1', endpoint: 'https://web.push.apple.com/abc', p256dh: 'k', auth: 'a', device: 'iPhone', created_at: new Date().toISOString() });
  window.__pushTest = async (delay) => {
    if (!delay) {
      const results = [{ device: 'iPhone', service: 'web.push.apple.com', status: 201, reason: '' }];
      T().push_log.push({ id: 'l1', user_id: 'u1', kind: 'test', title: '🔔 Test notification', sent_at: new Date().toISOString(), devices: 1, delivered: 1, results, created_at: new Date().toISOString() });
      return { devices: 1, delivered: 1, results };
    }
    T().push_log.push({ id: 'l2', user_id: 'u1', kind: 'test', title: '🔔 Scheduled test', scheduled_for: new Date(Date.now() + delay * 1000).toISOString(), sent_at: null, devices: 0, delivered: 0, results: [], created_at: new Date().toISOString() });
    return { queued: 'l2', scheduled_for: new Date(Date.now() + delay * 1000).toISOString() };
  };
  window.__pollMs = 200;
  const S = await import('/js/views/settings.js');
  S.resetSettings();
  await go('#settings');
  for (let i = 0; i < 20 && !has(undefined, 'iphone'); i++) await wait(100);
  check('settings lists the iPhone', has(undefined, 'notifications', 'iphone') && !!$('[data-act="push-test-now"]') && !!$('[data-act="push-test-later"]'));
  $('[data-act="push-test-now"]').click();
  await wait(400);
  check('test now shows the push service result', has('[data-test-status]', 'iphone: delivered to apple'));
  check('delivery history lists it once (one icon)', has('.delivery-log', 'test notification', 'delivered to apple') && !text('.delivery-log').includes('🔔 🔔'));
  $('[data-act="push-test-later"]').click();
  await wait(1300);
  check('test in 1 minute shows a countdown', /⏳ 0:5\d/.test(text('[data-test-status]')) && has('[data-test-status]', 'lock your phone'), text('[data-test-status]'));
  check('buttons are disabled while a test runs; the queued test shows in history', $('[data-act="push-test-now"]').disabled && has('.delivery-log', 'queued for'));
  const row = T().push_log.find((x) => x.id === 'l2');
  Object.assign(row, { sent_at: new Date().toISOString(), devices: 1, delivered: 0, results: [{ device: 'iPhone', service: 'web.push.apple.com', status: 403, reason: 'BadJwtToken' }] });
  await wait(700);
  check('when the queued test is sent, the result replaces the countdown, in plain words with the raw reason under Why?', has('[data-test-status]', 'iphone: refused', 'why?') && $('[data-test-status] .why code').textContent.includes('403 BadJwtToken'), text('[data-test-status]'));
  window.__pushTest = undefined; window.__pollMs = undefined;
}
