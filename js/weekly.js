// The Weekly Review's steps and the mind sweep trigger list. Pure data and helpers, shared by the
// app and the MCP server (no DOM, no database).

export const STAGES = [['clear', 'Get clear'], ['current', 'Get current'], ['creative', 'Get creative']];

// minutes: rough time for the step (n = how many things it has to go through).
export const STEPS = [
  { key: 'papers', stage: 'clear', title: 'Collect loose papers', hint: 'Receipts, notes, business cards, mail, photos of whiteboards: gather them and capture anything that needs doing.', minutes: () => 2 },
  { key: 'sweep', stage: 'clear', title: 'Mind sweep', hint: 'Go through the trigger list and capture every open loop still in your head.', minutes: () => 8 },
  { key: 'inbox', stage: 'clear', title: 'Inbox to zero', hint: 'Clarify everything you captured.', minutes: (n) => Math.max(1, Math.round(n * 0.75)) },
  { key: 'past', stage: 'current', title: 'Last 2 weeks’ calendar', hint: 'Anything left over from these? Follow-ups, thank-yous, notes to file.', minutes: () => 3 },
  { key: 'next', stage: 'current', title: 'Next 3 weeks’ calendar', hint: 'Anything to prepare, buy, book or arrange?', minutes: () => 3 },
  { key: 'stale', stage: 'current', title: 'Stale actions', hint: 'Actions not touched in 60+ days. Still true?', minutes: (n) => Math.round(n * 0.5) },
  { key: 'waiting', stage: 'current', title: 'Waiting For', hint: 'Anything to chase?', minutes: (n) => Math.round(n * 0.5) },
  { key: 'projects', stage: 'current', title: 'Projects', hint: 'Every project due for review has a next action; stuck projects get one.', minutes: (n) => n * 2 },
  { key: 'horizons', stage: 'creative', title: 'Areas, goals and horizons', hint: 'Areas and goals due for their monthly look; the quarterly check-in and yearly read when they come round.', minutes: (n) => n * 3 },
  { key: 'someday', stage: 'creative', title: 'Someday/Maybe', hint: 'Anything to start now? Anything you no longer want?', minutes: (n) => Math.max(2, Math.round(n * 0.2)) },
  { key: 'notes', stage: 'creative', title: 'Process reading notes', hint: 'Fleeting notes and finished reading become permanent notes in your slipbox: one idea each, in your words, linked.', minutes: (n) => (n ? Math.max(3, n * 3) : 1) },
  { key: 'new', stage: 'creative', title: 'Anything new?', hint: 'Ideas, projects, things you’d like to do. Capture them.', minutes: () => 3 },
];
export const STALE_DAYS = 60;
export const SOMEDAY_OLD_DAYS = 180;

// Triggers for a mind sweep: things that tend to hold open loops. { id, group, text, hint }
const W = 'Work'; const P = 'Personal';
export const TRIGGERS = [
  [W, 'Projects started but not finished', 'jobs, bids, installs, paperwork'],
  [W, 'Projects you’ve been meaning to start', 'improvements, new services, systems'],
  [W, 'Commitments to your boss, partners or clients', 'promises, quotes, callbacks'],
  [W, 'Commitments to your crew or employees', 'reviews, raises, training, tools'],
  [W, 'Other people you owe something', 'suppliers, inspectors, subs'],
  [W, 'Calls to make or return', ''],
  [W, 'Emails and texts to answer or send', ''],
  [W, 'Documents to write, finish or send', 'proposals, change orders, invoices'],
  [W, 'Upcoming meetings or events', 'site walks, inspections, trade shows'],
  [W, 'Things to prepare for', 'presentations, bids, audits'],
  [W, 'Bids and estimates', 'open, pending, follow-ups'],
  [W, 'Customers', 'complaints, warranty calls, check-ins'],
  [W, 'Permits, licenses and inspections', ''],
  [W, 'Money in', 'invoices out, collections, deposits'],
  [W, 'Money out', 'bills, payroll, taxes, expenses'],
  [W, 'Budgets, forecasts and numbers', ''],
  [W, 'Hiring and people', 'open roles, onboarding, problems'],
  [W, 'Equipment and vehicles', 'repairs, maintenance, purchases'],
  [W, 'Materials and inventory', 'orders, returns, stock'],
  [W, 'Safety and insurance', ''],
  [W, 'Office and admin', 'supplies, software, phones, filing'],
  [W, 'Computers and data', 'backups, passwords, updates'],
  [W, 'Marketing and sales', 'website, reviews, referrals'],
  [W, 'Legal and contracts', ''],
  [W, 'Planning and goals', 'this quarter, this year'],
  [W, 'Things to research or look up', ''],
  [W, 'Skills to learn or teach', ''],
  [W, 'Things you’re waiting on from others', 'replies, deliveries, approvals'],
  [W, 'Problems to solve', 'recurring issues, bottlenecks'],
  [W, 'Ideas you haven’t captured', ''],
  [P, 'Projects started but not finished', ''],
  [P, 'Projects you’d like to start', ''],
  [P, 'Commitments to family', 'partner, kids, parents'],
  [P, 'Commitments to friends', ''],
  [P, 'Calls, emails and texts to return', ''],
  [P, 'Birthdays, anniversaries, gifts', ''],
  [P, 'Upcoming events', 'weddings, school, trips'],
  [P, 'Home repairs and projects', 'leaks, yard, garage, appliances, painting, filters'],
  [P, 'Household', 'cleaning, supplies, furniture, storage'],
  [P, 'Cars and vehicles', 'service, registration, repairs'],
  [P, 'Money', 'bills, banking, investments, taxes, loans'],
  [P, 'Insurance and legal', 'policies, wills, documents'],
  [P, 'Health', 'doctor, dentist, eyes, prescriptions, exercise'],
  [P, 'Errands and things to buy', ''],
  [P, 'Kids and school', ''],
  [P, 'Pets', ''],
  [P, 'Computers, phones and gadgets', 'backups, repairs, subscriptions'],
  [P, 'Clothes and personal items', ''],
  [P, 'Hobbies and things to learn', ''],
  [P, 'Travel and vacations', ''],
  [P, 'Community, church, volunteering', ''],
  [P, 'Things to return or give back', ''],
  [P, 'Things you’ve borrowed or lent', ''],
  [P, 'Waiting on someone', 'orders, repairs, replies'],
  [P, 'Worries and nagging thoughts', ''],
  [P, 'Ideas and someday wishes', ''],
].map(([group, text, hint], i) => ({ id: `t${i + 1}`, group, text, hint }));

// The prompts to go through: built-ins not hidden, then the user's own.
export function sweepPrompts(settings = {}) {
  const hidden = new Set(settings.trigger_hidden || []);
  const custom = (settings.trigger_custom || []).filter((c) => c && c.id && c.text).map((c) => ({ id: c.id, group: c.group === W ? W : P, text: String(c.text), hint: '', custom: true }));
  const all = [...TRIGGERS.filter((t) => t.group === W), ...custom.filter((c) => c.group === W), ...TRIGGERS.filter((t) => t.group === P), ...custom.filter((c) => c.group === P)];
  return all.filter((t) => !hidden.has(t.id));
}

// Consecutive weeks (Mon–Sun, ending this week or last) with a completed review.
export function streak(completedIsos, now = new Date()) {
  const weekOf = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x.getTime(); };
  const weeks = new Set(completedIsos.filter(Boolean).map(weekOf));
  const W1 = 7 * 86400000;
  let w = weekOf(now);
  if (!weeks.has(w)) w -= W1; // this week's review may still be ahead
  let n = 0;
  while (weeks.has(w)) { n += 1; w -= W1; }
  return n;
}

// Is a review due? From the review day/time (local) and when the last one was completed.
export function reviewDue({ reviewDay = 5, reviewMinutes = 900, lastCompleted = null, now = new Date() }) {
  const last = new Date(now);
  last.setHours(0, 0, 0, 0);
  last.setDate(last.getDate() - ((last.getDay() - reviewDay + 7) % 7)); // most recent review day
  last.setMinutes(reviewMinutes);
  if (last > now) last.setDate(last.getDate() - 7);
  return !lastCompleted || new Date(lastCompleted) < new Date(last.getTime() - 2 * 86400000); // done up to 2 days early counts
}
