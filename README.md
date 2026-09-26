# Todo Tooling

A GTD (Getting Things Done) to-do app at **[todotooling.com](https://todotooling.com)**, built to replace OmniFocus, with Claude as a working partner through an MCP server.

- **The app** is a plain-JavaScript PWA. It works on a laptop and installs on a phone.
- **The data** lives in Supabase (Postgres with row-level security, so each person only sees their own).
- **Claude** connects through the MCP server at `https://mcp.todotooling.com/mcp`, so it can capture, clarify, plan and review with you.

## What it does

- **Capture anywhere:** the Inbox, email (send or BCC `inbox@todotooling.com`), an iPhone Shortcut, or Claude.
- **Clarify and organize:** projects (parallel, sequential or single actions), steps up to four levels deep, tags, people, "waiting on", "waits for" links between cards, the tickler, reference and someday.
- **Dates that mean something:** *Planned* is when you intend to do it and *Due* is a hard deadline. Forecast shows both day by day.
- **Reviews:** Daily, Weekly (the full GTD checklist), per-project Review, and Full Review, which walks you through a whole library card by card with Claude suggesting and you approving.
- **Places:** actions tied to locations, with Nearby, errand runs and location alerts.
- **Horizons, perspectives, the Eisenhower matrix, checklists, templates, a slipbox and a reading list.**
- **An OmniFocus import** with a guided sort afterwards.
- **Nothing is ever deleted.** Actions are completed or dropped, projects are completed or dropped, and folders are archived. The database enforces this.

## Connect Claude

1. In the app, open **Settings → New token** and name it after the computer (for example "Claude Code on MacBook").
2. Click **Copy command** and paste it in Terminal on that computer. It looks like:

   ```bash
   claude mcp add --transport http --scope user todotooling https://mcp.todotooling.com/mcp --header "Authorization: Bearer tt_…"
   ```

   `--scope user` makes Todo Tooling available in every folder on that account.
3. Start a Claude Code chat and ask it what's in your Inbox.

Make one token per computer, so you can revoke each on its own. The token is shown only once; if you lose it, make a new one and revoke the old one.

To pick up a Full Review on another computer, open the review in the app, copy the prompt it offers, and paste it into a new chat there.

## Repository layout

| Path | What it is |
|---|---|
| `index.html`, `styles.css`, `sw.js`, `manifest.webmanifest` | The app shell and service worker |
| `js/` | App modules (plain ES modules, no build step). `main.js` starts it; `views/` are screens; `editors/` are the inspector and sheets |
| `config.js` | Supabase URL and publishable key (public, protected by RLS) |
| `supabase/migrations/` | The database schema, rules and functions |
| `supabase/tests/` | SQL rule tests; each runs in a transaction and rolls back |
| `mcp/` | The MCP server, a Cloudflare Worker (also email capture, reminders, calendar feed, push) |
| `dev/` | The in-memory Supabase mock, UI smoke tests and import tools |

`mcp/`, `supabase/` and `dev/` are excluded from the published site in `_config.yml`.

## Development

**Run the app locally**

```bash
python3 -m http.server 8765
```

Open `http://localhost:8765/?mock` to use the in-memory mock (`dev/mock-supabase.js`) instead of the real database.

**UI smoke tests:** with the mock page open, run this in the browser console:

```js
const { run } = await import('/dev/smoke.js'); await run()
```

Pass `{ only: ['suiteName'] }` to run one suite.

**MCP tests**

```bash
node mcp/test.mjs
```

**Database tests:** run any file in `supabase/tests/` against the project. Every row of its final `select` should say `ok = true`.

## Deploying

- **The app** deploys when you push to `main` (GitHub Pages). Bump `VERSION` in `sw.js` whenever a shell file changes, or phones keep the old cached copy.
- **The MCP server:**

  ```bash
  cd mcp && npx -y wrangler@3 deploy
  ```

  Worker secrets (set with `wrangler secret put`): `SUPABASE_SECRET_KEY`, `VAPID_PRIVATE_JWK`, and optionally `GOOGLE_SERVER_KEY`.
- **Database changes:** add a new file in `supabase/migrations/` and apply it to the Supabase project.
