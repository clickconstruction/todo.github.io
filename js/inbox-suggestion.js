// Inbox suggestions: Claude's draft of a clarify decision on an Inbox item (tasks.suggestion), which the user
// presses Submit on in Process Inbox. No imports: the app and the Worker (mcp/src) both use it.
//   {decision, project_id?, project_name?, tag_ids?, tag_labels?, planned?, flagged?, energy?, person_id?,
//    person_name?, follow_up?, name?, first_action?, date?, topic?, category?, title?, source?, type?, note?,
//    by: 'agent', at, applied_at? (Submit), resolved_at? (dismissed, or clarified some other way)}
export const SUGGESTION_DECISIONS = ['next_action', 'done', 'delegate', 'project', 'someday', 'tickler', 'trash', 'reference', 'slipbox', 'reading'];

// The suggestion still waiting on an item, or null.
export const pendingSuggestion = (t) => { const s = t && t.suggestion; return s && s.decision && !s.applied_at && !s.resolved_at ? s : null; };

// The suggestion in words: the first is what it is, the rest are its details. The caller, who knows the
// library (the app's db, the Worker's lookups), passes the names; the ones stored with the suggestion are the fallback.
export function suggestionWords(s, { project = s.project_name, tags = s.tag_labels || [], person = s.person_name, day = (k) => k } = {}) {
  const bits = [];
  switch (s.decision) {
    case 'next_action':
      bits.push('Next action');
      if (project) bits.push(`in ${project}`);
      tags.forEach((x) => bits.push(`@${x}`));
      if (s.planned) bits.push(`planned ${day(s.planned)}`);
      if (s.flagged) bits.push('flagged');
      if (s.energy) bits.push(`${s.energy} energy`);
      break;
    case 'done': bits.push('Do it now', 'under two minutes'); break;
    case 'delegate': bits.push(`Delegate to ${person || 'someone'}`); if (s.follow_up) bits.push(`follow up ${day(s.follow_up)}`); break;
    case 'project': bits.push('Make it a project'); if (s.name) bits.push(s.name); if (s.first_action) bits.push(`first: ${s.first_action}`); break;
    case 'someday': bits.push('Someday/Maybe'); if (s.category) bits.push(s.category); break;
    case 'tickler': bits.push(`Tickler until ${day(s.date)}`); break;
    case 'trash': bits.push('Trash', 'not needed'); break;
    case 'reference': bits.push('Reference'); if (s.topic) bits.push(s.topic); break;
    case 'slipbox': bits.push('Slipbox'); if (s.title) bits.push(s.title); break;
    case 'reading': bits.push('Reading & watching'); if (s.type) bits.push(s.type); break;
    default: bits.push(String(s.decision));
  }
  return bits;
}
export const suggestionLine = (s, names) => suggestionWords(s, names).join(' · ');

// The prompt the app copies: ask Claude to draft a suggestion on every Inbox item that has none.
export const DRAFT_PROMPT = `Draft my Inbox in Todo Tooling. Call list_inbox. For every item in "missing" (no suggestion yet), decide what it is and call clarify_item with mode "suggest", all of them together in "items": next_action (the project and/or tags it belongs to; planned only when a day is clearly meant), done (under two minutes), delegate (person), project (name, first_action), someday (category), tickler (date), trash, reference (topic), slipbox or reading. Give each a short note saying why. Use only projects, tags and people that exist (list_projects, list_tags, list_people). Don't clarify anything yourself: I press Submit in the app. Then tell me how many you drafted and which ones you weren't sure about.`;
