import type { Message } from "./types.ts";

/** Carry the conversation and tool results, without another model's private wire state. */
export function historyForModelSwitch(messages: readonly Message[]): Message[] {
  return messages.map(message => ({
    ...message,
    content: message.content.map(block => {
      if (block.type !== "tool-call") return block;
      const { reasoning: _reasoning, ...call } = block;
      return call;
    }),
  }));
}
