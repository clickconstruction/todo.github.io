// Hash router: #view/arg/arg… → view function; also updates tab state and badges.
import { db, app, $, isOpen } from './state.js';
import { viewInbox, viewTags, viewTag, viewFlagged, flaggedBadgeCount } from './views/basic.js';
import { viewForecast, forecastBadgeCount } from './views/forecast.js';
import { viewReview, reviewDueCount } from './views/review.js';
import { renderInspector } from './inspector.js';
import { viewProjects, viewProject } from './views/projects.js';
import { viewSearch } from './views/search.js';
import { viewDone } from './views/done.js';
import { viewSettings } from './views/settings.js';
import { viewNearby, viewPlaces, mountNearbyMap } from './views/nearby.js';
import { viewAlerts } from './views/alerts.js';
import { hereNowCount } from './places.js';
import { viewPerspective, viewPerspectives, perspectiveNav } from './views/perspective.js';
import { viewImport } from './views/import.js';

const VIEWS = {
  search: viewSearch, inbox: viewInbox, forecast: viewForecast, projects: viewProjects, project: viewProject,
  tags: viewTags, tag: viewTag, settings: viewSettings, done: viewDone, flagged: viewFlagged, review: viewReview,
  nearby: viewNearby, places: viewPlaces, alerts: viewAlerts, perspective: viewPerspective, perspectives: viewPerspectives, import: viewImport,
};
// Work that needs the rendered DOM (the Nearby map is mounted into its slot).
const AFTER = { nearby: mountNearbyMap };
// Detail views highlight their parent tab.
const TAB_FOR = { project: 'projects', tag: 'tags', places: 'nearby', alerts: 'nearby', import: 'settings' };

export function render() {
  if (location.hash === '#today') { history.replaceState(null, '', '#forecast'); } // old links
  // #task/<id> (from a notification): show the action in its list and open it.
  const taskLink = location.hash.match(/^#task\/([^/]+)$/);
  if (taskLink) {
    const t = db.tasks.find((x) => x.id === taskLink[1]);
    history.replaceState(null, '', t && t.project_id ? `#project/${t.project_id}` : '#inbox');
    if (t && app.openTask) setTimeout(() => app.openTask(t.id), 0);
  }
  const [view, ...args] = (location.hash.slice(1) || 'inbox').split('/');
  $('#view').innerHTML = (VIEWS[view] || viewInbox)(...args);
  if (AFTER[view]) AFTER[view](...args);
  const tab = TAB_FOR[view] || view;
  document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('active', a.dataset.view === tab));
  const inboxCount = db.tasks.filter((t) => t.in_inbox && !t.parent_id && isOpen(t)).length;
  const dueCount = forecastBadgeCount(); // due today + overdue
  $('#badge-inbox').textContent = inboxCount || '';
  $('#badge-forecast').textContent = dueCount || '';
  $('#badge-flagged').textContent = flaggedBadgeCount() || '';
  $('#badge-review').textContent = reviewDueCount() || '';
  $('#badge-nearby').textContent = hereNowCount() || '';
  // Views that live under "More" on phones light up the More tab.
  $('#more-tab').classList.toggle('active', ['tags', 'tag', 'done', 'settings', 'search', 'review', 'nearby', 'places', 'alerts', 'perspective', 'perspectives', 'import'].includes(view));
  const nav = $('#nav-perspectives');
  if (nav) nav.innerHTML = perspectiveNav(view === 'perspective' ? args[0] : null);
  renderInspector();
  if ('setAppBadge' in navigator) (inboxCount + dueCount ? navigator.setAppBadge(inboxCount + dueCount) : navigator.clearAppBadge()).catch(() => {});
}

app.render = render;
