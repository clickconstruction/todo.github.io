// Settings: agent access tokens (MCP), email-capture senders, account.
import { saveSettings, DEFAULT_SETTINGS, minutesToInput, inputToMinutes } from '../prefs.js';
import { keyboardHtml, shortcutListHtml } from '../shortcuts.js';
import { localTz } from '../repeat.js';
import { activePlaces } from '../places.js';
import { liveCalendars, maskUrl, COLORS, checkLink, addCalendar, updateCalendar, archiveCalendar, fmtEventTime } from '../calendars.js';
import { sb, app, esc, run, toast, openSheet, ask, $, sortedTags, tagLabel } from '../state.js';
import { fmtDate } from '../dates.js';
import { resultLines, stripIcon, when, timeOnly } from '../pushResult.js';
import { captureSection, createCaptureKey, openCaptureGuide } from './capture.js';
import { openFolderUrl } from '../folders.js';

const MCP_URL = 'https://mcp.todotooling.com/mcp';
const CAPTURE_EMAIL = 'inbox@todotooling.com';
// The server holds only a hash of each agent token. The plaintext is kept in this browser (like the location
// key, todo.geo.key), so the row's "Copy again" can show it here, behind a warning, when a connection drops
// and the same computer needs the same token; no other browser or device has it. Revoking drops the copy,
// and loading the list drops copies of tokens that are gone.
const TOKEN_STORE = 'todo.tokens';
const savedTokens = () => { try { return JSON.parse(localStorage.getItem(TOKEN_STORE) || '{}') || {}; } catch { return {}; } };
const saveTokens = (m) => { try { localStorage.setItem(TOKEN_STORE, JSON.stringify(m)); return true; } catch { return false; } };
const rememberToken = (id, token) => saveTokens({ ...savedTokens(), [id]: token });
const forgetToken = (id) => { const m = savedTokens(); if (id in m) { delete m[id]; saveTokens(m); } };
const forgetGone = (ids) => { const m = savedTokens(); const gone = Object.keys(m).filter((id) => !ids.includes(id)); if (gone.length) { gone.forEach((id) => delete m[id]); saveTokens(m); } };
let apiTokens = null;
let emailSenders = [];
let devices = [];
let deliveries = [];
let testState = null; // { phase: 'counting'|'waiting'|'done', until, id, text }
let loading = false;

export const resetSettings = () => { apiTokens = null; emailSenders = []; devices = []; deliveries = []; };

async function loadSettings() {
  if (loading) return;
  loading = true;
  try {
    [apiTokens, emailSenders, devices, deliveries] = await Promise.all([
      run(sb.from('api_tokens').select('id,name,token_hint,last_used_at,created_at,scope').order('created_at')),
      run(sb.from('email_senders').select('id,email').order('created_at')),
      run(sb.from('push_subscriptions').select('id,device,created_at,endpoint').order('created_at', { ascending: false })),
      run(sb.from('push_log').select('*').order('created_at', { ascending: false }).limit(25)),
    ]);
  } finally { loading = false; }
  forgetGone((apiTokens || []).map((t) => t.id));
  app.render();
}

export function viewSettings() {
  if (apiTokens === null) loadSettings();
  const kept = savedTokens();
  const rows = (apiTokens || []).filter((t) => !['capture', 'feed'].includes(t.scope)).map((t) => {
    const agent = !t.scope || t.scope === 'full'; // a location key is copied from Nearby → Alerts
    return `<li class="row" style="cursor:default">
      <div class="row-main"><div class="row-title">${esc(t.name)} <span class="chip">…${esc(t.token_hint)}</span>${t.scope === 'geo' ? ' <span class="chip">📍 Location alerts only</span>' : ''}</div>
      <div class="row-meta"><span>Created ${esc(fmtDate(t.created_at))}</span><span>${t.last_used_at ? `Last used ${esc(fmtDate(t.last_used_at))}` : 'Never used'}</span>${agent && !kept[t.id] ? '<span>Not saved in this browser</span>' : ''}</div></div>
      ${agent && kept[t.id] ? `<button class="btn small" data-copy-token="${t.id}">Copy again</button>` : ''}<button class="btn small danger" data-revoke="${t.id}">Revoke</button></li>`;
  }).join('');
  return `<div class="view-head"><h1>Settings</h1></div>
    <p class="view-sub">Signed in as ${esc(app.user.email)}</p>
    <nav class="set-index" aria-label="Settings sections">${[['Sidebar', 'Sidebar'], ['Agents', 'Agent access'], ['Notifications', 'Notifications'], ['Email', 'Email capture'], ['Dates', 'Dates'], ['Reviews', 'Weekly and daily'], ['Calendars', 'Calendars'], ['Keyboard', 'Keyboard'], ['Folders', 'Folders on your Mac'], ['Import', 'Import'], ['App', 'App'], ['Account', 'Account']]
      .map(([l, h]) => `<button type="button" class="chip" data-scroll-to="${h}">${l}</button>`).join('')}</nav>
    <h2 class="section-title">Sidebar</h2>
    <p class="view-sub" style="margin-bottom:8px">Hide views you don’t use, order each group, and pin perspectives to Do.</p>
    <button class="btn" data-act="customize-sidebar">Customize sidebar</button>
    <h2 class="section-title">Agent access (MCP)</h2>
    <p class="view-sub">Tokens let AI agents like Claude read and update your todos through <code>${MCP_URL}</code>. Agent tokens have full access to your account; location keys (from Nearby → Alerts) can only trigger alerts. Revoke any you no longer use. A token stays in the browser it was made in, so if a connection drops you can copy it again here; anywhere else, make a new one.</p>
    <button class="btn primary" data-act="new-token">Create token</button>
    ${apiTokens === null ? '<p class="empty">Loading…</p>' : rows ? `<ul class="list" style="margin-top:12px">${rows}</ul>` : '<p class="empty">No tokens yet.</p>'}
    ${notificationsSection()}
    <h2 class="section-title">Email capture</h2>
    <p class="view-sub">Forward or send anything to <b>${CAPTURE_EMAIL}</b> and it lands in your Inbox (subject becomes the title, body the notes). Only mail from these addresses is accepted:</p>
    <ul class="list">${emailSenders.map((e) => `<li class="row" style="cursor:default"><div class="row-main"><div class="row-title">${esc(e.email)}</div></div>
      <button class="btn small danger" data-remove-sender="${e.id}">Remove</button></li>`).join('')}</ul>
    <form class="capture" data-add-sender style="margin-top:12px"><input type="email" name="email" placeholder="Add another address you send from" autocomplete="off"><button class="btn">Add</button></form>
    <div class="settings-card bcc-card"><p><b>Waiting For by email:</b> when you email someone and put <b>${CAPTURE_EMAIL}</b> in <b>BCC</b> (or CC), it becomes “Waiting on <i>them</i>: <i>subject</i>”, with your email in the notes and its attachments. They’re added as a person with their email, so Nudge works.</p>
      <p class="hint">Follow up in a subject tag: <code>[3d]</code> <code>[1w]</code> <code>[fri]</code> (removed from the title). Sent <i>to</i> the address, it’s an Inbox item as before.</p>
      <label class="set-row"><span class="set-text"><b>Otherwise follow up in</b></span><select data-setting-waiting-days>${[2, 3, 5, 7, 10, 14, 21, 30].map((d) => `<option value="${d}" ${Number((app.settings || {}).waiting_followup_days || 7) === d ? 'selected' : ''}>${d === 7 ? '1 week' : d === 14 ? '2 weeks' : d === 21 ? '3 weeks' : `${d} days`}</option>`).join('')}</select></label></div>
    ${captureSection((apiTokens || []).filter((t) => t.scope === 'capture'))}
    ${datesSection()}
    ${reviewSection()}
    ${calendarsSection()}
    ${feedSection()}
    ${keyboardSection()}
    ${foldersSection()}
    <h2 class="section-title">Import</h2>
    <p class="view-sub" style="margin-bottom:8px">Moving from OmniFocus? Bring folders, projects, tags, repeats and review schedules over; you'll see a preview first.</p>
    <a class="btn" href="#import">Import from OmniFocus</a>
    <h2 class="section-title">App</h2>
    <p class="view-sub" style="margin-bottom:8px">${app.appVersion ? `Version ${esc(app.appVersion)}. ` : ''}New versions install in the background and switch at a quiet moment. Check now to switch right away.</p>
    <p class="hint" data-screen-info>${esc(screenInfo())}</p>
    <p class="set-inline"><button class="btn" data-act="check-updates" ${app.updateChecking ? 'disabled' : ''}>${app.updateChecking ? 'Checking…' : 'Check for updates'}</button>${app.updateNote ? `<span class="hint">${esc(app.updateNote)}</span>` : ''}</p>
    <h2 class="section-title">Account</h2>
    <button class="btn" data-act="sign-out">Sign out</button>`;
}

export async function createToken() {
  const name = await ask('Name this token', { placeholder: 'Claude Code on MacBook', hint: 'Make one per computer, so you can revoke one without breaking the others.', ok: 'Create token' });
  if (!name) return;
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = 'tt_' + btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  const token_hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const [row] = await run(sb.from('api_tokens').insert({ name: name.trim(), token_hash, token_hint: token.slice(-4) }).select());
  const kept = !!(row && row.id) && rememberToken(row.id, token);
  await loadSettings();
  showTokenSheet('Token created', kept ? 'Copy it now. It stays in this browser, so Settings can show it again here if a connection drops; nowhere else has it.' : 'Copy it now. It won’t be shown again: this browser can’t keep it (private mode).', token);
}

// The token and the command that connects Claude Code with it: at creation, and again from "Copy again".
function showTokenSheet(title, intro, token) {
  const cmd = `claude mcp add --transport http --scope user todotooling ${MCP_URL} --header "Authorization: Bearer ${token}"`;
  const sheet = openSheet(`<form method="dialog">
    <h2>${esc(title)}</h2>
    <p class="view-sub" style="margin:0">${esc(intro)}</p>
    <label>Token<textarea readonly rows="2" onclick="this.select()">${esc(token)}</textarea></label>
    <label>Claude Code command<textarea readonly rows="4" onclick="this.select()">${esc(cmd)}</textarea></label>
    <p class="hint" style="margin:0">Paste this in Terminal on the computer you'll use Claude on. It connects Todo Tooling in every folder there.</p>
    <div class="actions"><div class="right"><button type="button" class="btn" data-copy-value="${esc(token)}">Copy token</button><button type="button" class="btn" data-copy-value="${esc(cmd)}">Copy command</button><button class="btn primary">Done</button></div></div>
  </form>`);
  sheet.querySelectorAll('[data-copy-value]').forEach((b) => { b.onclick = async () => { try { await navigator.clipboard.writeText(b.dataset.copyValue); toast('Copied'); } catch { toast('Couldn’t copy'); } }; });
  if (!sheet.open) sheet.showModal();
}

// "Copy again": the token this browser kept, behind a warning. Only the browser that made a token has it.
export async function copyTokenAgain(id) {
  const t = (apiTokens || []).find((x) => x.id === id);
  const token = savedTokens()[id];
  if (!t || !token) { toast('This token isn’t saved in this browser. Revoke it and create a new one.'); app.render(); return; }
  const sheet = openSheet(`<form method="dialog">
    <h2>Copy this token again?</h2>
    <p class="persp-warning">Usually, don’t. This token has full access to your account, and whatever you paste it into keeps it. Copy it again only to reconnect the computer it was made for, say when Claude’s connection to Todo Tooling drops. If it may have leaked, or you’re setting up another computer, revoke it and create a new token instead.</p>
    <p class="view-sub" style="margin:0">${esc(t.name)} <span class="chip">…${esc(t.token_hint)}</span> · ${t.last_used_at ? `last used ${esc(fmtDate(t.last_used_at))}` : 'never used'}</p>
    <div class="actions"><div class="right"><button class="btn">Cancel</button><button type="button" class="btn primary" data-show>Show the token</button></div></div>
  </form>`);
  $('[data-show]', sheet).onclick = () => showTokenSheet('Token, again', `${t.name}: the same token as before. Paste it where the connection dropped.`, token);
  sheet.showModal();
}

export const newCaptureKey = () => createCaptureKey(loadSettings);
export const captureGuide = () => openCaptureGuide(null);

export async function revokeToken(id) {
  if (!confirm('Revoke this token? Agents using it will lose access immediately.')) return;
  await run(sb.from('api_tokens').delete().eq('id', id));
  forgetToken(id);
  await loadSettings();
}

export async function removeSender(id) {
  if (!confirm('Stop accepting email capture from this address?')) return;
  await run(sb.from('email_senders').delete().eq('id', id));
  await loadSettings();
}

export async function addSender(form) {
  const email = form.elements.email.value.trim().toLowerCase();
  if (!email) return;
  await run(sb.from('email_senders').insert({ email }));
  await loadSettings();
}

// ---------- Notifications: devices, tests, delivery history ----------
const PUSH_TEST_URL = 'https://mcp.todotooling.com/push/test';
const KIND_ICON = { test: '🔔', reminder: '⏰', place: '📍' };
let thisEndpoint = null; // this browser's push subscription, to label "This device"

async function findThisDevice() {
  try {
    if (!('serviceWorker' in navigator) || location.hostname === 'localhost') return;
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg && await reg.pushManager.getSubscription();
    const ep = sub ? sub.endpoint : null;
    if (ep !== thisEndpoint) { thisEndpoint = ep; app.render(); }
  } catch { /* not supported here */ }
}

function resultText(d) {
  if (!d.sent_at) {
    const at = new Date(d.scheduled_for);
    return at < Date.now() - 3600e3 ? '<div class="warn">Never sent (expired)</div>' : `<div class="hint">Queued for ${esc(timeOnly(d.scheduled_for))}</div>`;
  }
  return d.devices ? resultLines(d.results) : '<div class="warn">No devices to send to</div>';
}

function notificationsSection() {
  findThisDevice();
  const mine = window.__thisEndpoint || thisEndpoint;
  const list = devices.map((d) => `<li class="row device-row" style="cursor:default"><div class="row-main"><div class="row-title">${d.device === 'iPhone' || d.device === 'Android' ? '📱' : '💻'} ${esc(d.device)}${d.endpoint === mine ? ' <span class="chip">This device</span>' : ''}</div>
      <div class="row-meta"><span>Added ${esc(fmtDate(d.created_at))}</span></div></div>
      <button class="btn small danger" data-remove-device="${d.id}">Remove</button></li>`).join('');
  const status = `<div class="test-status" data-test-status role="status" ${testState ? '' : 'hidden'}>${testStatusHtml()}</div>`;
  const history = deliveries.map((d) => `<li><div class="delivery-title"><span class="icon">${KIND_ICON[d.kind] || '🔔'}</span><b>${esc(stripIcon(d.title) || d.kind)}</b></div>
      <div class="hint">${esc(when(d.sent_at || d.created_at))}</div>
      <div class="delivery-result">${resultText(d)}</div></li>`).join('');
  return `<h2 class="section-title">Notifications</h2>
    <p class="view-sub">Devices that get reminders and place alerts. Set up a phone from <a href="#alerts">Alerts</a>.</p>
    ${list ? `<ul class="list">${list}</ul>` : '<p class="empty small">No devices yet. Open Todo Tooling on your iPhone → Alerts → Turn on alerts.</p>'}
    <div class="test-buttons"><button class="btn" data-act="push-test-now" ${devices.length && !testRunning() ? '' : 'disabled'}>Send test now</button>
      <button class="btn" data-act="push-test-later" ${devices.length && !testRunning() ? '' : 'disabled'}>Send test in 1 minute</button></div>
    ${status}
    <p class="hint">Delivered but nothing on your phone? Check that no Focus (Sleep, Do Not Disturb) is on, and that iPhone Settings → Notifications → Todo allows notifications.</p>
    <details class="delivery-log" ${history ? 'open' : ''}><summary>Delivery history</summary>${history ? `<ul>${history}</ul>` : '<p class="hint">Nothing sent yet.</p>'}</details>`;
}

const testRunning = () => !!testState && testState.phase !== 'done';

function testStatusHtml() {
  if (!testState) return '';
  if (testState.phase === 'counting') {
    const s = Math.max(0, Math.ceil((testState.until - Date.now()) / 1000));
    return `<b>⏳ ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}</b> Lock your phone now. The notification arrives in the background.`;
  }
  if (testState.phase === 'waiting') return '<b>📨 Sending…</b> (the server sends queued tests within a minute)';
  return testState.text;
}

// Update just the status box every second, so a countdown survives other re-renders.
let ticker = null;
function tick() {
  const el = document.querySelector('[data-test-status]');
  if (el) { el.hidden = !testState; el.innerHTML = testStatusHtml(); }
  document.querySelectorAll('[data-act="push-test-now"], [data-act="push-test-later"]').forEach((b) => { b.disabled = !devices.length || testRunning(); });
  if (testState && testState.phase === 'counting' && Date.now() >= testState.until) testState.phase = 'waiting';
}
function startTicker() { clearInterval(ticker); ticker = setInterval(() => { tick(); if (!testState || testState.phase === 'done') clearInterval(ticker); }, 1000); tick(); }

async function callPushTest(delay) {
  if (window.__pushTest) return window.__pushTest(delay); // tests
  const { data } = await sb.auth.getSession();
  const res = await fetch(PUSH_TEST_URL, { method: 'POST', headers: { Authorization: `Bearer ${data.session.access_token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ delay_seconds: delay }) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Server said ${res.status}`);
  return body;
}

export async function pushTestNow() {
  testState = { phase: 'waiting' };
  startTicker();
  try {
    const out = await callPushTest(0);
    testState = { phase: 'done', text: out.devices ? resultText({ sent_at: 1, devices: out.devices, results: out.results }) : '<div class="warn">No devices to send to.</div>' };
  } catch (e) { testState = { phase: 'done', text: `<span class="warn">${esc(e.message)}</span>` }; }
  await loadSettings();
}

export async function pushTestLater() {
  try {
    const out = await callPushTest(60);
    testState = { phase: 'counting', until: Date.now() + 60e3, id: out.queued };
    startTicker();
    loadSettings(); // show the queued test in Delivery history right away
    // Watch for the queued row to be sent, then show its result.
    const started = Date.now();
    const poll = setInterval(async () => {
      if (!testState || testState.id !== out.queued) { clearInterval(poll); return; }
      const rows = await run(sb.from('push_log').select('*').eq('id', out.queued));
      if (rows[0] && rows[0].sent_at) {
        clearInterval(poll);
        testState = { phase: 'done', text: resultText(rows[0]) };
        tick();
        await loadSettings();
      } else if (Date.now() - started > 4 * 60e3) {
        clearInterval(poll);
        testState = { phase: 'done', text: '<span class="warn">Not sent after 3 minutes. The server may be busy; try Send test now.</span>' };
        tick();
      }
    }, window.__pollMs || 5000);
  } catch (e) { testState = { phase: 'done', text: `<span class="warn">${esc(e.message)}</span>` }; startTicker(); }
  app.render();
}

export async function removeDevice(id) {
  if (!confirm('Stop sending notifications to this device? You can turn them on again from Alerts on that device.')) return;
  await run(sb.from('push_subscriptions').delete().eq('id', id));
  await loadSettings();
}

// ---------- Dates: default times and the Forecast tag (saved to the account) ----------
function datesSection() {
  const st = app.settings || DEFAULT_SETTINGS;
  const row = (key, label, hint) => `<label class="set-row"><span class="set-text"><b>${label}</b><span class="hint">${hint}</span></span><input type="time" step="300" data-setting-time="${key}" value="${minutesToInput(st[key])}"></label>`;
  return `<h2 class="section-title">Dates</h2>
    <p class="view-sub">When you pick just a day, this is the time it lands at. Agents, templates and imports use the same times.</p>
    <div class="settings-card">
      ${row('due_minutes', 'Due dates', 'a deadline on that day')}
      ${row('defer_minutes', 'Defer dates', 'when it shows up again')}
      ${row('planned_minutes', 'Planned dates', 'when you mean to do it')}
      <label class="set-row"><span class="set-text"><b>Always show in Today</b><span class="hint">actions with this tag appear in Forecast → Today</span></span>
        <select data-setting-forecast-tag><option value="">No tag</option>${sortedTags().map((g) => `<option value="${g.id}" ${st.forecast_tag_id === g.id ? 'selected' : ''}>${esc(tagLabel(g))}</option>`).join('')}</select></label>
      <p class="hint">Time zone: ${esc(st.timezone || localTz())} (from this device)</p>
    </div>`;
}

// ---------- Weekly Review: day, time, reminder, mind sweep prompts ----------
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function reviewSection() {
  const st = { ...DEFAULT_SETTINGS, ...(app.settings || {}) };
  const hidden = (st.trigger_hidden || []).length;
  const custom = (st.trigger_custom || []).length;
  return `<h2 class="section-title">Weekly and daily review</h2>
    <p class="view-sub">The day you get clear, get current and get creative. On that day Forecast reminds you, and (if you like) your devices do too.</p>
    <div class="settings-card">
      <label class="set-row"><span class="set-text"><b>Review day</b><span class="hint">Friday afternoon clears your head for the weekend</span></span>
        <select data-setting-review-day>${WEEKDAYS.map((d, i) => `<option value="${i}" ${Number(st.review_day) === i ? 'selected' : ''}>${d}</option>`).join('')}</select></label>
      <label class="set-row"><span class="set-text"><b>Time</b><span class="hint">when it’s due that day</span></span><input type="time" step="900" data-setting-time="review_minutes" value="${minutesToInput(st.review_minutes)}"></label>
      <label class="set-row"><span class="set-text"><b>Notification</b><span class="hint">a push to your devices at that time, unless you’ve already reviewed</span></span><input type="checkbox" data-setting-review-notify ${st.review_notify ? 'checked' : ''}></label>
      <label class="set-row"><span class="set-text"><b>Morning reminder</b><span class="hint">“☀️ Start your day”, skipped once you have</span></span><input type="checkbox" data-setting-daily-notify ${st.daily_notify ? 'checked' : ''}></label>
      <label class="set-row"><span class="set-text"><b>At</b><span class="hint">${st.daily_weekdays_only ? 'Monday to Friday' : 'every day'} · <button type="button" class="link-btn" data-setting-daily-days>${st.daily_weekdays_only ? 'every day' : 'weekdays only'}</button></span></span><input type="time" step="900" data-setting-time="daily_minutes" value="${minutesToInput(st.daily_minutes)}"></label>
      <label class="set-row"><span class="set-text"><b>Six: plan tomorrow from</b><span class="hint">from this time Six opens on tomorrow’s list, with what’s left of today at the top</span></span><input type="time" step="900" data-setting-time="six_evening_minutes" value="${minutesToInput(st.six_evening_minutes ?? 960)}"></label>
      <p class="hint">Mind sweep prompts: ${hidden ? `${hidden} hidden · ` : ''}${custom ? `${custom} of your own · ` : ''}<a href="#sweep">open the mind sweep</a> to add or change them.</p>
    </div>`;
}

// ---------- Keyboard: the drawn keyboard and every shortcut ----------
// Folders on your Mac: where your _Todo folder is, and the Shortcut that opens folders (browsers can't).
export const FOLDER_SCRIPT = '[ -z "$1" ] && exit 0\np="${1/#\\~/$HOME}"\nmkdir -p "$p" && open "$p"';
function foldersSection() {
  const st = { ...DEFAULT_SETTINGS, ...(app.settings || {}) };
  const test = st.todo_folder || '~/Desktop';
  return `<h2 class="section-title">Folders on your Mac</h2>
    <p class="view-sub">An action or project can name the folder that holds its files. Its <b>📂 Open folder</b> button opens it in Finder through a Shortcut (websites can’t open folders themselves). Mac only.</p>
    <div class="settings-card">
      <label class="set-row"><span class="set-text"><b>Your _Todo folder</b><span class="hint">support files for live actions; “Use …” suggests a subfolder named like the action</span></span><input type="text" data-setting-text="todo_folder" value="${esc(st.todo_folder || '')}" placeholder="~/_SYNC/MAGA/_Todo" spellcheck="false" style="max-width:280px"></label>
      <label class="set-row"><span class="set-text"><b>Shortcut name</b><span class="hint">the Shortcut the button runs</span></span><input type="text" data-setting-text="folder_shortcut" value="${esc(st.folder_shortcut || 'Open in Finder')}" maxlength="100" style="max-width:200px"></label>
      <p style="margin:12px 0 4px"><b>Set up the Shortcut once</b> (on your Mac):</p>
      <ol class="folder-steps">
        <li>Open the <b>Shortcuts</b> app → <b>Settings → Advanced</b> → turn on <b>Allow Running Scripts</b>.</li>
        <li><b>File → New Shortcut</b>, and name it <b>${esc(st.folder_shortcut || 'Open in Finder')}</b>.</li>
        <li>Add a <b>Run Shell Script</b> action. Set <b>Input</b> to <b>Shortcut Input</b> and <b>Pass Input</b> to <b>as arguments</b>, then paste:
          <pre class="code-block"><code>${esc(FOLDER_SCRIPT)}</code></pre><button type="button" class="btn small" data-copy-folder-script>Copy script</button></li>
        <li>At the top, set it to receive <b>Text</b>. Close the window (it saves itself).</li>
        <li>Press <b>Test</b>: Brave asks to open Shortcuts the first time; tick <b>Always allow</b>. Missing folders are created, then opened.</li>
      </ol>
      <p style="margin-top:10px"><a class="btn" href="${esc(openFolderUrl(test))}" data-open-folder>📂 Test: open ${esc(test)}</a></p>
    </div>`;
}

function keyboardSection() {
  return `<h2 class="section-title">Keyboard</h2>
    <p class="view-sub">With a keyboard (Mac, PC, iPad), plain keys do things when you’re not typing. Highlighted keys have shortcuts; hover or tap one to see what it does. Press <kbd>?</kbd> anywhere for this list.</p>
    <div class="settings-card">${keyboardHtml()}<div class="kbd-lists">${shortcutListHtml()}</div></div>`;
}

document.addEventListener('click', async (e) => {
  const cp = e.target.closest && e.target.closest('[data-copy-folder-script]');
  if (cp) { try { await navigator.clipboard.writeText(FOLDER_SCRIPT); toast('Script copied'); } catch { toast('Select the script and copy it'); } return; }
  const dd = e.target.closest && e.target.closest('[data-setting-daily-days]');
  if (dd) { await saveSettings({ daily_weekdays_only: !(app.settings || {}).daily_weekdays_only }); app.render(); }
});
document.addEventListener('change', async (e) => {
  const time = e.target.closest && e.target.closest('[data-setting-time]');
  if (time) { const m = inputToMinutes(time.value); if (m !== null) await saveSettings({ [time.dataset.settingTime]: m }); return; }
  const tag = e.target.closest && e.target.closest('[data-setting-forecast-tag]');
  if (tag) { await saveSettings({ forecast_tag_id: tag.value || null }); return; }
  const dp = e.target.closest && e.target.closest('[data-setting-distance-place]');
  if (dp) { await saveSettings({ distance_place_id: dp.value || null }); app.render(); return; }
  const day = e.target.closest && e.target.closest('[data-setting-review-day]');
  if (day) { await saveSettings({ review_day: Number(day.value) }); return; }
  const wdays = e.target.closest && e.target.closest('[data-setting-waiting-days]');
  if (wdays) { await saveSettings({ waiting_followup_days: Number(wdays.value) }); return; }
  const dn = e.target.closest && e.target.closest('[data-setting-daily-notify]');
  if (dn) { await saveSettings({ daily_notify: dn.checked }); return; }
  const txt = e.target.closest && e.target.closest('[data-setting-text]');
  if (txt) { const k = txt.dataset.settingText; const v = txt.value.trim(); await saveSettings({ [k]: v || (k === 'folder_shortcut' ? 'Open in Finder' : null) }); app.render(); return; }
  const notify = e.target.closest && e.target.closest('[data-setting-review-notify]');
  if (notify) await saveSettings({ review_notify: notify.checked });
});

// ---------- Your scheduled actions as a calendar (a private feed Apple/Google subscribe to) ----------
const FEED_BASE = 'mcp.todotooling.com/feed/';
function feedSection() {
  const feeds = (apiTokens || []).filter((t) => t.scope === 'feed');
  return `<div class="settings-card feed-card"><p><b>Your scheduled actions in your calendar</b></p>
    <p class="hint">Subscribe once in Apple or Google Calendar and actions you schedule (Schedule it) and your own events (Forecast → + Event) appear there, and stay in sync. Apple checks every few minutes; Google can take a few hours, so use “Add to Google” for today.</p>
    ${feeds.length ? `<p class="hint">Feed link made ${esc(fmtDate(feeds[0].created_at))}${feeds[0].last_used_at ? ` · last read ${esc(fmtDate(feeds[0].last_used_at))}` : ' · not subscribed yet'}</p>` : ''}
    <button class="btn" data-act="feed-link">${feeds.length ? 'Reset the link' : 'Get the feed link'}</button></div>`;
}
export async function newFeedLink() {
  const old = (apiTokens || []).filter((t) => t.scope === 'feed');
  if (old.length && !confirm('Make a new link? The old one stops working; re-subscribe with the new one.')) return;
  for (const t of old) await run(sb.from('api_tokens').delete().eq('id', t.id));
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = 'tt_' + btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  const token_hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  await run(sb.from('api_tokens').insert({ name: 'Calendar feed', token_hash, token_hint: token.slice(-4), scope: 'feed' }));
  await loadSettings();
  const webcal = `webcal://${FEED_BASE}${token}.ics`;
  const https = `https://${FEED_BASE}${token}.ics`;
  const sheet = openSheet(`<form method="dialog" class="cap-guide"><h2>Subscribe to your schedule</h2>
    <p class="persp-warning">Copy it now. It won’t be shown again (you can always reset it). Anyone with the link can see your scheduled actions.</p>
    <p><b>iPhone or Mac:</b> <a class="btn small" href="${esc(webcal)}">Subscribe in Calendar</a> or Settings → Calendar → Accounts → Add Account → Other → Add Subscribed Calendar, and paste:</p>
    <div class="cap-copy"><code>${esc(webcal)}</code><button type="button" class="btn small" data-copy-value="${esc(webcal)}">Copy</button></div>
    <p><b>Google Calendar</b> (on a computer): Other calendars → + → From URL, and paste:</p>
    <div class="cap-copy"><code>${esc(https)}</code><button type="button" class="btn small" data-copy-value="${esc(https)}">Copy</button></div>
    <div class="actions"><div class="right"><button class="btn primary">Done</button></div></div></form>`);
  sheet.querySelectorAll('[data-copy-value]').forEach((b) => { b.onclick = async () => { try { await navigator.clipboard.writeText(b.dataset.copyValue); toast('Copied'); } catch { toast('Couldn’t copy'); } }; });
  sheet.showModal();
}

// This device, for support: viewport, safe-area insets, where the tab bar ends, and how the app is opened.
function screenInfo() {
  let inset = { top: 0, bottom: 0 };
  try {
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;visibility:hidden;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)';
    document.body.append(el);
    const cs = getComputedStyle(el);
    inset = { top: Math.round(parseFloat(cs.paddingTop) || 0), bottom: Math.round(parseFloat(cs.paddingBottom) || 0) };
    el.remove();
  } catch { /* fine */ }
  const tabs = document.querySelector('.tabs');
  const gap = tabs && getComputedStyle(tabs).position === 'fixed' ? Math.round(window.innerHeight - tabs.getBoundingClientRect().bottom) : null;
  const vv = window.visualViewport ? Math.round(window.visualViewport.height) : null;
  const how = navigator.standalone ? 'Home Screen app' : window.matchMedia('(display-mode: standalone)').matches ? 'installed app' : 'browser';
  return `This device: ${window.innerWidth}×${window.innerHeight}${vv && vv !== window.innerHeight ? ` (visible ${vv})` : ''} · safe area top ${inset.top}, bottom ${inset.bottom}${gap != null ? ` · tab bar ends ${gap} px above the bottom` : ''} · ${how}.`;
}

// ---------- Calendars: private iCal links shown in Forecast ----------
const calState = { adding: false, checking: false, checked: null, error: '', name: '', url: '', color: COLORS[0] };
function calendarsSection() {
  const list = liveCalendars();
  const status = (c) => (c.last_error ? `<span class="cal-bad">⚠️ ${esc(c.last_error)}</span>` : c.last_ok_at ? `<span class="cal-ok">✓ ${c.event_count ?? ''} event${c.event_count === 1 ? '' : 's'}</span>` : '');
  const form = calState.adding ? `<form class="cal-add" data-cal-add>
      <label>Name<input type="text" name="cal_name" value="${esc(calState.name)}" placeholder="Work" autocomplete="off" required></label>
      <label>Private iCal link<input type="url" name="cal_url" value="${esc(calState.url)}" placeholder="https://calendar.google.com/calendar/ical/…/basic.ics" autocomplete="off" spellcheck="false" required></label>
      <div class="cal-colors" role="radiogroup" aria-label="Color">${COLORS.map((c) => `<button type="button" class="cal-color ${calState.color === c ? 'on' : ''}" data-cal-color="${c}" style="--cal:${c}" role="radio" aria-checked="${calState.color === c}" aria-label="Color ${c}"></button>`).join('')}</div>
      <details class="cal-help"><summary>Where do I find the link?</summary>
        <p><b>Google:</b> calendar.google.com → ⚙️ Settings → your calendar (left) → <i>Integrate calendar</i> → <i>Secret address in iCal format</i>.</p>
        <p><b>iCloud:</b> Calendar app → the calendar’s ⓘ → <i>Public Calendar</i> → Share link (webcal://…).</p>
        <p><b>Outlook:</b> Settings → Calendar → Shared calendars → <i>Publish a calendar</i> → the ICS link.</p>
        <p class="hint">Treat the link like a password: anyone with it can read that calendar. Here only you can see it.</p></details>
      ${calState.error ? `<p class="persp-warning">⚠️ ${esc(calState.error)}</p>` : ''}
      ${calState.checked ? `<div class="cal-check">✓ ${calState.checked.name ? `“${esc(calState.checked.name)}”, ` : ''}${calState.checked.count} events.
        ${calState.checked.upcoming.length ? `Next: ${calState.checked.upcoming.map((e) => `${esc(e.title)} (${esc((e.allDay ? new Date(`${e.days[0]}T12:00:00`) : new Date(e.start)).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }))}${e.allDay ? '' : `, ${esc(fmtEventTime(e))}`})`).join(' · ')}` : ''}</div>` : ''}
      <div class="actions"><button type="button" class="btn" data-cal-cancel>Cancel</button><div class="right">
        ${calState.checked ? '<button type="submit" class="btn primary" data-cal-save>Add calendar</button>' : `<button type="submit" class="btn primary" data-cal-check ${calState.checking ? 'disabled' : ''}>${calState.checking ? 'Checking…' : 'Check link'}</button>`}</div></div>
    </form>` : '<button class="btn" data-cal-new>+ Add a calendar</button>';
  return `<h2 class="section-title">Calendars</h2>
    <p class="view-sub">Show your calendar events in Forecast, next to what’s due and planned. Read-only; events aren’t stored. Your own events (an airshow, a trip) are added in Forecast with <b>+ Event</b>, or by Claude.</p>
    <div class="settings-card">
      ${list.map((c) => `<div class="cal-row"><span class="cal-dot" style="--cal:${esc(c.color)}"></span>
        <span class="set-text"><b>${esc(c.name)}</b><span class="hint">${esc(maskUrl(c.url))} ${status(c)}</span></span>
        <label class="cal-toggle" title="Show in Forecast"><input type="checkbox" data-cal-enabled="${c.id}" ${c.enabled ? 'checked' : ''}> Show</label>
        <button class="btn small" data-cal-remove="${c.id}">Remove</button></div>`).join('')}
      ${form}
    </div>
    <div class="settings-card">
      <label class="set-row"><span class="set-text"><b>Distances to events</b><span class="hint">from your location when it’s on (Nearby); otherwise from this place</span></span>
        <select data-setting-distance-place><option value="">Nowhere (no distance)</option>${activePlaces().map((p) => `<option value="${p.id}" ${(app.settings || {}).distance_place_id === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
    </div>`;
}

document.addEventListener('click', async (e) => {
  if (!location.hash.startsWith('#settings')) return;
  const t = e.target;
  if (t.closest('[data-cal-new]')) { Object.assign(calState, { adding: true, checked: null, error: '', name: '', url: '', color: COLORS[liveCalendars().length % COLORS.length] }); app.render(); setTimeout(() => { const i = document.querySelector('[name=cal_name]'); if (i) i.focus(); }, 0); return; }
  if (t.closest('[data-cal-cancel]')) { calState.adding = false; app.render(); return; }
  const col = t.closest('[data-cal-color]');
  if (col) { calState.color = col.dataset.calColor; app.render(); return; }
  const rm = t.closest('[data-cal-remove]');
  if (rm) { const c = liveCalendars().find((x) => x.id === rm.dataset.calRemove); if (c) archiveCalendar(c); }
});
document.addEventListener('input', (e) => {
  if (!e.target.closest || !e.target.closest('[data-cal-add]')) return;
  if (e.target.name === 'cal_name') calState.name = e.target.value;
  if (e.target.name === 'cal_url') { calState.url = e.target.value; calState.checked = null; calState.error = ''; }
});
document.addEventListener('change', async (e) => {
  const en = e.target.closest && e.target.closest('[data-cal-enabled]');
  if (en) { const c = liveCalendars().find((x) => x.id === en.dataset.calEnabled); if (c) updateCalendar(c, { enabled: en.checked }); }
});
document.addEventListener('submit', async (e) => {
  const form = e.target.closest && e.target.closest('[data-cal-add]');
  if (!form) return;
  e.preventDefault();
  if (!calState.name.trim() || !calState.url.trim()) return;
  if (!calState.checked) {
    calState.checking = true; calState.error = ''; app.render();
    try { calState.checked = await checkLink(calState.url); if (!calState.name.trim() && calState.checked.name) calState.name = calState.checked.name; } catch (err) { calState.error = err.message; }
    calState.checking = false; app.render();
    return;
  }
  const row = await addCalendar({ name: calState.name.trim(), url: calState.url, color: calState.color, count: calState.checked.count });
  Object.assign(calState, { adding: false, checked: null, url: '', name: '' });
  app.render();
  toast(`Added “${row.name}”. Its events show in Forecast.`);
});

// The index at the top: jump to a section (by its heading; the hash stays #settings).
document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('[data-scroll-to]');
  if (!b) return;
  const h = [...document.querySelectorAll('#view h2.section-title')].find((x) => x.textContent.trim().startsWith(b.dataset.scrollTo));
  if (h) h.scrollIntoView({ behavior: 'smooth', block: 'start' });
});
