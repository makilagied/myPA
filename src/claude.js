import { newId } from './storage';
import { completeTask } from './dates';

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
      },
      required: ['title', 'start'],
    },
  },
  { name: 'list_events', description: 'List all calendar events.', input_schema: { type: 'object', properties: {} } },
  {
    name: 'add_note',
    description: 'Save a note or piece of information for the user to remember.',
    input_schema: { type: 'object', properties: { title: { type: 'string', description: 'Optional short title' }, text: { type: 'string' } }, required: ['text'] },
  },
  { name: 'list_notes', description: 'List all saved notes.', input_schema: { type: 'object', properties: {} } },
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
  const next = { ...data, tasks: [...data.tasks], notes: [...data.notes], events: [...data.events] };
  switch (name) {
    case 'add_task': {
      const t = { id: newId(), title: input.title, due: input.due || null, repeat: input.repeat || 'none', done: false };
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
      const e = { id: newId(), title: input.title, start: input.start, location: input.location || '', repeat: input.repeat || 'none' };
      next.events.push(e);
      return { result: `Event added: ${JSON.stringify(e)}`, data: next };
    }
    case 'list_events':
      return { result: JSON.stringify(data.events), data };
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
      const fields = { task: ['title', 'due', 'repeat'], event: ['title', 'start', 'location', 'repeat'], note: ['title', 'text'] }[input.kind];
      const patch = {};
      for (const f of fields) if (input[f] !== undefined) patch[f] = f === 'due' && input[f] === '' ? null : input[f];
      next[key] = next[key].map((x) => (x.id === input.id ? { ...x, ...patch } : x));
      return { result: `Updated: ${JSON.stringify(next[key].find((x) => x.id === input.id))}`, data: next };
    }
    case 'delete_item': {
      const key = { task: 'tasks', event: 'events', note: 'notes' }[input.kind];
      if (!key || !next[key].some((x) => x.id === input.id)) return { result: 'Item not found', data };
      next[key] = next[key].filter((x) => x.id !== input.id);
      return { result: 'Deleted', data: next };
    }
    default:
      return { result: `Unknown tool ${name}`, data };
  }
}

export function systemPrompt(userName, assistantName) {
  const now = new Date();
  return `You are ${assistantName || 'Jolly'}, a personal assistant (inside the myPA app) who works as ${userName ? userName + "'s" : "the user's"} secretary.
Current date/time: ${now.toString()} (ISO: ${now.toISOString()}).
Be warm, concise, and proactive. Use your tools to manage tasks, calendar events and notes whenever the user asks you to remember, schedule or track something — don't just say you did it. Resolve relative dates ("tomorrow", "next Friday") into concrete dates using the current time. Before answering questions about what's on their plate, call the list tools. Always reply in the same language the user writes in (for example Kiswahili, English, or a mix); if they switch language, switch with them. Keep item titles in the language the user used. Ask a short clarifying question only if essential info (like a time) is missing and can't be reasonably assumed.`;
}

/**
 * Sends the conversation to Claude, running any tool calls locally until a final answer.
 * messages: Anthropic-format message list (mutated copy returned).
 * Returns { messages, data, reply }.
 */
export async function askClaude({ apiKey, userName, assistantName, messages, data }) {
  let convo = [...messages];
  let current = data;

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
      return { messages: convo, data: current, reply };
    }

    const results = [];
    for (const block of body.content) {
      if (block.type !== 'tool_use') continue;
      const out = runTool(block.name, block.input || {}, current);
      current = out.data;
      results.push({ type: 'tool_result', tool_use_id: block.id, content: out.result });
    }
    convo.push({ role: 'user', content: results });
  }

  return { messages: convo, data: current, reply: 'Sorry, I got stuck. Please try again.' };
}
