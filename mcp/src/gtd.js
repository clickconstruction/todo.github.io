// GTD practices for agents: Clarify one Inbox item, People (Waiting For + Agendas), Delegate (drafts a
// message for the user to send; nothing is sent from here), the Tickler, and Reference. Same rules as
// the app (js/gtd.js). People and reference items are archived, never deleted.
const ENERGY = ['low', 'medium', 'high'];
const DECISIONS = ['next_action', 'done', 'delegate', 'project', 'someday', 'tickler', 'trash', 'reference', 'slipbox', 'reading'];

export function gtdTools({ OPEN, zonedToIso, localDate, inList, tool }) {
  const today = (api) => localDate(new Date().toISOString(), api.tz);
  const plusDays = (api, n) => localDate(new Date(Date.now() + n * 86400000).toISOString(), api.tz);
  const personOut = (p, extra = {}) => ({ id: p.id, name: p.name, email: p.email || undefined, phone: p.phone || undefined, notes: p.notes || undefined, tag_id: p.tag_id || null, archived: !!p.archived_at || undefined, ...extra });
  const refOut = (r, projects, reveal) => ({
    id: r.id, title: r.title, topic: r.topic || undefined, notes: r.body || undefined,
    project: r.project_id ? ((projects.find((p) => p.id === r.project_id) || {}).name || null) : undefined,
    has_hidden_value: r.secret_value ? true : undefined, hidden_value: reveal && r.secret_value ? r.secret_value : undefined,
    archived: !!r.archived_at || undefined, created_at: r.created_at,
  });
  // The request (or nudge) for the user to send from their own mail/messages app.
  const draft = (p, t, nudge = false) => {
    const first = String(p.name).split(/\s+/)[0];
    const body = nudge ? `Hi ${first}, just checking in on this: ${t.title}. Any update?` : `Hi ${first}, could you take care of this? ${t.title}${t.notes ? `\n\n${t.notes}` : ''}\n\nThanks!`;
    const subject = nudge ? `Following up: ${t.title}` : t.title;
    return {
      to: p.email || p.phone || null, subject, body,
      mailto: p.email ? `mailto:${encodeURIComponent(p.email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}` : undefined,
      sms: p.phone ? `sms:${p.phone.replace(/[^\d+]/g, '')}?body=${encodeURIComponent(body)}` : undefined,
      note: 'Not sent. Give the user this draft (or the link) to send themselves.',
    };
  };
  const followIso = (api, v) => (v === null ? null : zonedToIso(typeof v === 'number' ? plusDays(api, v) : v, 9, api.tz));
  // Groups (what someone is to the user; one each) and projects (any number, with a role word). Groups are
  // archived, never deleted; the database files an archived group's people under "no group".
  const allGroups = (api) => api.q(`people_groups?${api.u}&order=sort.asc,name.asc&select=*`);
  const groupIdFor = async (api, ref) => {
    const all = await allGroups(api);
    const named = (x) => x.name.toLowerCase() === String(ref).trim().toLowerCase();
    const g = all.find((x) => x.id === ref) || all.find((x) => !x.archived_at && named(x)) || all.find(named);
    if (g) { if (g.archived_at) throw new Error(`Group "${g.name}" is archived; restore it with people_groups first`); return g.id; }
    const name = String(ref).trim().slice(0, 60);
    if (!name) return null;
    const sort = Math.max(-1, ...all.map((x) => x.sort || 0)) + 1;
    const [row] = await api.q('people_groups', { method: 'POST', prefer: 'return=representation', body: { user_id: api.userId, name, sort } });
    return row.id;
  };
  // A person's group and projects, for output.
  const ties = async (api) => {
    const [groups, links, { projects }] = await Promise.all([api.q(`people_groups?${api.u}&select=id,name,archived_at`), api.q(`project_people?${api.u}&select=*`), api.lookups()]);
    return (p) => { const g = p.group_id && groups.find((x) => x.id === p.group_id); return { group: g ? g.name : null, group_id: p.group_id || null, projects: links.filter((l) => l.person_id === p.id).map((l) => { const pr = projects.find((x) => x.id === l.project_id); return pr ? { id: pr.id, name: pr.name, role: l.role || undefined } : null; }).filter(Boolean) }; };
  };
  // Replaces the projects a person is on: each a project name or id, or { project, role }.
  const setPersonProjects = async (api, personId, list) => {
    const want = [];
    for (const e of list) { const ref = typeof e === 'string' ? e : e && e.project; if (!ref) continue; const id = await api.resolveProject(ref); if (!want.some((w) => w.project_id === id)) want.push({ project_id: id, role: String((e && e.role) || '').trim().slice(0, 40) }); }
    const have = await api.q(`project_people?${api.u}&person_id=eq.${personId}&select=*`);
    const gone = have.filter((l) => !want.some((w) => w.project_id === l.project_id)).map((l) => l.id);
    if (gone.length) await api.q(`project_people?${api.u}&id=in.(${gone.join(',')})`, { method: 'DELETE' });
    const add = want.filter((w) => !have.some((l) => l.project_id === w.project_id));
    if (add.length) await api.q('project_people', { method: 'POST', body: add.map((w) => ({ user_id: api.userId, person_id: personId, ...w })) });
    for (const w of want) { const l = have.find((x) => x.project_id === w.project_id); if (l && (l.role || '') !== w.role) await api.q(`project_people?${api.u}&id=eq.${l.id}`, { method: 'PATCH', body: { role: w.role } }); }
  };

  return [
    {
      name: 'clarify_item',
      description: 'Clarify (process) one Inbox item with a GTD decision: next_action (give project and/or tags, optional planned/energy/flagged), done (took under 2 minutes), delegate (person, follow_up), project (becomes a project; first_action optional), someday (parks it under an on-hold Someday tag), tickler (date: back in the Inbox that day), trash (dropped, not deleted), reference (filed in Reference under topic), slipbox (an idea to think with, not an action: a fleeting note in the slipbox, with source), reading (something to read/watch/listen to: onto the reading list, up next). Go one item at a time with the user (list_inbox), asking what it is.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          decision: { type: 'string', enum: DECISIONS },
          source: { type: 'string', description: 'slipbox: where the idea came from' },
          type: { type: 'string', enum: ['book', 'article', 'video', 'podcast', 'other'], description: 'reading: what kind' },
          project: { type: 'string', description: 'next_action: project name or id' },
          tags: { type: 'array', items: { type: 'string' }, description: 'next_action: contexts like "Phone"' },
          planned: { type: 'string', description: 'next_action: YYYY-MM-DD' },
          energy: { type: 'string', enum: ENERGY },
          flagged: { type: 'boolean' },
          person: { type: 'string', description: 'delegate: who (name or id; new names become people)' },
          follow_up: { type: ['string', 'integer'], description: 'delegate: YYYY-MM-DD or a number of days (default 7)' },
          name: { type: 'string', description: 'project: the outcome (defaults to the item title)' },
          first_action: { type: 'string', description: 'project: the very next action' },
          date: { type: 'string', description: 'tickler: YYYY-MM-DD (after today)' },
          topic: { type: 'string', description: 'reference: topic to file under' },
          category: { type: 'string', description: 'someday: optional category, e.g. Travel (becomes the tag Someday : Travel)' },
        },
        required: ['id', 'decision'],
      },
      async run(api, a) {
        const t = await api.task(a.id);
        if (t.completed_at || t.dropped_at) throw new Error('That item is already closed');
        const now = new Date().toISOString();
        switch (a.decision) {
          case 'next_action': {
            if (!a.project && !(a.tags || []).length) throw new Error('A next action needs a project or at least one tag');
            return { decision: a.decision, item: await tool('update_task').run(api, { id: t.id, project: a.project, tags: a.tags, planned: a.planned, energy: a.energy, flagged: a.flagged, tickle: null }) };
          }
          case 'done':
            await api.q(`tasks?${api.u}&id=eq.${t.id}`, { method: 'PATCH', body: { completed_at: now } });
            return { decision: a.decision, item: (await api.shape([await api.task(t.id)]))[0] };
          case 'trash':
            await api.q(`tasks?${api.u}&id=eq.${t.id}`, { method: 'PATCH', body: { dropped_at: now } });
            return { decision: a.decision, item: (await api.shape([await api.task(t.id)]))[0], note: 'Dropped (never deleted); restore with update_task status open.' };
          case 'delegate':
            if (!a.person) throw new Error('delegate needs person');
            return { decision: a.decision, ...(await tool('delegate').run(api, { id: t.id, person: a.person, follow_up: a.follow_up })) };
          case 'tickler':
            if (!a.date) throw new Error('tickler needs date (YYYY-MM-DD)');
            return { decision: a.decision, ...(await tool('tickle').run(api, { id: t.id, date: a.date })) };
          case 'someday': {
            const tags = await api.q(`tags?${api.u}&parent_id=is.null&select=id,name,status`);
            let g = tags.find((x) => /^someday/i.test(x.name));
            if (!g) [g] = await api.q('tags', { method: 'POST', prefer: 'return=representation', body: { user_id: api.userId, name: 'Someday', status: 'on_hold' } });
            else if (g.status !== 'on_hold') await api.q(`tags?${api.u}&id=eq.${g.id}`, { method: 'PATCH', body: { status: 'on_hold' } });
            const label = a.category ? `${g.name} : ${String(a.category).trim()}` : g.name; // update_task creates the sub-tag
            return { decision: a.decision, item: await tool('update_task').run(api, { id: t.id, add_tags: [label], tickle: null }), note: `Parked under the on-hold tag “${g.name}”; set the tag active (or remove it) to bring it back.` };
          }
          case 'project': {
            if (a.name && a.name.trim() !== t.title) await api.q(`tasks?${api.u}&id=eq.${t.id}`, { method: 'PATCH', body: { title: a.name.trim() } });
            const out = await tool('convert_to_project').run(api, { id: t.id });
            if (a.first_action) out.first_action = await tool('capture').run(api, { title: a.first_action, project: out.id });
            return { decision: a.decision, ...out };
          }
          case 'reference': {
            const [ref] = await api.q('reference_items', { method: 'POST', prefer: 'return=representation', body: { user_id: api.userId, title: t.title, body: t.notes || '', topic: a.topic || '' } });
            await api.q(`attachments?${api.u}&task_id=eq.${t.id}&archived_at=is.null`, { method: 'PATCH', body: { task_id: null, reference_id: ref.id } });
            await api.q(`tasks?${api.u}&id=eq.${t.id}`, { method: 'PATCH', body: { dropped_at: now, completion_note: `Filed to Reference: ${a.topic || 'no topic'}`, reference_id: ref.id } });
            const { projects } = await api.lookups();
            return { decision: a.decision, reference: refOut(ref, projects, false) };
          }
          case 'slipbox': {
            const id = await api.q('rpc/slipbox_from_task', { method: 'POST', body: { task: t.id, title: a.title || null, body: null, source: a.source || '', owner: api.userId } });
            return { decision: a.decision, note_id: id, next: 'Saved as a fleeting slipbox note (slipbox tool); the item left the Inbox.' };
          }
          case 'reading': {
            const r = await api.q('rpc/reading_set', { method: 'POST', body: { task: t.id, state: 'up_next', rtype: a.type || null, owner: api.userId } });
            return { decision: a.decision, ...r };
          }
          default: throw new Error(`decision must be one of ${DECISIONS.join(', ')}`);
        }
      },
    },
    {
      name: 'delegate',
      description: 'Delegate an action: it waits on a person (not the user\'s next action) with a follow-up date, and stays in its project. Returns a drafted request (mailto/sms link) for the user to send themselves; nothing is sent. New names become people (add email/phone to include a link).',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' }, person: { type: 'string', description: 'Name or id' },
          follow_up: { type: ['string', 'integer'], description: 'YYYY-MM-DD, or days from today (default 7)' },
          email: { type: 'string' }, phone: { type: 'string' },
        },
        required: ['id', 'person'],
      },
      async run(api, a) {
        const t = await api.task(a.id);
        const p = await api.resolvePerson(a.person, { create: true, email: a.email, phone: a.phone });
        await api.q(`tasks?${api.u}&id=eq.${t.id}`, { method: 'PATCH', body: { waiting_on: p.id, delegated_at: new Date().toISOString(), follow_up_at: followIso(api, a.follow_up ?? 7), in_inbox: false, tickler: false, ...(t.tickler ? { defer_at: null } : {}) } });
        const [shaped] = await api.shape([await api.task(t.id)]);
        return { item: shaped, person: personOut(p), message: draft(p, t) };
      },
    },
    {
      name: 'list_waiting',
      description: 'Waiting For: open items delegated to (or tagged for) someone, grouped by person, soonest follow-up first, with follow_up_due when it is today or past. Offer to nudge (draft_nudge) or mark done.',
      inputSchema: { type: 'object', properties: { person: { type: 'string' }, due_only: { type: 'boolean', description: 'Only follow-ups due today or earlier' } } },
      async run(api, a) {
        const { people, isWaiting, personFor } = await api.waitingRule();
        const open = await api.q(`tasks?${api.u}&${OPEN}&agenda_for=is.null&select=*`);
        const only = a.person ? await api.resolvePerson(a.person) : null;
        const end = zonedToIso(today(api), 24, api.tz);
        const rows = open.filter((t) => isWaiting(t) && (!only || (personFor(t) || {}).id === only.id) && (!a.due_only || (t.follow_up_at && t.follow_up_at < end)))
          .sort((x, y) => String(x.follow_up_at || '9').localeCompare(String(y.follow_up_at || '9')));
        const shaped = await api.shape(rows);
        const by = {};
        rows.forEach((t, i) => { const p = personFor(t); const k = p ? p.name : 'Someone'; (by[k] = by[k] || []).push({ ...shaped[i], follow_up_due: !!(t.follow_up_at && t.follow_up_at < end) || undefined }); });
        return { count: rows.length, follow_ups_due: rows.filter((t) => t.follow_up_at && t.follow_up_at < end).length, by_person: by, people: people.length };
      },
    },
    {
      name: 'draft_nudge',
      description: 'Draft a follow-up (nudge) for a waiting item: returns the message and a mailto/sms link for the user to send. Nothing is sent. Optionally snooze the follow-up by days.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' }, snooze_days: { type: 'integer', description: 'Move the follow-up this many days from today' } }, required: ['id'] },
      async run(api, a) {
        const t = await api.task(a.id);
        const { personFor } = await api.waitingRule();
        const p = personFor(t);
        if (!p) throw new Error('That item is not waiting on anyone');
        if (a.snooze_days) await api.q(`tasks?${api.u}&id=eq.${t.id}`, { method: 'PATCH', body: { follow_up_at: followIso(api, Number(a.snooze_days)) } });
        return { person: personOut(p), message: draft(p, t, true), follow_up: a.snooze_days ? plusDays(api, Number(a.snooze_days)) : localDate(t.follow_up_at, api.tz) };
      },
    },
    {
      name: 'list_people',
      description: 'People the user delegates to or meets with, with how many items are waiting on them and on their agenda, their group (what they are to the user) and the projects they are on (with a role). arrange: group nests them by group (a last set with group null), project by the projects they are on (plus not_on_a_project).',
      inputSchema: { type: 'object', properties: { include_archived: { type: 'boolean' }, arrange: { type: 'string', enum: ['group', 'project'] } } },
      async run(api, a) {
        const people = await api.q(`people?${api.u}${a.include_archived ? '' : '&archived_at=is.null'}&order=name.asc&select=*`);
        const [{ isWaiting, personFor }, open, tie] = await Promise.all([api.waitingRule(), api.q(`tasks?${api.u}&${OPEN}&select=*`), ties(api)]);
        const out = people.map((p) => personOut(p, { ...tie(p), waiting: open.filter((t) => !t.agenda_for && isWaiting(t) && (personFor(t) || {}).id === p.id).length, agenda: open.filter((t) => t.agenda_for === p.id).length }));
        if (a.arrange === 'group') {
          const groups = (await allGroups(api)).filter((g) => !g.archived_at);
          return { groups: [...groups.map((g) => ({ group: g.name, id: g.id, people: out.filter((p) => p.group_id === g.id) })), { group: null, people: out.filter((p) => !p.group_id) }] };
        }
        if (a.arrange === 'project') {
          const { projects } = await api.lookups();
          const used = projects.filter((pr) => out.some((p) => p.projects.some((x) => x.id === pr.id))).sort((x, y) => x.name.localeCompare(y.name));
          return { projects: used.map((pr) => ({ project: pr.name, id: pr.id, people: out.filter((p) => p.projects.some((x) => x.id === pr.id)).map((p) => ({ ...p, role: (p.projects.find((x) => x.id === pr.id) || {}).role })) })), not_on_a_project: out.filter((p) => !p.projects.length) };
        }
        return { people: out };
      },
    },
    {
      name: 'save_person',
      description: 'Add or edit a person (name, email, phone, notes, tag, group, projects). A new person gets their own tag, "Waiting : Name" (made if needed), so items with it count as waiting on them; it follows a rename. tag links a different tag instead (made if it does not exist); null for none. group: what they are to the user (Crew, Suppliers, Family; a name or id, made if new; one group each; null for none). projects: replaces the projects they are on, each a project name or id or {project, role}. archived: true archives (never deleted).',
      inputSchema: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, email: { type: ['string', 'null'] }, phone: { type: ['string', 'null'] }, notes: { type: 'string' }, tag: { type: ['string', 'null'] }, group: { type: ['string', 'null'] }, projects: { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'object', properties: { project: { type: 'string' }, role: { type: 'string' } }, required: ['project'] }] } }, archived: { type: 'boolean' } } },
      async run(api, a) {
        const body = {};
        if (a.name !== undefined) body.name = String(a.name).trim();
        ['email', 'phone', 'notes'].forEach((k) => { if (a[k] !== undefined) body[k] = a[k] === null ? null : String(a[k]).trim(); });
        if (a.archived !== undefined) body.archived_at = a.archived ? new Date().toISOString() : null;
        if (a.group !== undefined) body.group_id = a.group === null ? null : await groupIdFor(api, a.group);
        if (a.tag !== undefined) {
          if (a.tag === null) body.tag_id = null;
          else { const { tags, tagLabel } = await api.lookups(); const g = tags.find((x) => x.id === a.tag || tagLabel(x).toLowerCase() === String(a.tag).toLowerCase()); body.tag_id = g ? g.id : await api.ensureTag(String(a.tag)); }
        }
        if (a.id) {
          const p = await api.resolvePerson(a.id, { archived: true });
          if (body.name && a.tag === undefined) await api.renamePersonTag(p, body.name); // their own tag follows the name
          const [row] = Object.keys(body).length ? await api.q(`people?${api.u}&id=eq.${p.id}`, { method: 'PATCH', prefer: 'return=representation', body }) : [p];
          if (Array.isArray(a.projects)) await setPersonProjects(api, row.id, a.projects);
          return personOut(row, (await ties(api))(row));
        }
        if (!body.name) throw new Error('name is required');
        if (a.tag === undefined) body.tag_id = await api.waitingTagFor(body.name); // their own tag, made if needed
        const [row] = await api.q('people', { method: 'POST', prefer: 'return=representation', body: { user_id: api.userId, ...body } });
        if (Array.isArray(a.projects)) await setPersonProjects(api, row.id, a.projects);
        return personOut(row, (await ties(api))(row));
      },
    },
    {
      name: 'people_groups',
      description: 'People groups on Waiting For: what someone is to the user (Crew, Suppliers, Family); one group per person, set with save_person group. list (default) shows them in order with member counts; save makes one (name) or renames (id + name) and can place it (position, 1-based); archive keeps it but files its people under no group; restore brings it back (its people are not put back). Never deleted.',
      inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['list', 'save', 'archive', 'restore'] }, id: { type: 'string' }, name: { type: 'string' }, position: { type: 'integer' }, include_archived: { type: 'boolean' } } },
      async run(api, a = {}) {
        const out = (g, people) => ({ id: g.id, name: g.name, people: people ? people.filter((p) => p.group_id === g.id && !p.archived_at).length : undefined, archived: !!g.archived_at || undefined });
        const action = a.action || 'list';
        if (action === 'list') {
          const [all, people] = await Promise.all([allGroups(api), api.q(`people?${api.u}&select=id,group_id,archived_at`)]);
          return { groups: all.filter((g) => !g.archived_at).map((g, i) => ({ ...out(g, people), position: i + 1 })), archived: a.include_archived ? all.filter((g) => g.archived_at).map((g) => out(g)) : undefined };
        }
        const find = async (ref) => { const all = await allGroups(api); const g = all.find((x) => x.id === ref) || all.find((x) => x.name.toLowerCase() === String(ref || '').trim().toLowerCase()); if (!g) throw new Error(`No group "${ref}"`); return g; };
        if (action === 'archive' || action === 'restore') {
          const g = await find(a.id || a.name);
          const [row] = await api.q(`people_groups?${api.u}&id=eq.${g.id}`, { method: 'PATCH', prefer: 'return=representation', body: { archived_at: action === 'archive' ? new Date().toISOString() : null } });
          return { group: out(row), note: action === 'archive' ? 'Kept, not deleted; its people are now under no group.' : undefined };
        }
        const name = a.name !== undefined ? String(a.name).trim().slice(0, 60) : undefined;
        let g = a.id ? await find(a.id) : null;
        if (!g && name) g = (await allGroups(api)).find((x) => !x.archived_at && x.name.toLowerCase() === name.toLowerCase()) || null;
        if (!g) {
          if (!name) throw new Error('name is required');
          const all = await allGroups(api); const sort = Math.max(-1, ...all.map((x) => x.sort || 0)) + 1;
          [g] = await api.q('people_groups', { method: 'POST', prefer: 'return=representation', body: { user_id: api.userId, name, sort } });
        } else if (name && name !== g.name) [g] = await api.q(`people_groups?${api.u}&id=eq.${g.id}`, { method: 'PATCH', prefer: 'return=representation', body: { name } });
        if (a.position) {
          const live = (await allGroups(api)).filter((x) => !x.archived_at && x.id !== g.id);
          live.splice(Math.max(0, Math.min(live.length, a.position - 1)), 0, g);
          for (let i = 0; i < live.length; i++) if (live[i].sort !== i) await api.q(`people_groups?${api.u}&id=eq.${live[i].id}`, { method: 'PATCH', body: { sort: i } });
        }
        return { group: out(g) };
      },
    },
    {
      name: 'add_agenda_item',
      description: 'Add something to discuss with a person (their Agenda). It is not a next action; it shows on their page and under calendar events with their name.',
      inputSchema: { type: 'object', properties: { person: { type: 'string' }, title: { type: 'string' }, notes: { type: 'string' } }, required: ['person', 'title'] },
      async run(api, a) {
        const p = await api.resolvePerson(a.person, { create: true });
        const [row] = await api.q('tasks', { method: 'POST', prefer: 'return=representation', body: { user_id: api.userId, title: String(a.title).trim(), notes: a.notes || '', agenda_for: p.id, in_inbox: false, source: 'mcp' } });
        return { person: p.name, item: (await api.shape([row]))[0] };
      },
    },
    {
      name: 'list_agenda',
      description: 'What to discuss with a person (their Agenda), plus what the user is waiting on them for. Use before a meeting or call.',
      inputSchema: { type: 'object', properties: { person: { type: 'string' } }, required: ['person'] },
      async run(api, a) {
        const p = await api.resolvePerson(a.person);
        const { isWaiting, personFor } = await api.waitingRule();
        const open = await api.q(`tasks?${api.u}&${OPEN}&select=*`);
        return {
          person: personOut(p),
          agenda: await api.shape(open.filter((t) => t.agenda_for === p.id)),
          waiting_on_them: await api.shape(open.filter((t) => !t.agenda_for && isWaiting(t) && (personFor(t) || {}).id === p.id)),
        };
      },
    },
    {
      name: 'tickle',
      description: 'Tickler: put an item out of sight until a day; at 6am that day it is back in the Inbox to clarify. Pass id to tickle an existing item (it leaves its project), or title to add a new one ("remind me about X on …"). date null takes it out of the tickler now.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' }, notes: { type: 'string' }, date: { type: ['string', 'null'], description: 'YYYY-MM-DD after today, or null' }, reference: { type: 'string', description: 'Reference item id to link ("look at this then")' } } },
      async run(api, a) {
        if (a.date !== null && (!a.date || !/^\d{4}-\d{2}-\d{2}$/.test(a.date))) throw new Error('date must be YYYY-MM-DD');
        if (a.date && a.date <= today(api)) throw new Error('Pick a day after today');
        const at = a.date ? zonedToIso(a.date, 6, api.tz) : null;
        let id = a.id;
        if (!id) {
          if (!a.title) throw new Error('Pass id or title');
          if (!a.date) throw new Error('date is required for a new item');
          const [row] = await api.q('tasks', { method: 'POST', prefer: 'return=representation', body: { user_id: api.userId, title: String(a.title).trim(), notes: a.notes || '', tickler: true, in_inbox: true, defer_at: at, reference_id: a.reference || null, source: 'mcp' } });
          id = row.id;
        } else {
          await api.task(id);
          await api.q(`tasks?${api.u}&id=eq.${id}`, { method: 'PATCH', body: a.date ? { tickler: true, in_inbox: true, defer_at: at, project_id: null, parent_id: null } : { defer_at: null } });
        }
        return { item: (await api.shape([await api.task(id)]))[0], back_on: a.date || 'now (in the Inbox)' };
      },
    },
    {
      name: 'list_tickler',
      description: 'Items waiting in the tickler, by the day they come back to the Inbox.',
      inputSchema: { type: 'object', properties: {} },
      async run(api) {
        const rows = await api.q(`tasks?${api.u}&${OPEN}&tickler=is.true&defer_at=gt.${new Date().toISOString()}&order=defer_at.asc&select=*`);
        const shaped = await api.shape(rows);
        const by = {};
        shaped.forEach((t) => { (by[t.defer] = by[t.defer] || []).push(t); });
        return { count: rows.length, by_day: by };
      },
    },
    {
      name: 'search_reference',
      description: 'Search the user\'s Reference (non-actionable information: codes, warranties, permits, notes) by words, topic or project. Hidden values (codes) are only included with reveal: true; use it when the user asks for the value.',
      inputSchema: { type: 'object', properties: { query: { type: 'string' }, topic: { type: 'string' }, project: { type: 'string' }, reveal: { type: 'boolean' }, include_archived: { type: 'boolean' }, limit: { type: 'integer', default: 50 } } },
      async run(api, a) {
        const f = [api.u, 'select=*', 'order=topic.asc,title.asc', `limit=${Math.min(+a.limit || 50, 200)}`];
        if (!a.include_archived) f.push('archived_at=is.null');
        if (a.topic) f.push(`topic=ilike.${encodeURIComponent(a.topic)}`);
        if (a.project) f.push(`project_id=eq.${await api.resolveProject(a.project)}`);
        String(a.query || '').toLowerCase().replace(/[%,()*\\]/g, ' ').split(/\s+/).filter(Boolean).forEach((w) => {
          const e = encodeURIComponent(w);
          f.push(`or=(title.ilike.*${e}*,body.ilike.*${e}*,topic.ilike.*${e}*)`);
        });
        const [rows, { projects }] = await Promise.all([api.q(`reference_items?${f.join('&')}`), api.lookups()]);
        const files = rows.length ? await api.q(`attachments?${api.u}&reference_id=${inList(rows.map((r) => r.id))}&archived_at=is.null&select=id,reference_id,name,size,mime`) : [];
        return { count: rows.length, items: rows.map((r) => ({ ...refOut(r, projects, !!a.reveal), attachments: files.some((x) => x.reference_id === r.id) ? files.filter((x) => x.reference_id === r.id).map(({ reference_id, ...x }) => x) : undefined })) };
      },
    },
    {
      name: 'save_reference',
      description: 'Add or edit a Reference item (title, notes, topic, project it supports, hidden_value for a code). archived: true archives it (never deleted).',
      inputSchema: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' }, notes: { type: 'string' }, topic: { type: 'string' }, project: { type: ['string', 'null'] }, hidden_value: { type: ['string', 'null'] }, archived: { type: 'boolean' } } },
      async run(api, a) {
        const body = {};
        if (a.title !== undefined) body.title = String(a.title).trim();
        if (a.notes !== undefined) body.body = String(a.notes);
        if (a.topic !== undefined) body.topic = String(a.topic).trim();
        if (a.project !== undefined) body.project_id = a.project === null ? null : await api.resolveProject(a.project);
        if (a.hidden_value !== undefined) body.secret_value = a.hidden_value === null || a.hidden_value === '' ? null : String(a.hidden_value);
        if (a.archived !== undefined) body.archived_at = a.archived ? new Date().toISOString() : null;
        const { projects } = await api.lookups();
        if (a.id) {
          const [row] = await api.q(`reference_items?${api.u}&id=eq.${a.id}`, { method: 'PATCH', prefer: 'return=representation', body });
          if (!row) throw new Error('Reference item not found');
          return refOut(row, projects, false);
        }
        if (!body.title) throw new Error('title is required');
        const [row] = await api.q('reference_items', { method: 'POST', prefer: 'return=representation', body: { user_id: api.userId, ...body } });
        return refOut(row, projects, false);
      },
    },
  ];
}
