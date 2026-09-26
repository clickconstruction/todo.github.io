# CLAUDE.md

Guidance for Claude working in this repo. See README.md for what the app is and how to run it.

## Product rules (don't break these)

- **Nothing is deleted.** Actions are completed or dropped, projects are completed or dropped, folders and places are archived. Database triggers and RLS enforce this; never add a delete path.
- **The MCP can do everything a user can,** except manage API tokens and approved email senders, which stay app-only for security.
- **Planned vs Due:** Planned is an intention; Due is only for hard deadlines. Flagged means "important now".
- **The database is the source of truth for rules.** Put a rule in a trigger or SQL function when it must hold for both the app and the MCP, and test it in `supabase/tests/`.

## Stack

- Plain JavaScript ES modules, no framework and no build step. State lives in `db` and `app` in `js/state.js`.
- Supabase project `cgssdelgtxlrfgozchps` (Postgres with owner-only RLS on every table). Apply migrations with the Supabase MCP (`apply_migration`), and keep a copy in `supabase/migrations/`.
- MCP server: a Cloudflare Worker in `mcp/`, at `https://mcp.todotooling.com/mcp`. It uses the server secret key, so **every query must be scoped to the token owner** (`api.u` / `user_id`).
- Local Node is v20, so deploy with `npx -y wrangler@3 deploy`.

## Every release

1. Bump `VERSION` in `sw.js` when any shell file changes (the service worker is cache-first). Add new JS files to the `SHELL` list.
2. Run the tests that apply:
   - `node mcp/test.mjs` for MCP changes (it also counts requests per call)
   - the smoke suites at `http://localhost:8765/?mock`: `const { run } = await import('/dev/smoke.js'); await run({ only: ['suite'] })`
     The full run takes two to three minutes, longer than the Browser pane's 45-second script timeout. A timed-out call keeps running in the page, and a second run resets the mock data under it, which produces dozens of bogus `null.click` failures. In the Browser pane start it detached and poll: `import('/dev/smoke.js').then(m => m.run()).then(r => window.__smokeResult = r)`, then read `window.__smokeResult`. Reload the page before any re-run.
   - SQL rule tests: wrap them in a transaction that rolls back (or ends by raising an exception) so nothing is left behind in the real database
3. Commit to `main` and push (that deploys the app), then deploy the Worker if `mcp/` changed. Production deploys need the user's go-ahead.
4. Commit messages: an app release is titled after the feature with the version in parentheses, matching `sw.js` (`Steps type and "Waits for" links (v74)`). Worker-only changes are prefixed `MCP:` and carry no version; test-only changes are prefixed `smoke:` or `dev:`.

## MCP limits (Cloudflare free plan)

Each call gets **50 outgoing requests** and **about 10 ms of CPU**, and the library is large (8,000+ open tasks).

- Never make one request per item. Batch with `id=in.(…)`.
- Whole-library reads come from one snapshot, `rpc/mcp_snapshot`. If you add a column to `tasks`, add it to `mcp_snapshot` and to the mirror in `mcp/test.mjs`.
- "What's available" comes from `rpc/available_task_ids`. Keep the SQL, `js/availability.js` and the MCP's `availabilityOf` / `parkedOf` in sync.
- Reads are cached per call (`api.q`); writes clear the cache.
- REST paging adds `order=id.asc`; tables without an `id` column need an entry in `TIE` in `mcp/src/index.js`.

## Gotchas

- `_config.yml`'s Jekyll `exclude` is a prefix match: keep the trailing slashes (`supabase/`, not `supabase`), or `supabase-client.js` disappears from the site.
- `config.js` is committed and holds only the public publishable key. Never put a secret key in it. Local overrides go in `config.local.js` (gitignored, localhost only).
- In SQL, `only` is a reserved word; don't use it as a parameter name.
- Events (`events` table, js/events.js, mcp/src/events.js): an all-day event is stored from local midnight of its first day to local midnight *after* its last day (end exclusive, as iCalendar does it), in the user's time zone. The app and the Worker both follow this; the feed emits `VALUE=DATE` for them.

## Full Review with the user

When the user is going through a Full Review (`full_review` tool):

- Turn what they say into a **suggestion** on the current card; they press Submit in the app.
- When they say **"submit"** (for example "submit, next card"), call `full_review` with action `submit` to press it for them. **"Submitted"** means they already pressed it; just check `status`.
- Use `annotate` / `decide` directly only when they say "just do it".
- Name the card in every reply, because they may have moved on in the app. Check `status` before suggesting, so a suggestion never lands on the wrong card.
