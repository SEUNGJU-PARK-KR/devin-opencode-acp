import type { ToolCallBlock, ToolDefinition } from "../types.ts";

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The complete JSON object or array at the start of `text` and what follows it, or null. */
function leadingJson(text: string): { value: unknown; rest: string } | null {
  if (text[0] !== "{" && text[0] !== "[") return null;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index]!;
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === "{" || character === "[") depth += 1;
    else if ((character === "}" || character === "]") && --depth === 0) {
      return { value: JSON.parse(text.slice(0, index + 1)) as unknown, rest: text.slice(index + 1) };
    }
  }
  return null;
}

/**
 * The envelopes a reply opens with - bare JSON or `<tool_call>` tags, one after another - or
 * null when it opens with anything else. Throws on malformed JSON.
 */
function leadingEnvelopes(source: string): unknown[] | null {
  const values: unknown[] = [];
  let rest = source;
  for (;;) {
    rest = rest.trimStart();
    const tagged = /^<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/.exec(rest);
    if (tagged !== null) {
      const parsed: unknown = JSON.parse(tagged[1]!.trim());
      values.push(...(Array.isArray(parsed) ? parsed : [parsed]));
      rest = rest.slice(tagged[0].length);
      continue;
    }
    const bare = leadingJson(rest);
    if (bare === null) break;
    values.push(...(Array.isArray(bare.value) ? bare.value : [bare.value]));
    rest = bare.rest;
  }
  return values.length === 0 ? null : values;
}

/** A call envelope's parts, or null when `value` is ordinary data rather than a call. */
function envelopeOf(value: unknown): { name: string; args: unknown } | null {
  if (!record(value)) return null;
  const nested = record(value["function"]);
  const envelope = nested ? value["function"] as Record<string, unknown> : value;
  const allowed = nested ? ["id", "type", "function"] : ["id", "name", "arguments"];
  if (Object.keys(value).some((key) => !allowed.includes(key))) return null;
  if (nested && Object.keys(envelope).some((key) => key !== "name" && key !== "arguments")) return null;
  if (value["type"] !== undefined && value["type"] !== "function") return null;
  const name = envelope["name"];
  if (typeof name !== "string" || !/^[\w.-]+$/.test(name) || !("arguments" in envelope)) return null;
  return { name, args: envelope["arguments"] };
}

/** The arguments as an object, or null when they are not one. */
function argumentsOf(args: unknown): Record<string, unknown> | null {
  try {
    const parsed: unknown = typeof args === "string" ? JSON.parse(args) as unknown : args;
    return record(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Calls for the agent to run, with correction feedback for invented tools and bad arguments. */
function callsFrom(values: readonly unknown[], tools: readonly ToolDefinition[], idPrefix: string): ToolCallBlock[] | null {
  if (values.length === 0 || values.length > 32) return null;
  const available = new Set(tools.map((tool) => tool.name));
  const calls: ToolCallBlock[] = [];
  for (const [index, value] of values.entries()) {
    const envelope = envelopeOf(value);
    if (envelope === null) return null;
    const input = argumentsOf(envelope.args);
    let inputError: string | undefined = input === null
      ? "Tool not run: the local model returned invalid JSON tool arguments. Retry with one call and an arguments object matching the tool schema."
      : undefined;
    if (!available.has(envelope.name)) {
      inputError = `No tool named ${JSON.stringify(envelope.name)} is available. Choose an exact name from the provided tools: ${[...available].join(", ")}. To create a file, use propose_edit with path and contents when it is available.`;
    }
    calls.push({ type: "tool-call", id: `${idPrefix}_${index}`, name: envelope.name, input: input ?? {}, ...(inputError === undefined ? {} : { inputError }) });
  }
  return calls;
}

/**
 * Some local models print their call envelope in content instead of tool_calls.
 * Accept a reply that opens with complete calls, bare or in `<tool_call>` tags; the prose
 * after them is dropped, since it describes results the calls have not produced yet. A
 * reply that opens with prose, ordinary JSON or a partly generated envelope stays text.
 * Calls in json code fences are lifted out as the reply streams (createFencedCallFilter).
 * Recovered calls still pass through the agent's normal runner, review policy and Undo.
 */
export function localToolCalls(text: string, tools: readonly ToolDefinition[], idPrefix: string): ToolCallBlock[] | null {
  let values: unknown[] | null;
  try {
    values = leadingEnvelopes(text.trim());
  } catch {
    return null;
  }
  return values === null ? null : callsFrom(values, tools, idPrefix);
}

const FENCE_OPEN = "```json";

/** The envelopes a json fence's body holds, when every one is a complete call to a real tool. */
function fencedCalls(body: string, available: ReadonlySet<string>): unknown[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.trim()) as unknown;
  } catch {
    return null;
  }
  const values = Array.isArray(parsed) ? parsed : [parsed];
  const real = values.length > 0 && values.every((value) => {
    const envelope = envelopeOf(value);
    return envelope !== null && available.has(envelope.name) && argumentsOf(envelope.args) !== null;
  });
  return real ? values : null;
}

export interface FencedCallFilter {
  /** Take a streamed fragment; returns the text that can be shown now. */
  push(fragment: string): string;
  /**
   * At the end of the reply: text still held back, the calls found, and everything kept from
   * view (`raw`) - shown as written when the calls cannot run, such as a reply cut off.
   */
  finish(): { readonly text: string; readonly calls: ToolCallBlock[]; readonly raw: string };
}

/**
 * Streams a local model's prose while lifting out the calls it writes in json code fences.
 *
 * qwen2.5-coder:7b through Ollama (measured in the built app) narrates, then acts in a
 * fence: "Let's update the subtotal function." followed by ```json {"name": "edit_file", ...}```
 * - with exactly the right edit inside - and then "After this change, run the tests" and a
 * second fenced call. Shown as text, nothing ran. Here prose streams as it arrives; a json
 * fence is held until it closes, and becomes a call when every envelope in it names a tool
 * the model was offered, with an arguments object. Anything else in a fence - a config
 * file, an invented tool - is released as the text it was. After the first call, the rest
 * of the reply is held: its further fenced calls are taken in order, and its prose, which
 * describes results that do not exist yet, is dropped.
 */
export function createFencedCallFilter(tools: readonly ToolDefinition[], idPrefix: string): FencedCallFilter {
  const available = new Set(tools.map((tool) => tool.name));
  let held = "";
  let swallowed = "";
  const values: unknown[] = [];

  /** Release what can be shown, stopping at an unclosed fence or after the first call. */
  function release(): string {
    let shown = "";
    while (values.length === 0) {
      const open = /```json/i.exec(held)?.index ?? -1;
      if (open === -1) {
        // Keep back a tail that could still grow into "```json".
        let keep = 0;
        for (let length = Math.min(FENCE_OPEN.length - 1, held.length); length > 0; length--) {
          if (FENCE_OPEN.startsWith(held.slice(-length).toLowerCase())) {
            keep = length;
            break;
          }
        }
        shown += held.slice(0, held.length - keep);
        held = held.slice(held.length - keep);
        return shown;
      }
      shown += held.slice(0, open);
      held = held.slice(open);
      const bodyStart = /^```json[ \t]*\r?\n?/i.exec(held)![0].length;
      const close = held.indexOf("```", bodyStart);
      if (close === -1) return shown;
      const calls = fencedCalls(held.slice(bodyStart, close), available);
      if (calls === null) {
        shown += held.slice(0, close + 3);
        held = held.slice(close + 3);
      } else {
        values.push(...calls);
        swallowed += held.slice(0, close + 3);
        held = held.slice(close + 3);
      }
    }
    return shown;
  }

  return {
    push(fragment) {
      held += fragment;
      return release();
    },
    finish() {
      if (values.length === 0) {
        const text = held;
        held = "";
        return { text, calls: [], raw: text };
      }
      // After the first call: take the remaining fenced calls in order, drop the narration.
      for (const match of held.matchAll(/```json[ \t]*\r?\n?([\s\S]*?)```/gi)) {
        const calls = fencedCalls(match[1]!, available);
        if (calls !== null) values.push(...calls);
      }
      const raw = swallowed + held;
      held = "";
      swallowed = "";
      return { text: "", calls: callsFrom(values, tools, idPrefix) ?? [], raw };
    },
  };
}
