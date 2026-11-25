import { TOOLS, runTool, systemPrompt } from './claude';
import { newId } from './storage';

export const DEFAULT_GEMINI_MODEL = 'gemini-flash-latest';
const BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';

// Gemini rejects an object schema with no properties, so no-argument tools go without `parameters`.
const DECLARATIONS = TOOLS.map((t) => {
  const d = { name: t.name, description: t.description };
  if (Object.keys(t.input_schema.properties || {}).length) d.parameters = t.input_schema;
  return d;
});

/** Converts the app's stored (Claude-format) history into Gemini `contents`. */
function toContents(messages) {
  const names = {};
  const out = [];
  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] });
      continue;
    }
    const parts = [];
    for (const b of m.content || []) {
      if (b.type === 'text' && b.text) parts.push({ text: b.text });
      else if (b.type === 'tool_use') {
        names[b.id] = b.name;
        parts.push({
          functionCall: { name: b.name, args: b.input || {} },
          thoughtSignature: b.sig || 'skip_thought_signature_validator', // required for Gemini 3 history written by another model
        });
      } else if (b.type === 'tool_result') {
        parts.push({ functionResponse: { name: names[b.tool_use_id] || 'tool', response: { result: String(b.content) } } });
      }
    }
    if (parts.length) out.push({ role: m.role === 'assistant' ? 'model' : 'user', parts });
  }
  return out;
}

/**
 * Same contract as askClaude, but talks to Gemini. History stays in the app's Claude-style format,
 * so switching provider mid-conversation works.
 */
export async function askGemini({ apiKey, model, userName, assistantName, messages, data }) {
  let convo = [...messages];
  let current = data;
  const drafts = [];

  for (let i = 0; i < 8; i++) {
    const res = await fetch(`${BASE}${encodeURIComponent(model || DEFAULT_GEMINI_MODEL)}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt(userName, assistantName) }] },
        contents: toContents(convo),
        tools: [{ functionDeclarations: DECLARATIONS }],
      }),
    });

    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json())?.error?.message || ''; } catch {}
      throw new Error(`Gemini API error ${res.status}${detail ? ': ' + detail : ''}`);
    }

    const body = await res.json();
    const cand = body.candidates?.[0];
    const parts = cand?.content?.parts || [];
    if (!parts.length) {
      const why = body.promptFeedback?.blockReason || cand?.finishReason;
      throw new Error(`Gemini returned no answer${why ? ' (' + why + ')' : ''}.`);
    }

    const blocks = [];
    const calls = [];
    for (const p of parts) {
      if (p.thought) continue;
      if (p.functionCall) {
        const b = { type: 'tool_use', id: newId(), name: p.functionCall.name, input: p.functionCall.args || {}, sig: p.thoughtSignature };
        blocks.push(b);
        calls.push(b);
      } else if (p.text) blocks.push({ type: 'text', text: p.text });
    }
    convo.push({ role: 'assistant', content: blocks });

    if (!calls.length) {
      const reply = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      return { messages: convo, data: current, reply, drafts };
    }

    const results = [];
    for (const c of calls) {
      const out = runTool(c.name, c.input, current);
      current = out.data;
      if (out.draft) drafts.push(out.draft);
      results.push({ type: 'tool_result', tool_use_id: c.id, content: out.result });
    }
    convo.push({ role: 'user', content: results });
  }

  return { messages: convo, data: current, reply: 'Sorry, I got stuck. Please try again.', drafts };
}
