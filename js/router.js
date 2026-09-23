// Hash router: #view/arg/arg… → view function; also updates tab state and badges.
import { db, app, $, isOpen } from './state.js';
import { isDueToday } from './dates.js';
import { viewInbox, viewToday, viewTags, viewTag, viewFlagged, flaggedBadgeCount } from './views/basic.js';
import { viewProjects, viewProject } from './views/projects.js';
import { viewSearch } from './views/search.js';
import { viewDone } from './views/done.js';
import { viewSettings } from './views/settings.js';

const VIEWS = {
  search: viewSearch, inbox: viewInbox, today: viewToday, projects: viewProjects, project: viewProject,
  tags: viewTags, tag: viewTag, settings: viewSettings, done: viewDone, flagged: viewFlagged,
};
// Detail views highlight their parent tab.
const TAB_FOR = { project: 'projects', tag: 'tags' };

export function render() {
  const [view, ...args] = (location.hash.slice(1) || 'inbox').split('/');
  $('#view').innerHTML = (VIEWS[view] || viewInbox)(...args);
  const tab = TAB_FOR[view] || view;
  document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('active', a.dataset.view === tab));
  const inboxCount = db.tasks.filter((t) => t.in_inbox && !t.parent_id && isOpen(t)).length;
  const dueCount = db.tasks.filter((t) => isOpen(t) && isDueToday(t)).length;
  $('#badge-inbox').textContent = inboxCount || '';
  $('#badge-today').textContent = dueCount || '';
  $('#badge-flagged').textContent = flaggedBadgeCount() || '';
  // Views that live under "More" on phones light up the More tab.
  $('#more-tab').classList.toggle('active', ['tags', 'tag', 'done', 'settings', 'search', 'review'].includes(view));
  if ('setAppBadge' in navigator) (inboxCount + dueCount ? navigator.setAppBadge(inboxCount + dueCount) : navigator.clearAppBadge()).catch(() => {});
}

app.render = render;
