// Runs the OmniFocus script (js/omnifocus-import.js OMNI_SCRIPT) against a fake OmniFocus object model
// and imports its output: `node dev/omnifocus-script-sim.mjs`. Catches script errors without OmniFocus.
import * as O from '../js/omnifocus-import.js';
let n = 0; const id = () => ({ primaryKey: 'k' + (++n) });
const E = (name) => ({ toString: () => `[object ${name}]` });
const Project = { Status: { Active: E('Active'), OnHold: E('OnHold'), Done: E('Done'), Dropped: E('Dropped') } };
const Folder = { Status: { Active: E('FA'), Dropped: E('FD') } };
const Tag = { Status: { Active: E('TA'), OnHold: E('TOH'), Dropped: E('TD') } };
const Task = { RepetitionMethod: { Fixed: E('Task.RepetitionMethod: Fixed'), DeferUntilDate: E('Task.RepetitionMethod: DeferUntilDate') } };
const d = (s) => new Date(s);
const work = { id: id(), name: 'Work', parent: null, status: Folder.Status.Active, added: d('2025-01-01') };
const clients = { id: id(), name: 'Clients', parent: work, status: Folder.Status.Active };
const waiting = { id: id(), name: 'Waiting', parent: null, status: Tag.Status.Active };
const hiro = { id: id(), name: 'Hiro', parent: waiting, status: Tag.Status.Active };
const phone = { id: id(), name: 'Phone', parent: null, status: Tag.Status.OnHold };
const mk = (o) => ({ id: id(), note: '', flagged: false, deferDate: null, dueDate: null, estimatedMinutes: null, completionDate: null, dropDate: null, sequential: false, tags: [], repetitionRule: null, children: [], attachments: [], notifications: [], added: d('2026-01-01'), modified: d('2026-09-01'), ...o });
const step2 = mk({ name: 'Measure' });
const t1 = mk({ name: 'Call GVEC', flagged: true, dueDate: d('2026-09-21T22:00:00Z'), estimatedMinutes: 15, tags: [phone, hiro], notifications: [1] });
const t2 = mk({ name: 'Order fittings', sequential: true, children: [step2], repetitionRule: { ruleString: 'FREQ=WEEKLY;BYDAY=MO', method: Task.RepetitionMethod.DeferUntilDate } });
// plannedDate throws on older versions:
Object.defineProperty(t1, 'plannedDate', { get() { throw new Error('no such property'); } });
const proj = { id: id(), name: 'Click Plumbing', note: 'n', parentFolder: clients, status: Project.Status.Active, sequential: true, containsSingletonActions: false, completedByChildren: true, flagged: false,
  deferDate: null, dueDate: null, estimatedMinutes: null, completionDate: null, dropDate: null, reviewInterval: { steps: 2, unit: 'weeks' }, lastReviewDate: d('2026-09-01'), nextReviewDate: d('2026-09-15'),
  tags: [phone], repetitionRule: null, task: { attachments: [1, 2], children: [t1, t2] }, added: d('2025-02-01'), modified: d('2026-09-20') };
// no .children on the project: the script must fall back to project.task.children
const inboxItem = mk({ name: 'Frog Pond EIN', inInbox: true });
const g = { flattenedFolders: [work, clients], flattenedTags: [waiting, hiro, phone], flattenedProjects: [proj], inbox: [inboxItem], Project, Folder, Tag, Task,
  app: { name: 'OmniFocus', userVersion: { versionString: '4.6' } }, Pasteboard: { general: { string: '' } },
  Alert: class { constructor(t, m) { this.m = m; } show() { g.alert = this.m; return Promise.resolve(); } } };
new Function(...Object.keys(g), O.OMNI_SCRIPT)(...Object.values(g));
const out = JSON.parse(g.Pasteboard.general.string);
console.log('alert:', g.alert);
console.log('tasks:', out.tasks.map((t) => `${t.name}${t.parent ? '<' + out.tasks.find((x) => x.id === t.parent)?.name : ''} planned=${t.planned}`).join(' | '));
const r = O.prepare(O.parse(g.Pasteboard.general.string, { tz: 'America/Chicago' }));
console.log('summary:', JSON.stringify(r.summary));
console.log('project:', JSON.stringify(r.payload.projects[0]).slice(0, 400));
console.log('repeat:', JSON.stringify(r.payload.tasks.find((t) => t.title === 'Order fittings').repeat_rule));
console.log('warnings:', r.warnings);
