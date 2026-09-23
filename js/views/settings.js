// Settings: agent access tokens (MCP), email-capture senders, account.
import { saveSettings, DEFAULT_SETTINGS, minutesToInput, inputToMinutes } from '../prefs.js';
import { keyboardHtml, shortcutListHtml } from '../shortcuts.js';
import { localTz } from '../repeat.js';
import { sb, app, esc, run, toast, openSheet, $, sortedTags, tagLabel } from '../state.js';
import { fmtDate } from '../dates.js';
import { resultLines, stripIcon, when, timeOnly } from '../pushResult.js';

const MCP_URL = 'https://mcp.todotooling.com/mcp';
const CAPTURE_EMAIL = 'inbox@todotooling.com';
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
  app.render();
}

export function viewSettings() {
  if (apiTokens === null) loadSettings();
  const rows = (apiTokens || []).map((t) => `<li class="row" style="cursor:default">
      <div class="row-main"><div class="row-title">${esc(t.name)} <span class="chip">…${esc(t.token_hint)}</span>${t.scope === 'geo' ? ' <span class="chip">📍 Location alerts only</span>' : ''}</div>
      <div class="row-meta"><span>Created ${esc(fmtDate(t.created_at))}</span><span>${t.last_used_at ? `Last used ${esc(fmtDate(t.last_used_at))}` : 'Never used'}</span></div></div>
      <button class="btn small danger" data-revoke="${t.id}">Revoke</button></li>`).join('');
  return `<div class="view-head"><h1>Settings</h1></div>
    <p class="view-sub">Signed in as ${esc(app.user.email)}</p>
    <h2 class="section-title">Agent access (MCP)</h2>
    <p class="view-sub">Tokens let AI agents like Claude read and update your todos through <code>${MCP_URL}</code>. Agent tokens have full access to your account; location keys (from Nearby → Alerts) can only trigger alerts. Revoke any you no longer use.</p>
    <button class="btn primary" data-act="new-token">Create token</button>
    ${apiTokens === null ? '<p class="empty">Loading…</p>' : rows ? `<ul class="list" style="margin-top:12px">${rows}</ul>` : '<p class="empty">No tokens yet.</p>'}
    ${notificationsSection()}
    <h2 class="section-title">Email capture</h2>
    <p class="view-sub">Forward or send anything to <b>${CAPTURE_EMAIL}</b> and it lands in your Inbox (subject becomes the title, body the notes). Only mail from these addresses is accepted:</p>
    <ul class="list">${emailSenders.map((e) => `<li class="row" style="cursor:default"><div class="row-main"><div class="row-title">${esc(e.email)}</div></div>
      <button class="btn small danger" data-remove-sender="${e.id}">Remove</button></li>`).join('')}</ul>
    <form class="capture" data-add-sender style="margin-top:12px"><input type="email" name="email" placeholder="Add another address you send from" autocomplete="off"><button class="btn">Add</button></form>
    ${datesSection()}
    ${keyboardSection()}
    <h2 class="section-title">Import</h2>
    <p class="view-sub" style="margin-bottom:8px">Moving from OmniFocus? Bring folders, projects, tags, repeats and review schedules over; you'll see a preview first.</p>
    <a class="btn" href="#import">Import from OmniFocus</a>
    <h2 class="section-title">Account</h2>
    <button class="btn" data-act="sign-out">Sign out</button>`;
}

export async function createToken() {
  const name = prompt('Name this token (e.g. "Claude Code on MacBook")');
  if (!name || !name.trim()) return;
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = 'tt_' + btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  const token_hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  await run(sb.from('api_tokens').insert({ name: name.trim(), token_hash, token_hint: token.slice(-4) }));
  await loadSettings();
  const cmd = `claude mcp add --transport http todotooling ${MCP_URL} --header "Authorization: Bearer ${token}"`;
  const sheet = openSheet(`<form method="dialog">
    <h2>Token created</h2>
    <p class="view-sub" style="margin:0">Copy it now. It won't be shown again.</p>
    <label>Token<textarea readonly rows="2" onclick="this.select()">${esc(token)}</textarea></label>
    <label>Claude Code command<textarea readonly rows="4" onclick="this.select()">${esc(cmd)}</textarea></label>
    <div class="actions"><div class="right"><button type="button" class="btn" data-copy>Copy command</button><button class="btn primary">Done</button></div></div>
  </form>`);
  $('[data-copy]', sheet).onclick = async () => { await navigator.clipboard.writeText(cmd); toast('Copied'); };
  sheet.showModal();
}

export async function revokeToken(id) {
  if (!confirm('Revoke this token? Agents using it will lose access immediately.')) return;
  await run(sb.from('api_tokens').delete().eq('id', id));
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

// ---------- Keyboard: the drawn keyboard and every shortcut ----------
function keyboardSection() {
  return `<h2 class="section-title">Keyboard</h2>
    <p class="view-sub">With a keyboard (Mac, PC, iPad), plain keys do things when you’re not typing. Highlighted keys have shortcuts; hover or tap one to see what it does. Press <kbd>?</kbd> anywhere for this list.</p>
    <div class="settings-card">${keyboardHtml()}<div class="kbd-lists">${shortcutListHtml()}</div></div>`;
}

document.addEventListener('change', async (e) => {
  const time = e.target.closest && e.target.closest('[data-setting-time]');
  if (time) { const m = inputToMinutes(time.value); if (m !== null) await saveSettings({ [time.dataset.settingTime]: m }); return; }
  const tag = e.target.closest && e.target.closest('[data-setting-forecast-tag]');
  if (tag) await saveSettings({ forecast_tag_id: tag.value || null });
});
