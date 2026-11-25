import { newId } from './storage';
import { completeTask, dayEvents, findClashes, freeSlots, hhmm, parseLocal } from './dates';
import { deviceEvents } from './calendar';

const REPEAT_PROP = { type: 'string', enum: ['none', 'daily', 'weekly', 'monthly'], description: 'How often it repeats; default none' };

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-5-5';

export const TOOLS = [
  {
    name: 'add_task',
    description: 'Add a to-do task for the user. Use for things they need to do.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        due: { type: 'string', description: 'Optional due date/time, local ISO 8601 without timezone (e.g. 2026-11-24 or 2026-11-24T15:00)' },
        repeat: REPEAT_PROP,
        priority: { type: 'string', enum: ['normal', 'high'], description: 'high = urgent / important' },
        assignee_name: { type: 'string', description: 'Person this is delegated to' },
        assignee_number: { type: 'string', description: 'Their phone number with country code, if known' },
      },
      required: ['title'],
    },
  },
  { name: 'list_tasks', description: 'List all tasks with ids and done status.', input_schema: { type: 'object', properties: {} } },
  {
    name: 'complete_task',
    description: 'Mark a task as done by id.',
    input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'add_event',
    description: 'Add a calendar event / appointment / meeting.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        start: { type: 'string', description: 'Local ISO 8601 start without timezone (2026-11-24T15:00, or 2026-11-24 for all-day)' },
        location: { type: 'string' },
        repeat: REPEAT_PROP,
        attendees: { type: 'string', description: 'Comma-separated names of who is attending' },
        agenda: { type: 'string', description: 'Agenda / talking points' },
      },
      required: ['title', 'start'],
    },
  },
  { name: 'list_events', description: "List all calendar events: the ones saved in myPA plus the phone's own calendar for the next two weeks (source 'calendar', read-only).", input_schema: { type: 'object', properties: {} } },
  {
    name: 'add_note',
    description: 'Save a note or piece of information for the user to remember.',
    input_schema: { type: 'object', properties: { title: { type: 'string', description: 'Optional short title' }, text: { type: 'string' } }, required: ['text'] },
  },
  { name: 'list_notes', description: 'List all saved notes.', input_schema: { type: 'object', properties: {} } },
  {
    name: 'add_waiting',
    description: 'Track something the user is waiting on from someone else (a reply, a document, a decision) with an optional chase date.',
    input_schema: {
      type: 'object',
      properties: {
        what: { type: 'string', description: 'What is awaited' },
        who: { type: 'string', description: 'Who owes it' },
        number: { type: 'string', description: 'Their phone number, if known' },
        due: { type: 'string', description: 'Date to chase them (YYYY-MM-DD)' },
      },
      required: ['what'],
    },
  },
  { name: 'list_waiting', description: 'List everything the user is waiting on from others.', input_schema: { type: 'object', properties: {} } },
  { name: 'resolve_waiting', description: 'Mark a waiting-on item as received / resolved.', input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  {
    name: 'add_person',
    description: 'Save a person the user deals with (role, notes, how often to keep in touch).',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        number: { type: 'string' },
        role: { type: 'string', description: 'e.g. CFO at Acme, investor, driver' },
        notes: { type: 'string', description: 'Things worth remembering about them' },
        every_days: { type: 'number', description: 'Remind the user to check in every N days; 0 = never' },
      },
      required: ['name'],
    },
  },
  { name: 'list_people', description: 'List the saved people with their notes.', input_schema: { type: 'object', properties: {} } },
  {
    name: 'update_person',
    description: "Change a person's details, append to their notes, or record that the user just spoke with them.",
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        number: { type: 'string' },
        role: { type: 'string' },
        notes: { type: 'string', description: 'Replaces the notes' },
        add_note: { type: 'string', description: 'Appended to the existing notes' },
        every_days: { type: 'number' },
        contacted: { type: 'boolean', description: 'true = the user just spoke with them today' },
      },
      required: ['id'],
    },
  },
  {
    name: 'check_schedule',
    description: "Show one day's meetings (including the phone calendar), clashes, and free slots. Use before proposing or booking a time.",
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD' },
        minutes: { type: 'number', description: 'Minimum length of free slot to find; default 30' },
      },
      required: ['date'],
    },
  },
  {
    name: 'draft_message',
    description: 'Show the user a ready-to-send message with Send buttons (SMS / WhatsApp). It is NOT sent until the user taps a button, so never say it was sent.',
    input_schema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: "Recipient's name (matched against saved people) or phone number" },
        text: { type: 'string' },
        channel: { type: 'string', enum: ['sms', 'whatsapp'], description: 'Preferred channel; default sms' },
      },
      required: ['to', 'text'],
    },
  },
  {
    name: 'update_item',
    description: 'Change an existing task, event or note (e.g. reschedule, rename). Only pass the fields to change.',
    input_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['task', 'event', 'note'] },
        id: { type: 'string' },
        title: { type: 'string' },
        due: { type: 'string', description: 'Task due, ISO 8601; empty string clears it' },
        start: { type: 'string', description: 'Event start, ISO 8601' },
        location: { type: 'string' },
        repeat: REPEAT_PROP,
        text: { type: 'string', description: 'Note text' },
        priority: { type: 'string', enum: ['normal', 'high'], description: 'Task priority' },
        assignee_name: { type: 'string', description: 'Task delegate; empty string clears' },
        assignee_number: { type: 'string' },
        attendees: { type: 'string', description: 'Event attendees' },
        agenda: { type: 'string', description: 'Event agenda' },
        meeting_notes: { type: 'string', description: 'What was discussed / decided at the event' },
      },
      required: ['kind', 'id'],
    },
  },
  {
    name: 'delete_item',
    description: 'Delete a task, event, or note by id.',
    input_schema: {
      type: 'object',
      properties: { kind: { type: 'string', enum: ['task', 'event', 'note'] }, id: { type: 'string' } },
      required: ['kind', 'id'],
    },
  },
];

export function runTool(name, input, data) {
  // returns { result, data } — data is a new object if modified
  const next = { ...data, tasks: [...data.tasks], notes: [...data.notes], events: [...data.events], waiting: [...(data.waiting || [])], people: [...(data.people || [])] };
  switch (name) {
    case 'add_task': {
      const t = { id: newId(), title: input.title, due: input.due || null, repeat: input.repeat || 'none', done: false };
      if (input.priority === 'high') t.priority = 'high';
      if (input.assignee_name) t.assignee = { name: input.assignee_name, number: input.assignee_number || '' };
      next.tasks.push(t);
      return { result: `Task added: ${JSON.stringify(t)}`, data: next };
    }
    case 'list_tasks':
      return { result: JSON.stringify(data.tasks), data };
    case 'complete_task': {
      const t = next.tasks.find((x) => x.id === input.id);
      if (!t) return { result: 'Task not found', data };
      const done = completeTask(t);
      next.tasks = next.tasks.map((x) => (x.id === input.id ? done : x));
      return { result: done.done ? 'Task marked done' : `Repeating task completed; next due ${done.due}`, data: next };
    }
    case 'add_event': {
      const e = { id: newId(), title: input.title, start: input.start, location: input.location || '', repeat: input.repeat || 'none', attendees: input.attendees || '', agenda: input.agenda || '', meetingNotes: '' };
      next.events.push(e);
      return { result: `Event added: ${JSON.stringify(e)}`, data: next };
    }
    case 'list_events':
      return { result: JSON.stringify([...data.events, ...deviceEvents()]), data };
    case 'add_note': {
      const now = new Date().toISOString();
      const n = { id: newId(), title: input.title || '', text: input.text, created: now, updated: now };
      next.notes.push(n);
      return { result: `Note saved: ${JSON.stringify(n)}`, data: next };
    }
    case 'list_notes':
      return { result: JSON.stringify(data.notes), data };
    case 'update_item': {
      const key = { task: 'tasks', event: 'events', note: 'notes' }[input.kind];
      if (!key || !next[key].some((x) => x.id === input.id)) return { result: 'Item not found', data };
      const fields = { task: ['title', 'due', 'repeat', 'priority'], event: ['title', 'start', 'location', 'repeat', 'attendees', 'agenda'], note: ['title', 'text'] }[input.kind];
      const patch = {};
      for (const f of fields) if (input[f] !== undefined) patch[f] = f === 'due' && input[f] === '' ? null : input[f];
      if (input.kind === 'event' && input.meeting_notes !== undefined) patch.meetingNotes = input.meeting_notes;
      if (input.kind === 'task' && input.assignee_name !== undefined) {
        patch.assignee = input.assignee_name ? { name: input.assignee_name, number: input.assignee_number || '' } : null;
      }
      next[key] = next[key].map((x) => (x.id === input.id ? { ...x, ...patch } : x));
      return { result: `Updated: ${JSON.stringify(next[key].find((x) => x.id === input.id))}`, data: next };
    }
    case 'delete_item': {
      const key = { task: 'tasks', event: 'events', note: 'notes' }[input.kind];
      if (!key || !next[key].some((x) => x.id === input.id)) return { result: 'Item not found', data };
      next[key] = next[key].filter((x) => x.id !== input.id);
      return { result: 'Deleted', data: next };
    }
    case 'add_waiting': {
      const w = { id: newId(), what: input.what, who: input.who || '', number: input.number || '', due: input.due || null, done: false, created: new Date().toISOString() };
      next.waiting.push(w);
      return { result: `Now tracking: ${JSON.stringify(w)}`, data: next };
    }
    case 'list_waiting':
      return { result: JSON.stringify(next.waiting.filter((w) => !w.done)), data };
    case 'resolve_waiting': {
      if (!next.waiting.some((w) => w.id === input.id)) return { result: 'Not found', data };
      next.waiting = next.waiting.map((w) => (w.id === input.id ? { ...w, done: true } : w));
      return { result: 'Marked as received', data: next };
    }
    case 'add_person': {
      const p = { id: newId(), name: input.name, number: input.number || '', role: input.role || '', notes: input.notes || '', every: Math.max(0, Math.round(input.every_days || 0)), last: null, created: new Date().toISOString() };
      next.people.push(p);
      return { result: `Saved: ${JSON.stringify(p)}`, data: next };
    }
    case 'list_people':
      return { result: JSON.stringify(data.people || []), data };
    case 'update_person': {
      if (!next.people.some((p) => p.id === input.id)) return { result: 'Person not found', data };
      next.people = next.people.map((p) => {
        if (p.id !== input.id) return p;
        const q = { ...p };
        for (const f of ['name', 'number', 'role', 'notes']) if (input[f] !== undefined) q[f] = input[f];
        if (input.add_note) q.notes = (q.notes ? q.notes + '\n' : '') + `${new Date().toISOString().slice(0, 10)}: ${input.add_note}`;
        if (input.every_days !== undefined) q.every = Math.max(0, Math.round(input.every_days));
        if (input.contacted) q.last = new Date().toISOString().slice(0, 10);
        return q;
      });
      return { result: `Updated: ${JSON.stringify(next.people.find((p) => p.id === input.id))}`, data: next };
    }
    case 'check_schedule': {
      const day = parseLocal(input.date);
      if (!day) return { result: 'Bad date, use YYYY-MM-DD', data };
      const evs = dayEvents(data, day, deviceEvents());
      const clashes = findClashes(evs);
      const slots = freeSlots(evs, day, input.minutes || 30);
      return {
        result: JSON.stringify({
          meetings: evs.map((e) => ({ title: e.title, from: e.allDay ? 'all day' : hhmm(e.start), to: e.allDay ? '' : hhmm(e.end), source: e.source })),
          clashes: clashes.map((c) => `${c.a.title} ${c.kind === 'overlap' ? 'overlaps' : 'is back-to-back with'} ${c.b.title}`),
          free_slots_9_to_18: slots.map((x) => `${hhmm(x.from)}-${hhmm(x.to)}`),
        }),
        data,
      };
    }
    case 'draft_message': {
      const q = (input.to || '').trim().toLowerCase();
      const person = (data.people || []).find((p) => p.name && (p.name.toLowerCase() === q || p.name.toLowerCase().includes(q) || (q && q.includes(p.name.toLowerCase()))));
      const raw = /[0-9]{6,}/.test(input.to || '') ? input.to : person?.number || '';
      const draft = { to: person?.name || input.to, number: raw, text: input.text, channel: input.channel === 'whatsapp' ? 'whatsapp' : 'sms' };
      return { result: 'Draft is shown to the user with Send buttons. It has NOT been sent; tell them to review and tap Send.', data, draft };
    }
    default:
      return { result: `Unknown tool ${name}`, data };
  }
}

export function systemPrompt(userName, assistantName) {
  const now = new Date();
  return `You are ${assistantName || 'Jolly'}, a personal assistant (inside the myPA app) who works as ${userName ? userName + "'s" : "the user's"} secretary.
Current date/time: ${now.toString()} (ISO: ${now.toISOString()}).
Be warm, concise, and proactive. Use your tools to manage tasks, calendar events and notes whenever the user asks you to remember, schedule or track something — don't just say you did it. Resolve relative dates ("tomorrow", "next Friday") into concrete dates using the current time. Before answering questions about what's on their plate, call the list tools. Always reply in the same language the user writes in (for example Kiswahili, English, or a mix); if they switch language, switch with them. Keep item titles in the language the user used. Ask a short clarifying question only if essential info (like a time) is missing and can't be reasonably assumed.
You work like an executive assistant to a busy CEO: protect their time, prepare them, and chase loose ends. Before proposing or booking a time, call check_schedule and avoid clashes. When asked to prep for a meeting, check the event, the attendees in list_people, and list_waiting, then give a short brief (who, last context, open items, suggested questions). After a meeting, ask what was decided, then save it with update_item (meeting_notes), create tasks for the user's actions, and add_waiting for what others owe. When the user says someone owes them something, use add_waiting with a sensible chase date. Learn about people with add_person / update_person (add_note) whenever they share useful context. For messages to others, use draft_message (never claim it was sent). Mark urgent things with priority high.`;
}

/**
 * Sends the conversation to Claude, running any tool calls locally until a final answer.
 * messages: Anthropic-format message list (mutated copy returned).
 * Returns { messages, data, reply }.
 */
export async function askClaude({ apiKey, userName, assistantName, messages, data }) {
  let convo = [...messages];
  let current = data;
  const drafts = [];

  for (let i = 0; i < 8; i++) {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        system: systemPrompt(userName, assistantName),
        tools: TOOLS,
        messages: convo,
      }),
    });

    if (!res.ok) {
      let detail = '';
      try {
        detail = (await res.json())?.error?.message || '';
      } catch {}
      throw new Error(`Claude API error ${res.status}${detail ? ': ' + detail : ''}`);
    }

    const body = await res.json();
    convo.push({ role: 'assistant', content: body.content });

    if (body.stop_reason !== 'tool_use') {
      const reply = body.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      return { messages: convo, data: current, reply, drafts };
    }

    const results = [];
    for (const block of body.content) {
      if (block.type !== 'tool_use') continue;
      const out = runTool(block.name, block.input || {}, current);
      current = out.data;
      if (out.draft) drafts.push(out.draft);
      results.push({ type: 'tool_result', tool_use_id: block.id, content: out.result });
    }
    convo.push({ role: 'user', content: results });
  }

  return { messages: convo, data: current, reply: 'Sorry, I got stuck. Please try again.', drafts };
}
