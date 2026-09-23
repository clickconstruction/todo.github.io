// Hash router: #view/arg/arg… → view function; also updates tab state and badges.
import { db, app, $, isOpen, esc } from './state.js';
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
import { viewTemplate } from './views/templates.js';
import { withFocus, getFocus, focusLabel, focusedProjectIds } from './prefs.js';

const UNFOCUSED = new Set(['inbox', 'search', 'settings', 'import', 'alerts', 'places', 'template', 'done']);
const VIEWS = {
  search: viewSearch, inbox: viewInbox, forecast: viewForecast, projects: viewProjects, project: viewProject,
  tags: viewTags, tag: viewTag, settings: viewSettings, done: viewDone, flagged: viewFlagged, review: viewReview,
  nearby: viewNearby, places: viewPlaces, alerts: viewAlerts, perspective: viewPerspective, perspectives: viewPerspectives, import: viewImport, template: viewTemplate,
};
// Work that needs the rendered DOM (the Nearby map is mounted into its slot).
const AFTER = { nearby: mountNearbyMap };
// Detail views highlight their parent tab.
const TAB_FOR = { project: 'projects', tag: 'tags', places: 'nearby', alerts: 'nearby', import: 'settings', template: 'projects' };

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
  // Focus narrows most views; the Inbox, Search and settings-like pages always show everything.
  // A project outside the focus still opens (e.g. from a link), without the banner.
  const ids = focusedProjectIds();
  const focused = !!ids && !UNFOCUSED.has(view) && !(view === 'project' && !ids.has(args[0]));
  const html = focused ? withFocus(() => (VIEWS[view] || viewInbox)(...args)) : (VIEWS[view] || viewInbox)(...args);
  const banner = focused ? `<div class="focus-banner" role="status"><span>🎯 Focused on <b>${esc(focusLabel())}</b></span>
    <span><button class="link-btn" data-act="focus">Change</button><button class="link-btn" data-act="unfocus">Unfocus</button></span></div>` : '';
  $('#view').innerHTML = banner + html;
  document.body.classList.toggle('is-focused', !!getFocus());
  if (AFTER[view]) AFTER[view](...args);
  const tab = TAB_FOR[view] || view;
  document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('active', a.dataset.view === tab));
  const inboxCount = db.tasks.filter((t) => t.in_inbox && !t.parent_id && isOpen(t)).length;
  const dueCount = ids ? withFocus(forecastBadgeCount) : forecastBadgeCount(); // due today + overdue (in focus)
  $('#badge-inbox').textContent = inboxCount || '';
  $('#badge-forecast').textContent = dueCount || '';
  $('#badge-flagged').textContent = (ids ? withFocus(flaggedBadgeCount) : flaggedBadgeCount()) || '';
  $('#badge-review').textContent = (ids ? withFocus(reviewDueCount) : reviewDueCount()) || '';
  $('#badge-nearby').textContent = hereNowCount() || '';
  // Views that live under "More" on phones light up the More tab.
  $('#more-tab').classList.toggle('active', ['tags', 'tag', 'done', 'settings', 'search', 'review', 'nearby', 'places', 'alerts', 'perspective', 'perspectives', 'import'].includes(view));
  const nav = $('#nav-perspectives');
  if (nav) nav.innerHTML = ids ? withFocus(() => perspectiveNav(view === 'perspective' ? args[0] : null)) : perspectiveNav(view === 'perspective' ? args[0] : null);
  renderInspector();
  if ('setAppBadge' in navigator) (inboxCount + dueCount ? navigator.setAppBadge(inboxCount + dueCount) : navigator.clearAppBadge()).catch(() => {});
}

app.render = render;
