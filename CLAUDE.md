# CLAUDE.md

Guidance for Claude working in this repo. See README.md for what the app is and how to run it.

## Product rules (don't break these)

- **Nothing the user made is deleted.** Actions are completed or dropped, projects are completed or dropped, and everything else they keep (folders, places, events, calendars, attachments, perspectives) is archived. Database triggers and RLS enforce this; never add a delete path for any of it. Only links and device settings are removed outright: tag links, "waits for" links, reminders on an item, push subscriptions, API tokens and approved senders.
- **The MCP can do everything a user can,** except manage API tokens and approved email senders, which stay app-only for security. What belongs to one device rather than the account (its push subscription, Focus, which sidebar groups are collapsed) is set in the app on that device. Subscribed calendars are the `calendars` tool and the Settings page is the `settings` tool; a calendar's private link can be saved through the MCP but is never returned.
- **Planned vs Due:** Planned is an intention; Due is only for hard deadlines. Flagged means "important now".
- **The database is the source of truth for rules.** Put a rule in a trigger or SQL function when it must hold for both the app and the MCP, and test it in `supabase/tests/`.

## Stack

- Plain JavaScript ES modules, no framework and no build step. State lives in `db` and `app` in `js/state.js`.
- Supabase project `cgssdelgtxlrfgozchps` (Postgres with owner-only RLS on every table). Apply migrations with the Supabase MCP (`apply_migration`) or with `python3 dev/sbq.py supabase/migrations/<file>.sql` (the Management API with the CLI's saved login; then record the version in `supabase_migrations.schema_migrations`), and keep a copy in `supabase/migrations/`. Never `supabase db push`: the history table holds the MCP's own version numbers. `python3 dev/sbq.py supabase/tests/<file>.sql` runs a rule test.
- MCP server: a Cloudflare Worker in `mcp/`, at `https://mcp.todotooling.com/mcp`. It uses the server secret key, so **every query must be scoped to the token owner** (`api.u` / `user_id`).
- Local Node is v20, so deploy with `npx -y wrangler@3 deploy`.

## Every release

1. Bump `VERSION` in `sw.js` when any shell file changes (the service worker is cache-first). Add new JS files to the `SHELL` list.
2. Run the tests that apply:
   - `node mcp/test.mjs` for MCP changes (it also counts requests per call)
   - the smoke suites at `http://localhost:8765/?mock`: `const { run } = await import('/dev/smoke.js'); await run({ only: ['suite'] })`
     The full run takes two to three minutes, longer than the Browser pane's 45-second script timeout. A timed-out call keeps running in the page, and a second run resets the mock data under it, which produces dozens of bogus `null.click` failures. In the Browser pane start it detached and poll: `import('/dev/smoke.js').then(m => m.run()).then(r => window.__smokeResult = r)`, then read `window.__smokeResult`. Reload the page before any re-run. Run them at desktop width (1280 wide): in a narrow Browser pane the app is in phone layout and the sidebar suite fails two checks for pinned perspectives.
   - SQL rule tests: wrap them in a transaction that rolls back (or ends by raising an exception) so nothing is left behind in the real database
3. Apply any new migration and deploy the Worker (if `mcp/` changed) as part of finishing the feature; Todd has asked for this to happen without a separate go-ahead once the tests pass. Migration first: the app and the Worker read new tables on start. Then commit, push, and fast-forward `main` (that deploys the app) in the same go: Todd's standing instruction is "always commit, push, merge".
4. Commit messages: an app release is titled after the feature with the version in parentheses, matching `sw.js` (`Steps type and "Waits for" links (v74)`). Worker-only changes are prefixed `MCP:` and carry no version; test-only changes are prefixed `smoke:` or `dev:`.

## MCP limits (Cloudflare free plan)

Each call gets **50 outgoing requests** and **about 10 ms of CPU**, and the library is large (8,000+ open tasks).

- Never make one request per item. Batch with `id=in.(…)`.
- Whole-library reads come from one snapshot, `rpc/mcp_snapshot`. If you add a column to `tasks`, add it to `mcp_snapshot`. The mirror in `mcp/test.mjs` takes its columns from the test rows, so give a test task the new column or the tests won't see it.
- "What's available" comes from `rpc/available_task_ids`. Keep the SQL, `js/availability.js` and the MCP's `availabilityOf` / `parkedOf` in sync.
- Reads are cached per call (`api.q`); writes clear the cache.
- REST paging adds `order=id.asc`; tables without an `id` column need an entry in `TIE` in `mcp/src/index.js`.

## Gotchas

- `_config.yml`'s Jekyll `exclude` is a prefix match: keep the trailing slashes (`supabase/`, not `supabase`), or `supabase-client.js` disappears from the site.
- `config.js` is committed and holds only the public publishable key. Never put a secret key in it. Local overrides go in `config.local.js` (gitignored, localhost only).
- In SQL, `only` is a reserved word; don't use it as a parameter name.
- Dailies (`tasks.daily`, `daily_ticks`, js/dailies.js, mcp/src/dailies.js): the rules both sides share (which days are asked for, the week, the summary line) live in `js/daily-rules.js`, which has no imports so the Worker can use it. A daily action has no dates or repeat rule (a trigger clears them), is never "available", and is ticked per day; un-ticking sets the tick to `cleared`, it is never deleted. *Have to* (`must`) may show a miss and appears in must-dos; *Should* (`should`) must never nag.
- Horizons checkboxes (`js/horizon-text.js`, no imports, shared with the Worker): the purpose and vision text is plain text with a few marks (`#`, `##`, `**`, `*`, `- `), rendered by escaping first and then applying the marks, so nothing typed becomes markup. A line starting with `[ ]` / `[x]` is a checkbox, and the ticks live in the text itself. A trigger clears them when `purpose_read_at` / `vision_read_at` changes; the JS pattern and the SQL pattern must match.
- Tech tree (`tree_links`, `goals.kind`, js/tree-rules.js, js/views/tree.js, mcp/src/tree.js): states and layout come from `js/tree-rules.js` (no imports, shared with the Worker); the database refuses loops and archives removed links. Nothing holds or starts a project, or accepts a link, without the user: the app and the MCP offer and say what would change. A project on hold with no accepted requirement is `held`, never `ready`.
- Loading (`js/data.js` `every`): tables over 1,000 rows are paged. The first page asks for the row count, then the remaining pages are fetched together. Don't go back to one page after another: with 8,000 actions that was ten round trips in a row on every reload. A reload on a Full Review shows the card first (`quickReview`) while the library loads behind it.
- Events (`events` table, js/events.js, mcp/src/events.js): an all-day event is stored from local midnight of its first day to local midnight *after* its last day (end exclusive, as iCalendar does it), in the user's time zone. The app and the Worker both follow this; the feed emits `VALUE=DATE` for them.

## Full Review with the user

When the user is going through a Full Review (`full_review` tool):

- Turn what they say into a **suggestion** on the current card; they press Submit in the app.
- When they say **"submit"** (for example "submit, next card"), call `full_review` with action `submit` to press it for them. **"Submitted"** means they already pressed it; just check `status`.
- Use `annotate` / `decide` directly only when they say "just do it".
- Name the card in every reply, because they may have moved on in the app. Check `status` before suggesting, so a suggestion never lands on the wrong card.
