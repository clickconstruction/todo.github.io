// Settings: agent access tokens (MCP), email-capture senders, account.
import { sb, app, esc, run, toast, openSheet, $ } from '../state.js';
import { fmtDate } from '../dates.js';

const MCP_URL = 'https://mcp.todotooling.com/mcp';
const CAPTURE_EMAIL = 'inbox@todotooling.com';
let apiTokens = null;
let emailSenders = [];
let loading = false;

export const resetSettings = () => { apiTokens = null; emailSenders = []; };

async function loadSettings() {
  if (loading) return;
  loading = true;
  try {
    [apiTokens, emailSenders] = await Promise.all([
      run(sb.from('api_tokens').select('id,name,token_hint,last_used_at,created_at,scope').order('created_at')),
      run(sb.from('email_senders').select('id,email').order('created_at')),
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
    <h2 class="section-title">Email capture</h2>
    <p class="view-sub">Forward or send anything to <b>${CAPTURE_EMAIL}</b> and it lands in your Inbox (subject becomes the title, body the notes). Only mail from these addresses is accepted:</p>
    <ul class="list">${emailSenders.map((e) => `<li class="row" style="cursor:default"><div class="row-main"><div class="row-title">${esc(e.email)}</div></div>
      <button class="btn small danger" data-remove-sender="${e.id}">Remove</button></li>`).join('')}</ul>
    <form class="capture" data-add-sender style="margin-top:12px"><input type="email" name="email" placeholder="Add another address you send from" autocomplete="off"><button class="btn">Add</button></form>
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
