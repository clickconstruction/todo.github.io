// What do I gain? Pure helpers shared by the app and the MCP server: where an idea belongs (from the
// words of its gain and title), the gain an action inherits from its project, and the shorthand for
// writing a gain at capture ("Idea → gain", or a "Gain:" line in an email).
const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'for', 'to', 'of', 'on', 'in', 'at', 'with', 'about', 'call', 'email', 'get', 'send', 'buy', 'my', 'is', 'it',
  'so', 'can', 'will', 'be', 'more', 'less', 'without', 'into', 'from', 'that', 'this', 'we', 'our', 'your', 'i', 'me', 'us', 'they', 'not', 'no', 'have', 'has',
  'make', 'do', 'done', 'able', 'need', 'want', 'new', 'one', 'two', 'all', 'any', 'out', 'up', 'by', 'as', 'than', 'then', 'when', 'what', 'who', 'how', 'why']);
const stem = (w) => (w.length > 4 && w.endsWith('ies') ? `${w.slice(0, -3)}y` : w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
export const words = (s) => [...new Set((String(s || '').toLowerCase().match(/[a-z0-9]{3,}/g) || []).filter((w) => !STOP.has(w)).map(stem))];

// Up to `limit` projects an idea could live in, best first: a project matches on its own words (name,
// purpose, outcome) or through the goal / area it serves. Gain words count double: they say what it's for.
// → [{ project: {id, name}, via: 'project'|'goal'|'area', viaName, word, score }]
export function placeFor({ title = '', gain = '' }, { projects = [], goals = [], areas = [] }, { limit = 2, exclude = null } = {}) {
  const g = words(gain); const t = words(title);
  if (!g.length && !t.length) return [];
  const weight = new Map(t.map((w) => [w, 1]));
  g.forEach((w) => weight.set(w, 2));
  const hit = (text) => { let best = null; let score = 0; words(text).forEach((w) => { const s = weight.get(w) || 0; if (s) { score += s; if (!best || s > (weight.get(best) || 0)) best = w; } }); return { score, word: best }; };
  const liveGoals = new Map(goals.filter((x) => x.status === 'active').map((x) => [x.id, x]));
  const liveAreas = new Map(areas.filter((x) => !x.archived_at).map((x) => [x.id, x]));
  const out = [];
  projects.filter((p) => p.status === 'active' && p.id !== exclude).forEach((p) => {
    const own = hit(`${p.name} ${p.purpose || ''} ${p.outcome || ''}`);
    const goal = p.goal_id && liveGoals.get(p.goal_id);
    const area = p.area_id && liveAreas.get(p.area_id);
    const viaGoal = goal ? hit(`${goal.title} ${goal.why || ''}`) : { score: 0 };
    const viaArea = area ? hit(`${area.name} ${area.standards || ''}`) : { score: 0 };
    const best = [[own, 'project', null], [viaGoal, 'goal', goal && goal.title], [viaArea, 'area', area && area.name]].sort((a, b) => b[0].score - a[0].score)[0];
    const score = own.score * 2 + viaGoal.score + viaArea.score * 0.5;
    // A match only through its goal or area needs more than one word.
    if (own.score ? score >= 2 : score >= 3) out.push({ project: { id: p.id, name: p.name }, via: best[1], viaName: best[2], word: best[0].word, score });
  });
  return out.sort((a, b) => b.score - a.score || String(a.project.name).localeCompare(String(b.project.name))).slice(0, limit);
}

// The gain to show for an action: its own, else its project's purpose (inherited).
export function gainOf(t, projects = []) {
  if (t.gain) return { text: t.gain, own: true, suggested: t.gain_by === 'agent' };
  const p = t.project_id && projects.find((x) => x.id === t.project_id);
  return p && p.purpose ? { text: p.purpose, own: false, project: p.name } : null;
}

// A gainless item skipped in Clarify this often is offered Someday or Drop.
export const WEAK_SKIPS = 3;
export const isWeak = (t) => !t.gain && (t.clarify_skips || 0) >= WEAK_SKIPS;

// "Get a trailer quote → two crews on Fridays" (also -> and ::) — title and gain in one line.
export function splitGain(line) {
  const m = String(line || '').match(/^(.*?\S)\s*(?:→|->|::)\s*(\S.*)$/);
  return m ? { title: m[1].trim(), gain: m[2].trim().slice(0, 500) } : { title: String(line || '').trim(), gain: '' };
}
// A "Gain:" (or "Why:") line in an email body or a note: the gain, and the text without that line.
export function gainFromText(text) {
  const lines = String(text || '').split(/\r?\n/);
  const i = lines.findIndex((l) => /^\s*(gain|why)\s*:/i.test(l));
  if (i < 0) return { gain: '', rest: String(text || '') };
  const gain = lines[i].replace(/^\s*(gain|why)\s*:\s*/i, '').trim().slice(0, 500);
  return { gain, rest: [...lines.slice(0, i), ...lines.slice(i + 1)].join('\n').trim() };
}
