// UI smoke test. Open http://localhost:8765/?mock, then in the console (or the
// Browser pane): `const { run } = await import('/dev/smoke.js'); await run()`.
// Returns [{ name, ok, detail }]; also logs a summary. Resets mock data first.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const text = (s = '#view') => ($(s) ? $(s).innerText.replace(/\s+/g, ' ') : '');
const go = async (hash) => { location.hash = hash; await wait(120); };
const T = () => window.__mock.tables;

async function reload() {
  window.__mock.reset();
  document.dispatchEvent(new Event('visibilitychange'));
  await wait(250);
}

export async function run({ only } = {}) {
  window.confirm = () => true;
  window.prompt = () => 'Smoke tag';
  const results = [];
  const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: String(detail).slice(0, 160) });
  const suites = { core, ...(window.__smokeSuites || {}) };
  for (const [name, fn] of Object.entries(suites)) {
    if (only && !only.includes(name)) continue;
    await reload();
    try { await fn(check); } catch (e) { check(`${name}: threw`, false, e.stack || e.message); }
    if ($('#sheet').open) $('#sheet').close();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`smoke: ${results.length - failed.length}/${results.length} passed`, failed);
  return { passed: results.length - failed.length, total: results.length, failed, results };
}

// Behaviour that existed before the feature phases; must never regress.
async function core(check) {
  await go('#inbox');
  check('inbox lists inbox items', text().includes('Frog Pond EIN') && text().includes('2 items to clarify'), text());

  const input = $('[data-capture] input');
  input.value = 'Smoke capture';
  $('[data-capture]').requestSubmit();
  await wait(150);
  check('capture adds to inbox', text().includes('Smoke capture') && T().tasks.some((t) => t.title === 'Smoke capture' && t.in_inbox !== false));

  $('[data-check="t12"]').click();
  await wait(150);
  check('complete shows Add note + Undo', text('#toast').includes('Add note') && text('#toast').includes('Undo'), text('#toast'));
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
  check('drop shows Undo', text('#toast').includes('Dropped'), text('#toast'));

  await go('#projects');
  check('projects grouped by folder', text().includes('PRIORITIES') && text().includes('Click Plumbing') && text().includes('Personal'), text());

  await go('#project/p1');
  check('project lists its actions', text().includes('Call GVEC') && text().includes('Order fittings'), text());

  await go('#tags');
  check('tags view', text().includes('Laptop') && text().includes('Hiro'), text());

  await go('#search/jodi');
  await wait(350);
  check('search finds open + completed', text().includes('Order fittings for Jodi') && text().includes('Send Jodi the plumbing plans'), text());

  await go('#done/week/all');
  await wait(200);
  check('done view shows completions', text().includes('Send Jodi the plumbing plans'), text());

  await go('#settings');
  await wait(200);
  check('settings lists approved sender', text().includes('robert@douglasmining.com'), text());

  const del = await window.sb.from('tasks').delete().eq('id', 't1');
  check('mock mirrors no-delete rule', !!del.error, del.error && del.error.message);
}
