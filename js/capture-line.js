// A capture box with no chips reads its line as the quick entry does (js/capture-grammar.js): #project, @tag,
// due fri, plan fri, "→ gain"; not a bare day word, since there are no chips here to show what was read. A #name
// no project has stays in the title, and the toast offers to make that project (or to reopen a completed one of
// that name); the card then moves there with a clean title. The Inbox box and a project's own box (js/main.js)
// and the mind sweep's box (js/views/sweep.js) all go through here, so they read the same marks.
import { db, app, byId, toast, tagLabel, sortedTags } from './state.js';
import { capture, setLinks, projectNamed, insertProject, updateTask } from './data.js';
import { atDefaultTime } from './dates.js';
import { parseCapture, dayLabel } from './capture-grammar.js';

const liveProjects = () => db.projects.filter((p) => p.status === 'active' || p.status === 'on_hold');
// What a line says, before anything is saved: {title, project?, tags, due?, planned?, gain?, unknownProject?, chips}.
export const readLine = (line) => parseCapture(line, { projects: liveProjects(), tags: sortedTags().map((g) => ({ id: g.id, name: g.name, label: tagLabel(g) })), bareDay: false });

export async function captureLine(line, extra = {}) {
  const a = readLine(line);
  if (!a.title) return null;
  const at = (day, key) => atDefaultTime(new Date(`${day}T12:00:00`), key).toISOString();
  const row = await capture(a.title, { ...extra, ...(a.gain ? { gain: a.gain } : {}), ...(!extra.project_id && a.project ? { project_id: a.project.id, in_inbox: false } : {}), ...(a.due ? { due_at: at(a.due, 'due_at') } : {}), ...(a.planned ? { planned_at: at(a.planned, 'planned_at') } : {}) });
  if (!row) return null;
  if (a.tags.length) { await setLinks('task_tags', 'taskTags', 'task_id', row.id, a.tags.map((x) => x.id)); app.render(); }
  const project = row.project_id && byId(db.projects, row.project_id);
  const when = [a.due && `due ${dayLabel(a.due)}`, a.planned && `planned ${dayLabel(a.planned)}`].filter(Boolean).join(' · ');
  const where = project ? `Captured to ${project.name}` : 'Captured to Inbox';
  if (a.unknownProject && !project) {
    const name = a.unknownProject;
    const { completed } = projectNamed(name);
    toast(`${where} · no project named “${name}” yet`, { label: completed ? `Reopen ${completed.name}` : `Make ${name}`, run: async () => {
      const p = await insertProject(name);
      if (!p) return;
      const again = readLine(line); // the name is a project now, so it leaves the title
      await updateTask(byId(db.tasks, row.id) || row, { project_id: p.id, in_inbox: false, title: again.title || row.title });
      toast(`Moved to ${p.name}`);
    } });
  } else if (a.chips.length) toast(`${where}${when ? ` · ${when}` : ''}`);
  return row;
}
