/**
 * Read complete tool arguments. Some compatible servers put literal line breaks in
 * JSON strings. Escaping those preserves their exact text; completing a truncated
 * string, inventing a quote or changing an escape would guess what to write.
 */
export function parseToolArguments(raw: string): { input: Record<string, unknown>; normalized: boolean } | null {
  const object = (text: string): Record<string, unknown> | null => {
    try {
      const value: unknown = JSON.parse(text);
      return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown> : null;
    } catch { return null; }
  };
  const text = raw.trim() || "{}";
  const strict = object(text);
  if (strict !== null) return { input: strict, normalized: false };
  // A complete JSON code fence is only a wrapper, never file contents.
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(text);
  const source = fenced?.[1] ?? text;
  let repaired = "";
  let quoted = false;
  let escaped = false;
  for (const character of source) {
    if (escaped) {
      repaired += character;
      escaped = false;
      continue;
    }
    if (quoted && character === "\\") {
      escaped = true;
      repaired += character;
      continue;
    }
    if (character === '"') quoted = !quoted;
    repaired += quoted && character.charCodeAt(0) < 32
      ? `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}` : character;
  }
  if (quoted || escaped) return null;
  const input = object(repaired);
  return input === null ? null : { input, normalized: true };
}
