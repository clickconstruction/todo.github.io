// Ask Claude about a card: a prompt on the clipboard that tells Claude where you are, what the card holds
// and what you want, to paste into any chat that has the Todo Tooling tools (or none: the card is in the
// text). Offered on the card's editor and panel ("Ask Claude…"), on the Clarify screen, and with C on a
// selected item. The sheet lists the usual asks; "Just the card" leaves the ask to you. It sits on #sheet2,
// so it can open over an editor.
import { db, $, esc, byId, isOpen, toast, tagsFor, tagLabel } from './state.js';
import { fmtDate } from './dates.js';
import { describe } from './repeat.js';
import { describeDaily } from './daily-rules.js';
import { stepsOf } from './tree.js';
import { attachmentsFor } from './editors/attachField.js';
import { cardBlockers } from './availability.js';
import { waitingPerson, isWaiting } from './gtd.js';

export const ASKS = [
  ['clarify', 'Clarify it with me', 'Is it a next action, a project, someday, reference, or something to hand off? Ask me what you need, then suggest the decision.'],
  ['steps', 'Break it into steps', 'Suggest the concrete steps, first step first. I’ll say when to add them.'],
  ['draft', 'Draft the message', 'Draft the email or message this needs: short, in my voice.'],
  ['think', 'Think it through', 'What is really being asked, what it would take, what I gain, and whether it is worth doing.'],
  ['card', 'Just the card', 'I’ll say what I want.'],
];
const WHERE = { inbox: 'my Inbox', clarify: 'clarifying my Inbox', forecast: 'Forecast', six: 'Six, today’s list', flagged: 'Flagged', now: 'What now?', matrix: 'the Matrix', waiting: 'Waiting For', someday: 'Someday/Maybe', tickler: 'the Tickler', search: 'a search', full: 'a Full Review', daily: 'the Daily review', weekly: 'the Weekly Review', reading: 'Reading & watching', done: 'Done' };

// Where the user is, for the prompt: a named view, a project or person by name, else the page's title.
export function whereAmI() {
  const [view, id] = (location.hash.slice(1) || 'inbox').split('/');
  if (view === 'project') { const p = byId(db.projects, id); if (p) return `the project “${p.name}”`; }
  if (view === 'person') { const p = byId(db.people || [], id); if (p) return `${p.name}’s page`; }
  if (view === 'tag') { const g = byId(db.tags, id); if (g) return `the tag “${tagLabel(g)}”`; }
  if (WHERE[view]) return WHERE[view];
  const h1 = $('#view .view-head h1');
  return h1 ? h1.textContent.trim() : view;
}

// The prompt: the card as the user sees it, one line per thing, then the ask, then how Claude can act.
export function askPrompt(t, askKey = 'card', where = whereAmI()) {
  const ask = ASKS.find(([k]) => k === askKey);
  const p = t.project_id && byId(db.projects, t.project_id);
  const parent = t.parent_id && byId(db.tasks, t.parent_id);
  const facts = [p ? `Project: ${p.name}` : t.in_inbox ? 'In the Inbox, not yet clarified' : 'No project'];
  if (parent) facts.push(`A step of “${parent.title}”`);
  const tags = tagsFor(t.id).map(tagLabel);
  if (tags.length) facts.push(`Tags: ${tags.join(', ')}`);
  if (t.flagged) facts.push('Flagged');
  if (t.daily) facts.push(describeDaily(t.daily)); else if (t.repeat_rule) facts.push(`Repeats: ${describe(t.repeat_rule)}`);
  if (t.defer_at) facts.push(`Deferred until ${fmtDate(t.defer_at)}`);
  if (t.planned_at) facts.push(`Planned ${fmtDate(t.planned_at)}`);
  if (t.due_at) facts.push(`Due ${fmtDate(t.due_at)}`);
  if (t.estimate_minutes) facts.push(`${t.estimate_minutes} min`);
  if (t.energy) facts.push(`${t.energy} energy`);
  if (isWaiting(t)) { const who = waitingPerson(t); facts.push(`Waiting for ${who ? who.name : 'someone'}${t.follow_up_at ? `, follow up ${fmtDate(t.follow_up_at)}` : ''}`); }
  const waits = cardBlockers(t);
  if (waits.length) facts.push(`Waits for ${waits.map((w) => `“${w.title}”`).join(', ')}`);
  if (t.completed_at) facts.push(`Completed ${fmtDate(t.completed_at)}`); else if (t.dropped_at) facts.push(`Dropped ${fmtDate(t.dropped_at)}`);
  facts.push(`Captured ${fmtDate(t.created_at)}`);
  const lines = [`Help me with this card in Todo Tooling: “${t.title}”`, `Where I am: ${where}. Card: ${location.origin}${location.pathname}#task/${t.id} (id ${t.id}).`, facts.join(' · ')];
  if (t.gain) lines.push(`What I gain: ${t.gain}${t.gain_by === 'agent' ? ' (Claude suggested this; I haven’t kept it yet)' : ''}`);
  if (t.gain_cost) lines.push(`If I don’t: ${t.gain_cost}`);
  if (t.notes) lines.push(`Notes:\n${t.notes}`);
  const steps = stepsOf(t).filter(isOpen);
  if (steps.length) lines.push(`Steps:\n${steps.map((s, i) => `${i + 1}. ${s.title}`).join('\n')}`);
  const files = attachmentsFor('task_id', t.id);
  if (files.length) lines.push(`Attached: ${files.map((f) => f.name).join(', ')}`);
  lines.push('', `What I want: ${ask && ask[0] !== 'card' ? ask[2] : ''}`.trimEnd(), '');
  lines.push(`If you have my Todo Tooling tools, get_task ${t.id} has the whole card, and clarify_item, update_task and break_down can change it. Suggest first; change the card only when I say so.`);
  return lines.join('\n');
}

// Copy it; where there is no clipboard, show it to copy by hand.
export async function copyAsk(t, askKey = 'card') {
  const text = askPrompt(t, askKey);
  try { await navigator.clipboard.writeText(text); toast('Copied for Claude: paste it into a chat'); return true; } catch {
    const dlg = $('#sheet2');
    dlg.innerHTML = `<form method="dialog" class="ask-claude"><h2>Copy this for Claude</h2><textarea readonly rows="14" aria-label="The prompt">${esc(text)}</textarea>
      <div class="actions"><div class="right"><button class="btn primary">Done</button></div></div></form>`;
    if (!dlg.open) dlg.showModal();
    const ta = $('textarea', dlg); ta.focus(); ta.select();
    return false;
  }
}

export function openAskClaude(t) {
  if (!t) return;
  const dlg = $('#sheet2');
  dlg.innerHTML = `<form method="dialog" class="ask-claude"><h2>Ask Claude about “${esc(t.title)}”</h2>
    <p class="hint">Copies a prompt that says where you are, what the card holds and what you want. Paste it into any chat with your Todo Tooling tools.</p>
    <div class="ask-list">${ASKS.map(([k, l, sub]) => `<button type="button" class="ask-choice" data-ask="${k}"><b>${esc(l)}</b><span>${esc(sub)}</span></button>`).join('')}</div>
    <div class="actions"><div class="right"><button type="button" class="btn" data-cancel>Cancel</button></div></div></form>`;
  $('[data-cancel]', dlg).onclick = () => dlg.close();
  dlg.querySelectorAll('[data-ask]').forEach((b) => { b.onclick = async () => { const copied = await copyAsk(byId(db.tasks, t.id) || t, b.dataset.ask); if (copied) dlg.close(); }; });
  dlg.showModal();
  $('[data-ask]', dlg).focus();
}
