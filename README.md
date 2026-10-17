# Todo Tooling

A GTD (Getting Things Done) to-do app at **[todotooling.com](https://todotooling.com)**, built to replace OmniFocus, with Claude as a working partner through an MCP server.

- **The app** is a plain-JavaScript PWA. It works on a laptop and installs on a phone.
- **The data** lives in Supabase (Postgres with row-level security, so each person only sees their own).
- **Claude** connects through the MCP server at `https://mcp.todotooling.com/mcp`, so it can capture, clarify, plan and review with you.

## What it does

- **Capture anywhere:** the Inbox, email (send or BCC `inbox@todotooling.com`), an iPhone Shortcut, the share sheet of a phone with the app installed (text, a link or a file lands in the Inbox), or Claude.
- **Clarify and organize:** projects (parallel, sequential or single actions), steps up to four levels deep, tags, people, "waiting on", "waits for" links between cards, the tickler, reference and someday. Typing a name no project has into any project picker offers to make it; the name of a completed project offers to reopen it instead, so a card never lands in a project the Projects page hides.
- **Delegate and follow up:** hand an action to a person with a drafted message you send yourself, see which follow-ups are due, and keep an agenda of what to raise with each person. A person's own tag is "Waiting : their name": made with them, offered as you type their name, and renamed with them, so items with it count as waiting on them. **Print sheets** gives each person one printed page of what they owe you, oldest first with the day agreed, Done and Not yet boxes, a line for why and by when, and their agenda to talk about; **Debrief** on their page goes down the same list when the sheet comes back, completing cards and writing the reasons and new days onto them. A person with nothing open has an **Archive** button on the People list (the heading archives all of them at once), and "Show n archived" lists them with Restore; nobody is deleted. People can be in a **group** (what they are to you: Crew, Suppliers, Family; one each) and **on projects** (as many as they're part of, with a role word): the People list arranges itself by group, by project or A–Z, each group or project has its own Print sheets, a project's page lists its people with their open items there and offers anyone with open items who isn't on it yet, and the Tags list arranges people's tags by their group.
- **What do I gain?** Every action can say why it's worth doing, so priorities explain themselves and ideas with no payoff are easy to drop.
- **Six (the Ivy Lee list):** up to six things for the day, in order. The first open one is *Now*, the rest wait under *Then*, and finished ones stay in place, crossed out. A dropped one stays too, with a grey ✕, but never counts as done ("1 of 2 done · 1 dropped"); a tap on the ✕ brings it back. Today and tomorrow are the Daily review's focus list, so both screens show the same six. What was left of yesterday comes to the top of today once (with Undo), and from the evening hour (Settings) the view opens on tomorrow. Add offers suggestions first (overdue and due, flagged, what *What now?* would pick), or a place to look: a Matrix box, Forecast's days, Projects or Tags as a tree (every project or tag opens in place to Next and Later, and a closed one shows what you ticked inside it), or Flagged; typing searches there, one link widens it to every open card, and you tick several and add them at once. When no card has the title you typed, the last row saves it as a new card and adds it (Capture's `#project`, `@tag`, `due fri` and `→ gain` work there too; without a project or tag it waits in the Inbox to clarify). It remembers where you last looked. The gear at the end of a row (or holding the row, or pressing e) edits the card there and then; the list redraws when you save. The copy button beside it puts the card's title on the clipboard. Adding plans the card for that day. Keys: d done, n not now, t tomorrow, a add. Claude works the same list with the `six` tool.
- **What now?** Tell it where you are, how long you have and how much energy, and it picks from what's available and says why.
- **Process Inbox:** one item at a time, the item on the left and the decision on the right (stacked on a phone). The nine choices sit in three rows by the question they answer: *do something* (next action, do it now, delegate, project), *not now* (someday, tickler), *not an action* (trash, reference, slipbox), keys 1–9. When similar items point to a project and tags, **File it as suggested** is one press (or Enter). **Ask Claude…** (or `c`) copies the item for Claude; `C` offers the asks. Every decision has Undo. Claude can also draft the decision itself: **Copy a prompt** on the screen asks it to go through the Inbox and put a suggestion on every item (what it is, which project, tags or person, a line on why); items with one come first and **Submit** (or Enter) does what it says, with the other eight choices still a key away. Nothing changes until you press; Dismiss takes a suggestion down and Undo puts a submitted one back.
- **Ask Claude about a card:** on any card (its panel or editor, the Clarify screen, or `C` on a selected item), **Ask Claude…** copies a prompt that says where you are, what the card holds (gain, notes, steps, dates, tags, who it waits on, files) and what you want: clarify it, break it into steps, draft the message, think it through, or just the card. Paste it into any chat with your Todo Tooling tools and Claude can read the whole card with `get_task` and act when you say so.
- **Search on every page:** a box in the title row (press `/`, or `s` on any page but Process Inbox, where `s` skips) that first searches the page you're on: rows that don't match go away, and two pills say *This page · 3* and *Everything · 41*. When nothing on the page matches it shows everything on its own, in place: actions (open and done), projects, the Slipbox, reference, events, people, places, checklists, areas and goals. Esc clears, Enter opens the first match, and the sidebar's Search is the same box in Everything scope.
- **Last added:** what came in lately, newest first under day headings, for the last 7, 30 or 90 days. Each row says when it was added, how it came in (by email, the Shortcut, the share sheet, Claude, a template, an import) and where it is now: an **Inbox** chip while it waits to be clarified, else its project, tags, who it waits on or the tickler; done and dropped rows are struck through. Steps ride on their card and actions on the project they were made with ("with 6 actions"), and the next occurrences a repeat makes on its own stay out unless you ask for them. The count line says how many still wait in the Inbox, a tally shows how things are getting in (tap one to see just those), and the sidebar counts what came in today. A card's own panel says when it was added and last changed, right under its heading. Claude sees the same with `list_added`.
- **Dates that mean something:** *Planned* is when you intend to do it and *Due* is a hard deadline. Forecast shows both day by day.
- **Every day, without the pile-up:** a daily action is a checkbox that starts fresh each morning, not a repeating action that goes overdue. *Have to, every day* (medication, logging hours) shows a missed day and counts as a must-do; *Should, most days* (a walk, reading) just shows how the week is going. Both sit at the top of Forecast → Today. *Could, if I feel like it* is a menu of options (a workout to pick, singing practice) folded away at the bottom of Today: tick what you did, and nothing there is ever missed.
- **Once a week, in the review:** a weekly check is the same kind of checkbox for something you ask or do once a week ("Am I reviewing?", "Did I send everyone their items?"). It never shows in Today. The Weekly Review has a **Weekly checks** step that lists them; tick each as you go, and the next review starts them fresh. Make one from an action's editor (Repeat and alerts → Every day → "Every week, in the Weekly Review"), in a Full Review suggestion, or by asking Claude.
- **Once a month, quarter or year:** a monthly check is the same checkbox for the routines and questions of a monthly review, a quarterly check for the ones you ask every quarter ("Am I making businesses?"), and a yearly check for the ones you ask every year. They never show in Today. Horizons has a monthly review, a quarterly check-in and a yearly review (the last next to the yearly read of your purpose and vision), each listing its checks and reaching the Weekly Review's horizons step while it is due; tick each as you answer it, and the review's "done" button starts them fresh. Make one from the editor ("Every month…", "Every quarter…", "Every year…"), a Full Review suggestion, or by asking Claude.
- **A tick doesn't last forever:** a check's tick holds for half its cycle (3½ days for a weekly check, 15 days for a monthly one, 45 days for a quarterly one, six months for a yearly one) and then lapses on its own, so the next review always finds it fresh even if you never pressed done. The row says when ("ticked Oct 3 · fresh from Nov 17"). A lapsed tick is just an empty box, never a miss.
- **Your own events:** an airshow, a trip, an appointment. Forecast shows them on every day they cover, next to the calendars you subscribe to (private iCal links from Google, iCloud or Outlook), the Events list shows what's coming by month, and they reach your phone through the calendar feed. Add them with + Event or ask Claude.
- **Reviews:** Daily, Weekly (the full GTD checklist), per-project Review, and Full Review, which walks you through a whole library card by card with Claude suggesting and you approving. Every decision can be undone, and Back looks at the cards you decided: your choice is ticked, and a click on another changes it. The Weekly Review's mind sweep goes trigger by trigger ("Home repairs", "Money owed"…) and captures what you type; **Hide this prompt** takes one out for good, and **View hidden prompts** beside it lists them by name with Show again for each (or all at once), so you stay on the prompt you were on. What you type or paste while the last item is still saving stays in the box, and the box reads the same marks as the Inbox box: `#project` files the thought straight into that project, `@tag` tags it, `due fri` dates it and `→` carries why; the list under the prompt says where each one went, and the end screen counts the filed ones apart. Your own prompts come after the built-in ones of their group (Work, then Personal). The group label beside the count ("6 of 56 · Work") shows the whole route when you tap it (or hold the mouse over it): both groups with their counts, the prompts of the one you are in with yours marked and the passed ones muted, and any prompt is a tap that jumps there. Claude goes through the same list with `mind_sweep_prompts` and hides or brings back a prompt through `settings`.
- **Capture with details:** one line can carry the project (`#Click Plumbing`), a tag (`@Laptop`), a deadline (`due fri`, `by fri`) and an intention (`plan fri`, or just `friday`). Each shows as a chip under the box before you save, and a tap takes it off; a line under the chips always says what the line can carry. A `#` on its own opens the project search, and your recent projects are a tap. A word only becomes a chip when a project or tag of that name exists, so an @handle in a title stays text. The gain rides on the line too: `Fix the gate → the dog stays in` (`->` and `::` work as well). The Inbox box and a project's own box read the same marks (not a bare day word, since they have no chips to show it). A `#name` you have no project for stays in the title, and a chip (or the box's toast) offers to make that project, or to reopen a completed one of that name, and files the card in it.
- **Sort by a tag group:** make a parent tag with children, say Bucket with Revenue, Maintenance and Relevance, and every list's View gets a "By Bucket" sort: cards with the first child first, then the next, cards with none last. A project's tag counts for its cards. A child's place in the group is set in the tag editor, and Claude's list_tasks sorts the same way.
- **Links in titles and notes:** a URL in a title shows as a small "↗ site" pill in its place, in lists and on the Full Review card, and opens the page in a new tab; a URL in notes is an underlined link. A card whose link lives in its notes gets the pill beside its title instead. The rest of the title still opens or edits the card.
- **Edit as you go:** on a Full Review card, click the title, Gain, Project, When, Tags or Notes and it becomes a small editor right there. Save writes that one field, Esc puts it back, and the review keys sleep while it is open. Edit details still opens the whole editor.
- **Claude a few cards ahead:** tick **Keep Claude ahead** at the top of a Full Review and Claude keeps a suggestion waiting on each of the next 20 cards, so a card already has one when you reach it and you only press Submit, Edit or Dismiss. The count beside the box ("7 of 20 drafted") shows how far ahead it is. Drafts come from your patterns, not your words, so Claude never drafts Drop or Done for something you haven't let go of.
- **Places:** actions tied to locations, with Nearby, errand runs and location alerts.
- **Reminders:** notifications on your devices that follow an item's dates.
- **Attachments:** files on an action or project.
- **A tech tree:** goals and projects linked by what they require, so doing certain things unlocks future things. Milestones are conditions you tick; destinations are where a branch leads. A locked project belongs on hold and an unlocked one can be started, always on your word. The app finds links already written in your library ("(phase 2)" in a name, "Start when…" in an action), and Claude can propose more; both wait, dashed, until you accept. What something requires can be a single card: finishing it says what it unlocked. Links are made in a two-pane linker that shows your library as folders, projects, cards and steps, with a search that keeps each match under what it belongs to. A destination nothing leads to yet says "no path yet" instead of pretending to be open. A big tree opens as its branches, one card each, and **Review** answers three questions: what you unlocked since last time, what is open now and whether it is moving, and whether every destination is still one you want. In a Full Review, a suggestion can show what it would add to the tree before you press Submit; Undo takes it back.
- **A purpose you can tick:** your purpose and vision are written plainly (`# title`, `## section`, `**bold**`, `*italic*`, `- bullet`) with buttons for each, and read formatted; while you edit, the page as it will read sits beside the text. A line that starts with `[ ]` is a checkbox: tick them as you read, and "Mark as read today" clears them for next time.
- **Horizons, perspectives, the Eisenhower matrix, checklists, templates, a slipbox and a reading list.**
- **An OmniFocus import** with a guided sort afterwards.
- **Nothing is ever deleted.** Actions are completed or dropped, projects are completed or dropped, tags are dropped or put on hold, and everything else (folders, places, people and their groups, events, calendars, attachments, perspectives) is archived. The database enforces this.

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

**Draft my Inbox:** on Process Inbox, **Copy a prompt** copies an ask to paste into any chat with your Todo Tooling tools. Claude reads the Inbox, puts a suggestion on every item that has none (what it is, the project, tags or person, a line on why) and changes nothing; the items come first in Process Inbox with **Submit** on each. Say "submit" in the chat and Claude presses it for you; say "just do it" and it clarifies the item outright.

**Keep Claude ahead** needs Claude to be running, because Claude only acts while its chat is working: the app cannot wake it. Tick the box, press **Copy prompt** (or **Prompt for Claude**) and paste it into Claude once. In Claude Code it then checks the review about every 30 seconds (with `/loop` or a scheduled wake-up) and drafts whatever is missing; a check with nothing to do is one small call. In a chat that cannot loop, it tops up each time you send a message. Untick the box and it stops. It leaves the card you are on alone, so a draft you dismissed does not come back.

## Repository layout

| Path | What it is |
|---|---|
| `index.html`, `styles.css`, `sw.js`, `manifest.webmanifest` | The app shell and service worker |
| `js/` | App modules (plain ES modules, no build step). `main.js` starts it; `views/` are screens; `editors/` are the inspector and sheets |
| `config.js` | Supabase URL and publishable key (public, protected by RLS). `config.example.js` is the template for a local `config.local.js` |
| `supabase-client.js`, `vendor/` | The Supabase client and the bundled `supabase-js` library it loads |
| `icons/`, `favicon.png` | App icons. `icons/icon.svg` is the master (a gear with a check); the PNGs beside it and `favicon.png` are rendered from it, the maskable one with the artwork at 80% for the safe zone |
| `supabase/migrations/` | The database schema, rules and functions |
| `supabase/tests/` | SQL rule tests; each runs in a transaction and rolls back |
| `mcp/` | The MCP server, a Cloudflare Worker (also email capture, reminders, calendar feed, push) |
| `dev/` | The in-memory Supabase mock, UI smoke tests, import tools, and `sbq.py`, which runs SQL on the project with the Supabase CLI's saved login |

`mcp/`, `supabase/` and `dev/` are excluded from the published site in `_config.yml`.

## Development

**Run the app locally**

```bash
python3 -m http.server 8765
```

Open `http://localhost:8765/?mock` to use the in-memory mock (`dev/mock-supabase.js`) instead of the real database. Set `window.__mockDelay = 800` in the console to make each mock request take that many milliseconds, to see what the app shows while a write is on its way.

**UI smoke tests:** with the mock page open, run this in the browser console:

```js
const { run } = await import('/dev/smoke.js'); await run()
```

The full run takes about six minutes. Pass `{ only: ['suiteName'] }` to run one suite.

**MCP tests**

```bash
node mcp/test.mjs
```

**Database tests:** run any file in `supabase/tests/` against the project. Every row of its final `select` should say `ok = true`.

```bash
python3 dev/sbq.py supabase/tests/dailies.sql
```

`dev/sbq.py` uses the Supabase CLI's saved login (`supabase login` once), so nothing is pasted into the SQL editor.

## Deploying

- **The app** deploys when you push to `main` (GitHub Pages). Bump `VERSION` in `sw.js` whenever a shell file changes, or phones keep the old cached copy. The version a device runs shows at the foot of the sidebar, next to **Refresh**, which reads everything again and switches to a new version at once if one is ready. A switch that stalls (the tab was asleep, or two releases came minutes apart) sorts itself out within a few seconds, and a tap on **Update ready · Reload** or **Refresh** always tries again.
- **The MCP server:**

  ```bash
  cd mcp && npx -y wrangler@3 deploy
  ```

  Worker secrets (set with `wrangler secret put`): `SUPABASE_SECRET_KEY`, `VAPID_PRIVATE_JWK`, and optionally `GOOGLE_SERVER_KEY`.
- **Database changes:** add a new file in `supabase/migrations/` and apply it to the Supabase project:

  ```bash
  python3 dev/sbq.py supabase/migrations/<file>.sql
  ```

  Then record its version in `supabase_migrations.schema_migrations`. Don't use `supabase db push`; the history table holds the Supabase MCP's own version numbers.
