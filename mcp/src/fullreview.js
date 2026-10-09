// Full Review for agents: the same session and current card the user sees in the app (#full/<id>).
// Read the card, talk it through with the user, annotate it (gain, project, dates, tags, a one-line
// note) and decide it; the app updates live. Every decision can be undone; nothing is deleted.
import { readDaily } from '../../js/daily-rules.js';
import { wouldLoop, live as liveLink } from '../../js/tree-rules.js';
import { buildQueue, priorityReason, proposalText } from '../../js/review.js';
import { parseItemLines } from './checklists.js';

const MAX_NOTES = 6000; // as everywhere notes are taken
const AHEAD = 20; // "Keep Claude ahead": how many cards past the current one get a suggestion drafted (as js/views/fullreview.js)
// New notes for a card's action: plain text with its line breaks; blank means "leave the notes alone".
const taskNotes = (v) => (v === undefined || v === null ? '' : String(v).replace(/\r\n?/g, '\n').replace(/^\s*\n/, '').trimEnd().slice(0, MAX_NOTES));

export function fullReviewTools({ OPEN, localDate, zonedToIso, tool }) {
  // ---------- suggestions: Claude proposes, the user Submits in the app ----------
  const TASK_DECISIONS = ['keep', 'someday', 'done', 'drop', 'skip', 'reading', 'slipbox'];
  const GROUP_DECISIONS = ['accept', 'one_by_one', 'keep_all', 'skip'];
  async function lookups(api, { checklists: needChecklists = false, tree: needTree = false } = {}) {
    const [projects, tags, checklists, goals, treeLinks] = await Promise.all([
      api.q(`projects?${api.u}&status=in.(active,on_hold)&select=id,name`), api.q(`tags?${api.u}&status=neq.dropped&select=id,name,parent_id`),
      needChecklists ? api.q(`checklists?${api.u}&archived_at=is.null&select=id,name,items,reflect`) : [],
      needTree ? api.q(`goals?${api.u}&status=neq.dropped&select=id,title,kind,status`) : [],
      needTree ? api.q(`tree_links?${api.u}&archived_at=is.null&select=id,node_kind,node_id,requires_kind,requires_id,state,archived_at`) : [],
    ]);
    const label = (g) => { const p = g.parent_id && tags.find((x) => x.id === g.parent_id); return p ? `${p.name} : ${g.name}` : g.name; };
    return { projects, tags, checklists, goals, treeLinks, label };
  }
  // What a suggestion adds to the tech tree: { add: [{ title, kind, project? }], links: [{ node, requires }] }, names
  // in links being either something in add or a goal or project that is already there. → the stored shape:
  // { items: [{ kind, title, project_id?, project_name?, exists? }], links: [{ node: i, requires: j }] }.
  const TREE_KINDS = ['destination', 'milestone', 'goal', 'card'];
  function treeFrom(t, L) {
    if (typeof t === 'string') { try { t = JSON.parse(t); } catch (e) { throw new Error('tree is an object: {add: [{title, kind}], links: [{node, requires}]}'); } } // some clients send objects as text
    if (!t || typeof t !== 'object') throw new Error('tree is an object: {add: [{title, kind}], links: [{node, requires}]}');
    const add = Array.isArray(t.add) ? t.add : [];
    const links = Array.isArray(t.links) ? t.links : [];
    if (!add.length && !links.length) throw new Error('tree needs add: [{title, kind}] and / or links: [{node, requires}]');
    if (add.length + links.length > 60) throw new Error('A suggestion adds up to 40 items to the tech tree: split it across cards.');
    const same = (x, y) => String(x).trim().toLowerCase() === String(y).trim().toLowerCase();
    const goalBy = (title) => L.goals.find((g) => g.id === title) || L.goals.find((g) => same(g.title, title));
    const projectBy = (name) => L.projects.find((p) => p.id === name) || L.projects.find((p) => same(p.name, name));
    const items = [];
    add.forEach((x) => {
      const title = String((x && x.title) || '').trim();
      const kind = x && x.kind;
      if (!title) throw new Error('Each item in tree.add needs a title.');
      if (!TREE_KINDS.includes(kind)) throw new Error(`“${title}”: kind is one of ${TREE_KINDS.join(', ')} (a project is made with create_project, then linked by name).`);
      if (items.some((i) => same(i.title, title))) throw new Error(`“${title}” is in tree.add twice.`);
      if (kind === 'card') {
        const p = x.project ? projectBy(x.project) : null;
        if (x.project && !p) throw new Error(`“${title}”: no project called “${x.project}”.`);
        items.push({ kind, title: title.slice(0, 1000), ...(p ? { project_id: p.id, project_name: p.name } : {}) });
      } else {
        const g = goalBy(title); // already there: build on it, don't make a second one
        items.push(g ? { kind: g.kind || 'goal', title: g.title, exists: { kind: 'goal', id: g.id } } : { kind, title: title.slice(0, 300) });
      }
    });
    const place = (name, side) => {
      const n = String(name || '').trim();
      if (!n) throw new Error(`A link needs ${side === 'node' ? 'node (what gets unlocked)' : 'requires (what it needs)'}.`);
      let i = items.findIndex((x) => same(x.title, n));
      if (i >= 0) return i;
      const g = goalBy(n); const p = projectBy(n);
      if (g && p) throw new Error(`“${n}” is both a goal and a project. Add one of them to tree.add by its exact kind, or rename one.`);
      if (!g && !p) throw new Error(`“${n}” is not in tree.add and is no goal or project of theirs. Add it to tree.add, or use list_projects / list_horizons for the exact name.`);
      items.push(g ? { kind: g.kind || 'goal', title: g.title, exists: { kind: 'goal', id: g.id } } : { kind: 'project', title: p.name, exists: { kind: 'project', id: p.id } });
      return items.length - 1;
    };
    const keyAt = (i) => (items[i].exists ? `${items[i].exists.kind}:${items[i].exists.id}` : `new:${i}`);
    const soFar = L.treeLinks.filter(liveLink).map((l) => ({ ...l }));
    const out = [];
    links.forEach((l) => {
      const a = place(l.node, 'node'); const b = place(l.requires, 'requires');
      if (items[a].kind === 'card') throw new Error(`“${items[a].title}” is a card: only a goal or a project can be locked by the tree (cards wait on cards with update_task waits_for).`);
      if (items[a].kind === 'project' && items[b].kind === 'card' && items[b].project_id === items[a].exists.id) throw new Error(`“${items[a].title}” can’t require a card inside itself.`);
      if (out.some((x) => x.node === a && x.requires === b)) return;
      const [nk, ni] = keyAt(a).split(':'); const [rk, ri] = keyAt(b).split(':');
      if (wouldLoop(soFar, keyAt(a), keyAt(b))) throw new Error(a === b ? `“${items[a].title}” can’t require itself.` : `That would make a loop: “${items[b].title}” already rests on “${items[a].title}”.`);
      soFar.push({ node_kind: nk, node_id: ni, requires_kind: rk, requires_id: ri, state: 'accepted', archived_at: null });
      out.push({ node: a, requires: b });
    });
    if (items.length > 40) throw new Error('A suggestion adds up to 40 items to the tech tree: split it across cards.');
    return { items, links: out };
  }
  // One suggestion from tool arguments; throws on anything that doesn't resolve (nothing is saved then).
  function suggestionFrom(api, a, kind, L) {
    const s = { at: new Date().toISOString() };
    const ok = kind === 'group' ? GROUP_DECISIONS : TASK_DECISIONS;
    if (!ok.includes(a.decision)) throw new Error(`decision must be one of: ${ok.join(', ')}`);
    s.decision = a.decision;
    if (a.note !== undefined) s.note = String(a.note).slice(0, 1000);
    if (a.ahead) s.ahead = true;
    if (kind === 'group') {
      if (a.proposal) s.proposal = { op: a.proposal.op || 'someday', ...(a.proposal.keep !== undefined ? { keep: a.proposal.keep } : {}) };
      return s;
    }
    if (a.title !== undefined && String(a.title).trim()) s.title = String(a.title).trim().slice(0, 1000);
    if (taskNotes(a.task_notes)) s.task_notes = taskNotes(a.task_notes); // replaces the action's notes on Submit
    if (a.gain !== undefined) { s.gain = String(a.gain || '').trim().slice(0, 500); if (a.gain_suggested) s.gain_suggested = true; }
    if (a.project !== undefined) {
      if (a.project === null || a.project === '') s.project_id = null;
      else {
        const r = String(a.project).trim().toLowerCase();
        const p = L.projects.find((x) => x.id === a.project) || L.projects.find((x) => x.name.toLowerCase() === r);
        if (!p) throw new Error(`No active project called "${a.project}". Create it first (create_project) or pick another.`);
        s.project_id = p.id; s.project_name = p.name;
      }
    }
    const hours = { planned: api.hours.planned, due: api.hours.due, defer: api.hours.defer };
    ['planned', 'due', 'defer'].forEach((k) => { if (a[k] !== undefined) s[k] = a[k] === null || a[k] === '' ? null : zonedToIso(a[k], hours[k], api.tz); });
    if (a.flagged !== undefined) s.flagged = !!a.flagged;
    if (a.tree !== undefined && a.tree !== null) s.tree = treeFrom(a.tree, L); // additions to the tech tree, made on Submit (keep / someday)
    if (a.daily !== undefined && a.daily !== null) s.daily = readDaily(a.daily); // a daily checkbox on Submit (keep only); its repeat and dates go
    if (a.steps !== undefined) { // break it down: added under the action on Submit (keep / someday only); a step can carry its own steps
      let count = 0;
      const norm = (list, depth) => (Array.isArray(list) ? list : []).map((x) => {
        const o = x && typeof x === 'object' ? x : { title: x };
        const title = String(o.title || '').trim().slice(0, 500);
        if (!title) return null;
        count += 1;
        const out = { title };
        if (o.in_order !== undefined) out.in_order = !!o.in_order;
        if (Array.isArray(o.steps) && o.steps.length) {
          if (depth >= 3) throw new Error('Steps can nest three levels under the card (four levels in all).');
          const kids = norm(o.steps, depth + 1);
          if (kids.length) out.steps = kids;
        }
        return Object.keys(out).length === 1 ? title : out; // a plain title stays a string
      }).filter(Boolean);
      const steps = norm(a.steps, 1);
      if (count > 80) throw new Error('At most 80 steps in one suggestion.');
      if (steps.length && !['keep', 'someday'].includes(a.decision)) throw new Error('Steps go with keep or someday.');
      if (steps.length) s.steps = steps;
    }
    if (a.steps_in_order !== undefined) s.steps_in_order = !!a.steps_in_order;
    if (a.mac_folder !== undefined) s.folder = String(a.mac_folder || '').trim().slice(0, 500) || null;
    if (a.checklist !== undefined && a.checklist !== null) { // attached on Submit (keep / someday only)
      if (!['keep', 'someday'].includes(a.decision)) throw new Error('A checklist goes with keep or someday.');
      if (typeof a.checklist === 'string') {
        const r = a.checklist.trim().toLowerCase();
        const c = L.checklists.find((x) => x.id === a.checklist) || L.checklists.find((x) => x.name.toLowerCase() === r);
        if (!c) throw new Error(`No checklist called “${a.checklist}”. Pass {name, items} to make a new one, or use list_checklists.`);
        s.checklist = { id: c.id, name: c.name, count: (c.items || []).length, reflect: !!c.reflect };
      } else {
        const name = String(a.checklist.name || '').trim().slice(0, 200);
        const items = parseItemLines(Array.isArray(a.checklist.items) ? a.checklist.items : []);
        if (!name) throw new Error('checklist.name is required');
        if (!items.length) throw new Error('checklist.items needs at least one line');
        s.checklist = { name, items, reflect: !!a.checklist.reflect, complete_action: a.checklist.complete_action === undefined ? true : !!a.checklist.complete_action };
      }
    }
    const find = (name) => { const n = String(name).trim().toLowerCase(); return L.tags.find((g) => g.id === name) || L.tags.find((g) => L.label(g).toLowerCase() === n) || L.tags.find((g) => g.name.toLowerCase() === n); };
    if (Array.isArray(a.add_tags) && a.add_tags.length) {
      s.add_tag_ids = []; s.add_tag_names = []; s.add_tag_labels = [];
      a.add_tags.forEach((n) => { const g = find(n); if (g) { s.add_tag_ids.push(g.id); s.add_tag_labels.push(L.label(g)); } else { s.add_tag_names.push(String(n).trim().slice(0, 100)); s.add_tag_labels.push(`${String(n).trim()} (new)`); } });
    }
    if (Array.isArray(a.remove_tags) && a.remove_tags.length) {
      s.remove_tag_ids = []; s.remove_tag_labels = [];
      a.remove_tags.forEach((n) => { const g = find(n); if (g) { s.remove_tag_ids.push(g.id); s.remove_tag_labels.push(L.label(g)); } });
    }
    return s;
  }

  const touch = (api, id, extra = {}) => api.q(`review_sessions?${api.u}&id=eq.${id}`, { method: 'PATCH', body: { agent_seen_at: new Date().toISOString(), ...extra } });
  const findSession = async (api, sid) => {
    const rows = await api.q(`review_sessions?${api.u}&order=created_at.desc&limit=20&select=*`);
    const s = sid ? rows.find((r) => r.id === sid) : rows.find((r) => r.status === 'active');
    if (!s) throw new Error(sid ? 'No such review session.' : 'No review in progress. Start one with action "start".');
    return s;
  };
  // The queue without the heavy group lists (a group can hold thousands of ids); the current card in full.
  // Cloudflare allows 50 outgoing requests per call, so every read here is one query.
  const items = (api, sid) => api.q(`review_items?${api.u}&session_id=eq.${sid}&status=neq.void&order=sort.asc&select=id,sort,status,kind,task_id,priority,reviewed_at,label:grp->>label`);
  const itemFull = async (api, id) => (id ? (await api.q(`review_items?${api.u}&id=eq.${id}&select=*`))[0] || null : null);

  async function cardOut(api, it) {
    if (!it) return null;
    const base = { item_id: it.id, kind: it.kind, status: it.status, note: it.note || undefined, suggestion: it.suggestion && !it.suggestion.applied_at ? it.suggestion : undefined };
    if (it.kind === 'group') {
      const g = it.grp || {};
      const ids = g.task_ids || [];
      const rows = ids.length ? await api.q(`tasks?${api.u}&id=in.(${ids.slice(0, 12).map((x) => `"${x}"`).join(',')})&select=id,title`) : [];
      return { ...base, group: { label: g.label, count: ids.length, sample: rows.map((r) => r.title), proposal: g.proposal || { op: 'someday' }, proposal_text: proposalText(g.proposal, ids.length) },
        decisions: 'accept (apply the proposal) | one_by_one (expand into single cards) | keep_all | skip' };
    }
    const [raw] = await api.q(`tasks?${api.u}&id=eq.${it.task_id}&select=*`);
    if (!raw) return { ...base, task: null };
    const [links, projects] = await Promise.all([
      api.q(`task_tags?${api.u}&task_id=eq.${raw.id}&select=tag_id`),
      raw.project_id ? api.q(`projects?${api.u}&id=eq.${raw.project_id}&select=id,name,flagged,purpose`) : [],
    ]);
    const tags = links.length ? await api.q(`tags?${api.u}&id=in.(${links.map((l) => `"${l.tag_id}"`).join(',')})&select=name`) : [];
    const p = projects[0] || null;
    const day = (iso) => (iso ? localDate(iso, api.tz) : undefined);
    return { ...base, priority: it.priority || undefined, why_first: it.priority ? priorityReason(raw, p) || undefined : undefined,
      task: { id: raw.id, title: raw.title, notes: raw.notes ? String(raw.notes).slice(0, MAX_NOTES) : undefined, project: p ? p.name : undefined, project_gain: p && p.purpose ? p.purpose : undefined,
        tags: tags.map((g) => g.name), gain: raw.gain || undefined, gain_suggested: raw.gain_by === 'agent' || undefined, flagged: raw.flagged || undefined,
        due: day(raw.due_at), planned: day(raw.planned_at), defer: day(raw.defer_at), in_inbox: raw.in_inbox || undefined, repeating: raw.repeat_rule ? true : undefined,
        added: day(raw.created_at), age_days: raw.created_at ? Math.floor((Date.now() - Date.parse(raw.created_at)) / 86400000) : undefined },
      decisions: 'keep | someday | done | drop | skip | reading | slipbox' };
  }
  // Keep Claude ahead (review_sessions.draft_ahead): which of the next cards have no suggestion waiting.
  // One read, and only while it is on, so a quiet check stays cheap.
  async function aheadOut(api, s, next) {
    if (!s.draft_ahead) return { on: false };
    if (s.status !== 'active' || !next.length) return { on: true, cards: 0, drafted: 0, missing: [], next: s.status === 'active' ? 'No cards after this one: nothing to draft.' : 'The review is finished: stop checking.' };
    const rows = await api.q(`review_items?${api.u}&id=in.(${next.map((x) => `"${x.id}"`).join(',')})&select=id,suggestion`);
    const has = new Set(rows.filter((r) => r.suggestion && !r.suggestion.applied_at).map((r) => r.id));
    const missing = next.filter((x) => !has.has(x.id)).map((x) => x.id);
    return { on: true, cards: next.length, drafted: next.length - missing.length, missing,
      next: missing.length
        ? `Draft these now: action "upcoming" (count ${AHEAD}) gives the cards in full, then "suggest" with items [{item_id, decision, …}] for the ones in missing. Then check status again in about 30 seconds, for as long as on is true.`
        : 'Every one of the next cards has a suggestion waiting. Check status again in about 30 seconds; stop when on is false or the review is finished.' };
  }
  async function stateOut(api, s, list) {
    const live = list.filter((x) => x.status !== 'void');
    const cur = live.find((x) => x.id === s.current_item);
    const later = cur ? live.filter((x) => x.status === 'pending' && x.sort > cur.sort) : [];
    const after = later.slice(0, 3);
    const singles = after.filter((x) => x.kind === 'task');
    const titles = singles.length ? await api.q(`tasks?${api.u}&id=in.(${singles.map((x) => `"${x.task_id}"`).join(',')})&select=id,title`) : [];
    const upcoming = after.map((x) => (x.kind === 'group' ? `group: ${x.label || 'similar actions'}` : (titles.find((r) => r.id === x.task_id) || {}).title)).filter(Boolean);
    return {
      session_id: s.id, title: s.title, status: s.status, app_link: `https://todotooling.com/#full/${s.id}`,
      progress: { position: cur ? live.filter((x) => x.sort <= cur.sort).length : live.length, total: live.length, reviewed: live.filter((x) => x.status === 'reviewed').length, skipped: live.filter((x) => x.status === 'skipped').length },
      current: await cardOut(api, cur ? await itemFull(api, cur.id) : null), upcoming,
      draft_ahead: await aheadOut(api, s, later.slice(0, AHEAD)),
    };
  }

  return [{
    name: 'full_review',
    description: `Full Review: go through the user's actions one card at a time WITH them while they watch the same card in the app.
Default way of working: SUGGEST, the user approves. When the user tells you what to do with a card, turn it into a suggestion ("suggest": decision plus any title/notes/gain/project/dates/flag/tags and a one-line note). It appears on the card in the app as "Suggested by Claude" with Submit / Edit / Dismiss; nothing changes until they Submit. When the user says "submit" (e.g. "submit, next card"), call "submit": it presses Submit for them, exactly like the app's button, and moves to the next card. (If they say "submitted", they pressed it themselves: just check status.) Only use "annotate" + "decide" (which apply immediately) when the user says to just do it.
Big actions: when the user describes the parts ("cut the spot, run power, then…"), put them in the suggestion as steps (in order if they said so) rather than applying break_down; Submit adds them.
Notes: task_notes in a suggestion REPLACES the action's whole notes on Submit (Undo puts the old ones back), so write the full text you want kept, as plain text with line breaks, ready to copy and paste (no Markdown). Use it to tidy an import whose text was split across the title and the notes: a short title, and the whole text in task_notes. "note" is something else: your one-line reason, shown on the card.
Draft ahead: call "upcoming" and "suggest" with items [...] for the next few cards from the user's patterns; these show as "drafted ahead" so the user can Submit quickly and only talk to you when they disagree. Never suggest drop/done for something the user hasn't clearly let go of; the gain should be the user's words (set gain_suggested when it's yours).
Keep ahead: the user can tick "Keep Claude ahead" in the app (or ask you to: action "ahead"). status then carries draft_ahead {on, cards, drafted, missing}. While on is true, keep a suggestion waiting on each of the next ${AHEAD} cards without being asked, so every card already has one when they reach it: draft the ones in missing (upcoming, then suggest with items), then look again about every 30 seconds for as long as it is on, if your client lets you wait or loop (Claude Code: /loop, or a scheduled wake-up); if it doesn't, top up every time the user speaks. A check with nothing missing is one status call. The card they are on is theirs: don't draft on it unless they ask (they may have just dismissed your draft). Stop when on is false or the review is finished.
actions:
  start {import_id | project | all:true, min_age_days?, title?} → a new session (give the user app_link)
  status {session_id?} (default) → progress, the current card (with any pending suggestion), the next few titles
  suggest {decision, title?, tree? ({add: [{title, kind: destination | milestone | goal | card, project? (a card's project)}], links: [{node, requires}]}: additions to the tech tree, shown on the card as a preview and made on Submit with keep; names in links are items in add or goals / projects already there, which are reused, never duplicated; a destination you add with no link has "no path yet", which is honest when the first step isn't known), daily? ("must" = have to, every day | "should" = should, most days, or {tier, weekdays: [0-6]}: with keep, the action becomes a daily checkbox that starts fresh each day and its repeat and dates are cleared; for habits and daily obligations that came in as repeating actions. "weekly": a weekly check instead, ticked once per Weekly Review and never in Today; for questions and routines that came in as weekly repeating actions. "quarterly": a quarterly check, ticked once per quarterly check-in in Horizons; for the questions of a quarterly review), task_notes? (the action's new notes, replacing the old; ≤6000 characters; omitted or null = unchanged), gain?, gain_suggested?, project?, planned?|due?|defer? (YYYY-MM-DD or null), flagged?, add_tags?, remove_tags?, steps? (titles, first to last: break it down; a step can be {title, steps: [...], in_order?} to nest), steps_in_order?, checklist? ({name, items: [lines; "# Section" starts a section], reflect?, complete_action?} to make one, or an existing checklist's name: attached on Submit; use it for routines the card repeats), mac_folder? (a folder on their Mac for its files; the card gets a 📂 button), proposal? (group), note?, item_id? (default current)} or {items: [{item_id, …}]}
  submit {item_id? (default current)} → apply the pending suggestion as the app's Submit does (only when the user says "submit"), then the next card
  upcoming {count? ≤20} → the next cards in full, for drafting ahead
  ahead {on: true | false} → tick or untick "Keep Claude ahead" for this review (only when the user asks), then the status
  add {title, gain?, notes?} → a new idea the user has mid-review: captured to the Inbox and added as the last card
  annotate {…same fields…} / decide {decision, note?} → apply now (only when asked to just do it)
  prioritize {task_ids (up to 20)} · goto {item_id | "next" | "previous"} · undo {item_id?} · list
Decisions: action cards keep|someday|done|drop|skip|reading (→ reading list, up next)|slipbox (an idea, not an action → fleeting note); group cards accept|one_by_one|keep_all|skip.`,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'status', 'suggest', 'submit', 'upcoming', 'ahead', 'add', 'annotate', 'decide', 'prioritize', 'goto', 'undo', 'list'], default: 'status' },
        on: { type: 'boolean', description: 'ahead: true to keep the next cards drafted, false to stop' },
        notes: { type: 'string', description: 'add: notes for the new idea' },
        items: { type: 'array', description: 'suggest: several cards at once, each {item_id, decision, title?, task_notes?, gain?, project?, planned?, due?, defer?, flagged?, add_tags?, remove_tags?, steps?, steps_in_order?, proposal?, note?}', items: { type: 'object' } },
        ahead: { type: 'boolean', description: 'suggest: drafted before talking it through (shown as “drafted ahead”)' },
        count: { type: 'integer', description: 'upcoming: how many cards (max 20)' },
        session_id: { type: 'string' },
        import_id: { type: 'string' }, project: { type: 'string', description: 'Project name or id (start: review that project; annotate: move the action there)' },
        all: { type: 'boolean' }, min_age_days: { type: 'integer' }, title: { type: 'string' },
        task_notes: { type: ['string', 'null'], maxLength: MAX_NOTES, description: 'suggest / annotate: new notes for the card\'s action, replacing its current notes (on Submit for suggest). Plain text, line breaks kept, at most 6000 characters; omitted, null or blank leaves the notes unchanged. Not the one-line reason (note), and not add\'s notes.' },
        gain: { type: 'string' }, gain_suggested: { type: 'boolean' },
        tags: { type: 'array', items: { type: 'string' } }, add_tags: { type: 'array', items: { type: 'string' } }, remove_tags: { type: 'array', items: { type: 'string' } },
        tree: { type: ['object', 'null'], description: 'suggest: additions to the tech tree, made on Submit (keep / someday) and taken back by Undo', properties: { add: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, kind: { type: 'string', enum: ['destination', 'milestone', 'goal', 'card'] }, project: { type: 'string', description: 'card: the project it goes in (name or id); none = the Inbox' } }, required: ['title', 'kind'] } }, links: { type: 'array', items: { type: 'object', properties: { node: { type: 'string', description: 'what gets unlocked: a goal or project' }, requires: { type: 'string', description: 'what it needs: a goal, project or card' } }, required: ['node', 'requires'] } } } },
        daily: { type: ['string', 'object', 'null'], description: 'suggest: make the action a daily checkbox on Submit (keep): "must" or "should", or {tier, weekdays: [0-6]}; "weekly" makes it a weekly check (the Weekly Review, not Today), "quarterly" a quarterly check (the quarterly check-in in Horizons)' },
        steps: { type: 'array', items: { type: ['string', 'object'], properties: { title: { type: 'string' }, steps: { type: 'array' }, in_order: { type: 'boolean' } } }, description: 'suggest: break the action down: step titles, first to last (added on Submit). A step can be {title, steps: [...], in_order?} to carry its own steps, three levels under the card.' },
        checklist: { type: ['object', 'string', 'null'], description: 'suggest: a checklist for the action, attached on Submit (keep / someday). {name, items: [lines, "# Section" starts a section], reflect?: a line per item each run, complete_action?: last tick completes the action (default true)} makes a new one; a string is an existing checklist’s name or id.', properties: { name: { type: 'string' }, items: { type: 'array', items: { type: 'string' } }, reflect: { type: 'boolean' }, complete_action: { type: 'boolean' } } },
        mac_folder: { type: ['string', 'null'], description: 'suggest: a folder on the user\'s Mac for the action\'s files (e.g. ~/_SYNC/MAGA/_Todo/<action>); null to clear' }, steps_in_order: { type: 'boolean', description: 'suggest: only the first open step is available' },
        planned: { type: ['string', 'null'] }, due: { type: ['string', 'null'] }, defer: { type: ['string', 'null'] },
        flagged: { type: 'boolean' }, note: { type: 'string', description: 'One line: why you changed or decided it, shown on the card' },
        proposal: { type: 'object', properties: { op: { type: 'string', enum: ['someday', 'drop', 'park', 'keep_newest'] }, keep: { type: 'integer' } } },
        decision: { type: 'string', enum: ['keep', 'someday', 'done', 'drop', 'skip', 'reading', 'slipbox', 'accept', 'one_by_one', 'keep_all'] },
        task_ids: { type: 'array', items: { type: 'string' } },
        item_id: { type: 'string' },
      },
    },
    async run(api, a) {
      const action = a.action || 'status';
      if (action === 'list') {
        const rows = await api.q(`review_sessions?${api.u}&order=created_at.desc&limit=20&select=id,title,status,created_at,finished_at`);
        return rows.map((r) => ({ id: r.id, title: r.title, status: r.status, started: localDate(r.created_at, api.tz), app_link: `https://todotooling.com/#full/${r.id}` }));
      }
      if (action === 'start') {
        const scope = a.import_id ? { import_id: a.import_id } : a.project ? { project_id: await api.resolveProject(a.project) } : a.all ? { all: true } : null;
        if (!scope) throw new Error('start needs import_id, project or all: true');
        if (a.min_age_days) scope.min_age_days = a.min_age_days;
        const [tasks, projects, tags] = await Promise.all([
          api.q(`tasks?${api.u}&${OPEN}&select=id,title,notes,project_id,parent_id,import_id,flagged,due_at,planned_at,gain,in_inbox,created_at,updated_at,completed_at,dropped_at`),
          api.q(`projects?${api.u}&select=id,name,flagged,status`), api.q(`tags?${api.u}&select=id,name,parent_id`),
        ]);
        // Only the Someday links matter here (already-parked actions aren't reviewed): one query, not thousands of rows.
        const someday = tags.filter((g) => !g.parent_id && /^someday/i.test(g.name)).map((g) => g.id);
        const taskTags = someday.length ? await api.q(`task_tags?${api.u}&tag_id=in.(${someday.map((x) => `"${x}"`).join(',')})&select=task_id,tag_id`) : [];
        const queue = buildQueue({ tasks, projects, tags, taskTags, scope });
        if (!queue.length) throw new Error('Nothing to review there: every open action is already sorted.');
        const [s] = await api.q('review_sessions', { method: 'POST', prefer: 'return=representation', body: { user_id: api.userId, title: a.title || 'Full Review', scope, agent_seen_at: new Date().toISOString() } });
        for (let i = 0; i < queue.length; i += 500) {
          await api.q('review_items', { method: 'POST', body: queue.slice(i, i + 500).map((x) => ({ session_id: s.id, user_id: api.userId, sort: x.sort, kind: x.kind, task_id: x.task_id || null, grp: x.grp || null, priority: !!x.priority })) });
        }
        const [first] = await api.q(`review_items?${api.u}&session_id=eq.${s.id}&order=sort.asc&limit=1&select=id`);
        await api.q(`review_sessions?${api.u}&id=eq.${s.id}`, { method: 'PATCH', body: { current_item: first.id } });
        const out = await stateOut(api, { ...s, current_item: first.id }, await items(api, s.id));
        return { ...out, queue: { cards: queue.length, first_because_important: queue.filter((x) => x.priority).length, groups: queue.filter((x) => x.kind === 'group').length },
          next: 'Give the user app_link to open in the app, then work through the current card together.' };
      }
      const s = await findSession(api, a.session_id);
      if (action !== 'status') await touch(api, s.id); // any call is a check-in: the app shows Claude following along
      let list = await items(api, s.id);
      const cur = await itemFull(api, (list.find((x) => x.id === s.current_item) || {}).id);
      if (action === 'status') { await touch(api, s.id); return stateOut(api, s, list); }
      if (action === 'ahead') {
        // The app's "Keep Claude ahead" box, set for the user: the same switch, seen live in the app.
        if (typeof a.on !== 'boolean') throw new Error('ahead needs on: true or false');
        await touch(api, s.id, { draft_ahead: a.on });
        return stateOut(api, { ...s, draft_ahead: a.on }, list);
      }
      if (action === 'add') {
        // A new idea during the review: captured to the Inbox (with its gain) and added as the last card.
        if (!a.title || !String(a.title).trim()) throw new Error('title is required');
        const made = await tool('capture').run(api, { title: String(a.title).trim(), notes: a.notes || '', ...(a.gain ? { gain: a.gain, gain_suggested: !!a.gain_suggested } : {}) });
        const lastSort = list.reduce((m, x) => Math.max(m, x.sort), 0);
        const [row] = await api.q('review_items', { method: 'POST', prefer: 'return=representation', body: { session_id: s.id, user_id: api.userId, sort: Math.floor(lastSort + 1), kind: 'task', task_id: made.id, priority: false } });
        const reopen = s.status === 'done' || !s.current_item;
        await touch(api, s.id, reopen ? { current_item: row.id, status: 'active', finished_at: null } : {});
        return { added: { item_id: row.id, task_id: made.id, title: made.title }, card: list.filter((x) => x.status !== 'void').length + 1, fits: made.fits,
          next: 'It is in the Inbox and at the end of this review; carry on with the current card.' };
      }
      if (action === 'suggest') {
        // One card (item_id, default the current one) or several: items [{item_id, decision, …}].
        const wanted = Array.isArray(a.items) && a.items.length ? a.items.slice(0, 25) : [{ ...a, item_id: a.item_id || (cur && cur.id) }];
        const L = await lookups(api, { checklists: wanted.some((w) => typeof w.checklist === 'string'), tree: wanted.some((w) => w.tree) });
        const rows = await api.q(`review_items?${api.u}&session_id=eq.${s.id}&id=in.(${wanted.map((w) => `"${w.item_id}"`).join(',')})&select=id,kind,status`);
        const planned = wanted.map((w) => {
          const row = rows.find((r) => r.id === w.item_id);
          if (!row) throw new Error(`No card ${w.item_id} in this review.`);
          if (row.status !== 'pending') throw new Error(`Card ${w.item_id} is already decided.`);
          return { id: row.id, s: suggestionFrom(api, { ...w, ahead: w.ahead ?? (cur && w.item_id !== cur.id) }, row.kind, L) };
        });
        for (const p of planned) await api.q(`review_items?${api.u}&id=eq.${p.id}`, { method: 'PATCH', body: { suggestion: p.s } });
        await touch(api, s.id, { agent_status: '' });
        return { suggested: planned.length, items: planned.map((p) => ({ item_id: p.id, decision: p.s.decision, ahead: p.s.ahead || undefined })),
          next: 'The user sees each suggestion on its card in the app and Submits (or edits / dismisses) it there. Check status to see what they decided.' };
      }
      if (action === 'submit') {
        // The app's Submit button, pressed for the user: the same database function applies the suggestion
        // (title, notes, gain, project, dates, flag, tags, steps, folder) and decides the card. Undo works as usual.
        const it = a.item_id ? await itemFull(api, a.item_id) : cur;
        if (!it || it.session_id !== s.id) throw new Error('No such card in this review.');
        if (it.status !== 'pending') throw new Error('That card is already decided.');
        if (!it.suggestion || it.suggestion.applied_at) throw new Error('No suggestion on that card to submit. Suggest first (action "suggest"), then submit.');
        await api.q('rpc/review_apply', { method: 'POST', body: { item: it.id, owner: api.userId } });
        await touch(api, s.id, { agent_status: '' });
        const [s2] = await api.q(`review_sessions?${api.u}&id=eq.${s.id}&select=*`);
        return { submitted: { item_id: it.id, decision: it.suggestion.decision }, ...(await stateOut(api, s2 || s, await items(api, s.id))) };
      }
      if (action === 'upcoming') {
        // The next few cards in one go (for drafting suggestions ahead): 4–5 queries, whatever the count.
        const n = Math.min(AHEAD, Math.max(1, a.count || 5));
        const next = list.filter((x) => x.status === 'pending' && (!cur || x.sort > cur.sort)).slice(0, n);
        if (!next.length) return { cards: [] };
        const full = await api.q(`review_items?${api.u}&id=in.(${next.map((x) => `"${x.id}"`).join(',')})&select=*`);
        const taskIds = full.filter((x) => x.kind === 'task').map((x) => x.task_id);
        const tasks = taskIds.length ? await api.q(`tasks?${api.u}&id=in.(${taskIds.map((x) => `"${x}"`).join(',')})&select=*`) : [];
        const [links, projects] = await Promise.all([
          taskIds.length ? api.q(`task_tags?${api.u}&task_id=in.(${taskIds.map((x) => `"${x}"`).join(',')})&select=task_id,tag_id`) : [],
          api.q(`projects?${api.u}&id=in.(${[...new Set(tasks.map((t) => t.project_id).filter(Boolean))].map((x) => `"${x}"`).join(',') || '"00000000-0000-0000-0000-000000000000"'})&select=id,name,flagged,purpose`),
        ]);
        const tagRows = links.length ? await api.q(`tags?${api.u}&id=in.(${[...new Set(links.map((l) => l.tag_id))].map((x) => `"${x}"`).join(',')})&select=id,name`) : [];
        const day = (iso) => (iso ? localDate(iso, api.tz) : undefined);
        const cards = next.map((x) => {
          const it = full.find((f) => f.id === x.id) || x;
          const sug = it.suggestion && !it.suggestion.applied_at ? it.suggestion : undefined;
          if (it.kind === 'group') { const g = it.grp || {}; return { item_id: it.id, kind: 'group', label: g.label, count: (g.task_ids || []).length, proposal: g.proposal || { op: 'someday' }, suggestion: sug }; }
          const t = tasks.find((r) => r.id === it.task_id);
          if (!t) return { item_id: it.id, kind: 'task', task: null };
          const p = projects.find((r) => r.id === t.project_id);
          return { item_id: it.id, kind: 'task', priority: it.priority || undefined, why_first: it.priority ? priorityReason(t, p) || undefined : undefined, suggestion: sug,
            task: { id: t.id, title: t.title, notes: t.notes ? String(t.notes).slice(0, 600) : undefined, project: p ? p.name : undefined, tags: links.filter((l) => l.task_id === t.id).map((l) => (tagRows.find((g) => g.id === l.tag_id) || {}).name).filter(Boolean),
              gain: t.gain || undefined, flagged: t.flagged || undefined, due: day(t.due_at), planned: day(t.planned_at), added: day(t.created_at) } };
        });
        await touch(api, s.id);
        return { cards, next: 'Draft suggestions for these with action "suggest" and items [{item_id, decision, …}] (marked "drafted ahead" in the app).' };
      }
      if (action === 'annotate') {
        if (!cur) throw new Error('No current card.');
        const changed = { ...(cur.changed || {}) };
        const stamp = new Date().toISOString();
        const patch = {};
        if (cur.kind === 'task') {
          const f = {};
          ['title', 'gain', 'gain_suggested', 'tags', 'add_tags', 'remove_tags', 'planned', 'due', 'defer', 'flagged'].forEach((k) => { if (a[k] !== undefined) f[k] = a[k]; });
          if (a.project !== undefined) f.project = a.project;
          if (taskNotes(a.task_notes)) f.notes = taskNotes(a.task_notes);
          if (Object.keys(f).length) {
            await touch(api, s.id, { agent_status: 'editing' });
            await tool('update_task').run(api, { id: cur.task_id, ...f });
            if (f.title !== undefined) changed.title = stamp;
            if (f.notes !== undefined) changed.notes = stamp;
            if (f.gain !== undefined) changed.gain = stamp;
            if (f.project !== undefined) changed.project = stamp;
            if (['planned', 'due', 'defer'].some((k) => f[k] !== undefined)) changed.dates = stamp;
            if (['tags', 'add_tags', 'remove_tags'].some((k) => f[k] !== undefined)) changed.tags = stamp;
            if (f.flagged !== undefined) changed.flagged = stamp;
          }
        } else if (a.proposal) {
          patch.grp = { ...(cur.grp || {}), proposal: { op: a.proposal.op || 'someday', ...(a.proposal.keep !== undefined ? { keep: a.proposal.keep } : {}) } };
          changed.proposal = stamp;
        }
        await api.q(`review_items?${api.u}&id=eq.${cur.id}`, { method: 'PATCH', body: { ...patch, changed, ...(a.note !== undefined ? { note: String(a.note).slice(0, 1000) } : {}) } });
        await touch(api, s.id, { agent_status: '' });
        list = await items(api, s.id);
        return stateOut(api, s, list);
      }
      if (action === 'decide') {
        if (!cur) throw new Error('No current card (the review is finished).');
        if (!a.decision) throw new Error('decision is required');
        await api.q('rpc/review_decide', { method: 'POST', body: { item: cur.id, decision: a.decision, by: 'agent', note: a.note ?? null, owner: api.userId } });
        const [s2] = await api.q(`review_sessions?${api.u}&id=eq.${s.id}&select=*`);
        return { decided: { item_id: cur.id, decision: a.decision }, ...(await stateOut(api, s2, await items(api, s.id))) };
      }
      if (action === 'undo') {
        const last = a.item_id ? list.find((x) => x.id === a.item_id) : list.filter((x) => x.reviewed_at).sort((x, y) => String(y.reviewed_at).localeCompare(String(x.reviewed_at)))[0];
        if (!last) throw new Error('Nothing to undo.');
        await api.q('rpc/review_undo', { method: 'POST', body: { item: last.id, owner: api.userId } });
        await touch(api, s.id);
        const [s2] = await api.q(`review_sessions?${api.u}&id=eq.${s.id}&select=*`);
        return { undone: last.id, ...(await stateOut(api, s2, await items(api, s.id))) };
      }
      if (action === 'goto') {
        const pending = list.filter((x) => x.status === 'pending');
        const target = a.item_id === 'next' ? pending.find((x) => cur && x.sort > cur.sort)
          : a.item_id === 'previous' ? [...list].reverse().find((x) => cur && x.sort < cur.sort)
          : list.find((x) => x.id === a.item_id);
        if (!target) throw new Error('No such card.');
        await touch(api, s.id, { current_item: target.id });
        return stateOut(api, { ...s, current_item: target.id }, list);
      }
      if (action === 'prioritize') {
        const ids = [...new Set(a.task_ids || [])];
        if (!ids.length) throw new Error('task_ids is required');
        if (ids.length > 20) throw new Error('At most 20 task_ids at a time.');
        // Batched: one write per moved card, one per group touched, one insert for the rest (50 requests a call).
        const base = cur ? cur.sort : 0;
        let groups = null;
        const touched = new Map();
        const fresh = [];
        for (const [i, tid] of ids.entries()) {
          const sort = base + ((i + 1) / (ids.length + 1)) * 0.5; // right after the current card
          const single = list.find((x) => x.kind === 'task' && x.task_id === tid && x.status === 'pending');
          if (single) { await api.q(`review_items?${api.u}&id=eq.${single.id}`, { method: 'PATCH', body: { sort, priority: true } }); continue; }
          if (!groups) groups = await api.q(`review_items?${api.u}&session_id=eq.${s.id}&kind=eq.group&status=eq.pending&select=id,sort,grp`);
          const grp = groups.find((x) => ((x.grp || {}).task_ids || []).includes(tid));
          if (grp) { grp.grp = { ...grp.grp, task_ids: grp.grp.task_ids.filter((x) => x !== tid) }; touched.set(grp.id, grp); }
          fresh.push({ session_id: s.id, user_id: api.userId, sort, kind: 'task', task_id: tid, priority: true });
        }
        for (const grp of touched.values()) await api.q(`review_items?${api.u}&id=eq.${grp.id}`, { method: 'PATCH', body: { grp: grp.grp } });
        if (fresh.length) await api.q('review_items', { method: 'POST', body: fresh });
        await touch(api, s.id);
        return { prioritized: ids.length, ...(await stateOut(api, s, await items(api, s.id))) };
      }
      throw new Error('Unknown action');
    },
  }];
}
