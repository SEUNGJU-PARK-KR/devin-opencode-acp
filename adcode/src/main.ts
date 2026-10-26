/**
 * adcode-acp — serves ADCode's assistant over the Agent Client Protocol
 * (newline-delimited JSON-RPC on stdio), so ACP clients such as Devin Desktop
 * can list it in their agent picker.
 */
import { Readable, Writable } from "node:stream";
import {
  agent,
  ndJsonStream,
  type AgentContext,
  type ContentBlock,
  type PromptResponse,
  type SessionConfigOption,
  type SessionUpdate,
  type StopReason,
  type ToolKind,
} from "@agentclientprotocol/sdk";
import { createAgent, type Agent } from "../vendor/adcode-ai/agent.ts";
import type { AgentEvent, Message, ToolCallBlock, ToolRunResult } from "../vendor/adcode-ai/types.ts";
import { BUILT_IN_TOOLS } from "../vendor/adcode-ai/tools.ts";
import { loadConfig } from "./config.ts";
import { HeadlessToolRunner } from "./tools-runner.ts";

const config = await loadConfig();

interface Session {
  agent: Agent;
  runner: HeadlessToolRunner;
  abort: AbortController;
  cwd: string;
  model: string;
  id: string;
  ctx?: AgentContext;
  allowAlways: Set<string>;
  toolNames: Map<string, string>;
}

const sessions = new Map<string, Session>();
let nextId = 0;

const toolKind = (name: string): ToolKind => {
  switch (name) {
    case "read_file": case "list_files": case "get_outline": case "inspect_project": case "project_context":
      return "read";
    case "search": case "glob_files": case "memory_search":
      return "search";
    case "edit_file": case "propose_edit":
      return "edit";
    case "delete_file":
      return "delete";
    case "move_file":
      return "move";
    case "run_command": case "command_output": case "stop_command": case "run_project_checks":
      return "execute";
    case "fetch_url": case "view_page": case "open_preview": case "audit_page":
      return "fetch";
    default:
      return "other";
  }
};

const modelInfo = (id: string) => config.models.find((m) => m.id === id);

const makeAgent = (cwd: string, model: string, runner: HeadlessToolRunner, initialMessages?: readonly Message[]): Agent =>
  createAgent({
    provider: config.provider,
    model,
    tools: BUILT_IN_TOOLS,
    runner,
    context: () => `Workspace root: ${cwd}`,
    initialMessages,
    maxOutputTokens: modelInfo(model)?.maxOutput,
    compaction: {
      contextWindow: () => modelInfo(model)?.contextWindow ?? 128_000,
      thresholdPercent: () => 80,
    },
  });

const newSession = (cwd: string, id: string): Session => {
  const runner = new HeadlessToolRunner(cwd);
  const session: Session = {
    agent: makeAgent(cwd, config.model, runner),
    runner,
    abort: new AbortController(),
    cwd,
    model: config.model,
    id,
    allowAlways: new Set(),
    toolNames: new Map(),
  };
  runner.onPermission = (call) => askPermission(session, call);
  runner.onAsk = (input) => askUser(session, input);
  return session;
};

const describeCall = (call: ToolCallBlock): string => {
  const i = call.input ?? {};
  if (call.name === "run_command") return `$ ${String(i.command ?? "")}`;
  if (call.name === "move_file") return `move_file ${String(i.from ?? "")} → ${String(i.to ?? "")}`;
  return `${call.name} ${String(i.path ?? i.cwd ?? "")}`.trim();
};

async function askPermission(session: Session, call: ToolCallBlock): Promise<boolean> {
  if (session.allowAlways.has(call.name) || session.ctx === undefined) return true;
  try {
    const res = await session.ctx.request("session/request_permission", {
      sessionId: session.id,
      toolCall: {
        toolCallId: call.id,
        title: describeCall(call),
        kind: toolKind(call.name),
        status: "pending",
        rawInput: call.input,
      },
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "always", name: "Always allow", kind: "allow_always" },
        { optionId: "deny", name: "Deny", kind: "reject_once" },
      ],
    });
    if (res.outcome.outcome === "cancelled") return false;
    if (res.outcome.optionId === "always") session.allowAlways.add(call.name);
    return true;
  } catch {
    return true; // client has no permission UI — keep the previous fail-open behaviour
  }
}

interface AskQuestion {
  question?: unknown;
  header?: unknown;
  options?: { label?: unknown; description?: unknown }[];
}

async function askUser(session: Session, input: Record<string, unknown>): Promise<ToolRunResult> {
  const questions = (Array.isArray(input.questions) ? input.questions : []) as AskQuestion[];
  if (session.ctx === undefined || questions.length === 0) {
    return { content: "ask_user is not wired to this client. Put the question in your reply text instead.", isError: true };
  }
  try {
    const res = await session.ctx.request("elicitation/create", {
      mode: "form",
      sessionId: session.id,
      message: questions.map((q) => String(q.question ?? "")).join("\n"),
      requestedSchema: {
        type: "object",
        properties: Object.fromEntries(
          questions.map((q, i) => {
            const opts = (q.options ?? [])
              .map((o) => String(o.label ?? ""))
              .filter((s) => s.length > 0);
            const prop: Record<string, unknown> = {
              type: "string",
              title: String(q.header ?? q.question ?? `Question ${i + 1}`),
              description: String(q.question ?? ""),
            };
            if (opts.length >= 2) prop.enum = opts;
            return [`q${i}`, prop];
          }),
        ),
        required: questions.map((_, i) => `q${i}`),
      },
    });
    if (res.action !== "accept") {
      return { content: `User ${res.action === "decline" ? "declined" : "cancelled"} the question(s).`, isError: true };
    }
    const content = res.content ?? {};
    return {
      content: questions
        .map((q, i) => `Q: ${String(q.question ?? "")}\nA: ${String(content[`q${i}`] ?? "")}`)
        .join("\n\n"),
      isError: false,
    };
  } catch (e) {
    return {
      content: `ask_user failed (${e instanceof Error ? e.message : String(e)}); put the question in your reply text instead.`,
      isError: true,
    };
  }
}

const configOptions = (session: Session): SessionConfigOption[] => [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: session.model,
    options: config.models.map((m) => ({ value: m.id, name: m.label ?? m.id })),
  },
];

function emitUpdate(ctx: AgentContext, sessionId: string, update: SessionUpdate): void {
  void ctx.notify("session/update", { sessionId, update });
}

async function runPrompt(
  ctx: AgentContext,
  session: Session,
  sessionId: string,
  text: string,
  signal: AbortSignal,
): Promise<PromptResponse> {
  let stop: StopReason = "end_turn";
  session.runner.onPlan = (entries) => {
    emitUpdate(ctx, sessionId, {
      sessionUpdate: "plan",
      entries: entries.map((e) => ({
        content: e.content,
        priority: "medium" as const,
        status: (e.status === "in_progress" ? "in_progress" : e.status) as "pending" | "in_progress" | "completed",
      })),
    });
  };
  try {
    for await (const event of session.agent.send(text, { signal })) {
      await dispatch(ctx, sessionId, session, event);
      if (event.kind === "turn-end") {
        stop = toStopReason(event.reason);
      } else if (event.kind === "cancelled") {
        stop = "cancelled";
      } else if (event.kind === "refusal") {
        stop = "refusal";
      }
    }
  } catch (e) {
    emitUpdate(ctx, sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: `\n\n[adapter error: ${e instanceof Error ? e.message : String(e)}]` },
    });
  }
  return { stopReason: stop };
}

async function dispatch(ctx: AgentContext, sessionId: string, session: Session, event: AgentEvent): Promise<void> {
  switch (event.kind) {
    case "text":
      emitUpdate(ctx, sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: event.text },
      });
      break;
    case "thinking":
      emitUpdate(ctx, sessionId, {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: event.text },
      });
      break;
    case "status":
      break;
    case "context":
      emitUpdate(ctx, sessionId, {
        sessionUpdate: "usage_update",
        used: event.tokens,
        size: event.contextWindow,
      });
      break;
    case "usage": {
      const window = modelInfo(session.model)?.contextWindow;
      if (window !== undefined) {
        emitUpdate(ctx, sessionId, {
          sessionUpdate: "usage_update",
          used: event.inputTokens,
          size: window,
        });
      }
      break;
    }
    case "tool-call":
      session.toolNames.set(event.call.id, event.call.name);
      emitUpdate(ctx, sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: event.call.id,
        title: event.call.name,
        name: event.call.name,
        kind: toolKind(event.call.name),
        status: "in_progress",
        rawInput: event.call.input,
      });
      break;
    case "tool-result": {
      const name = session.toolNames.get(event.toolCallId);
      const isCmd =
        name === "run_command" ||
        name === "command_output" ||
        name === "stop_command" ||
        name === "run_project_checks";
      emitUpdate(ctx, sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: event.toolCallId,
        status: event.isError ? "failed" : "completed",
        rawOutput: event.content,
        ...(isCmd
          ? { _meta: { terminal_output: { data: String(event.content) } } }
          : {}),
      });
      break;
    }
    case "refusal":
    case "error":
      emitUpdate(ctx, sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `\n\n[${event.kind}: ${event.detail}]` },
      });
      break;
    case "compacting":
      emitUpdate(ctx, sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "\n\n[compacting conversation…]" },
      });
      break;
    default:
      break;
  }
}

const toStopReason = (reason: string): StopReason =>
  reason === "end-turn"
    ? "end_turn"
    : reason === "max-tokens"
      ? "max_tokens"
      : reason === "refusal"
        ? "refusal"
        : reason === "cancelled"
          ? "cancelled"
          : "end_turn";

function promptText(blocks: ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === "text") {
      parts.push(block.text);
    } else if (block.type === "resource_link") {
      parts.push(`[${block.name}: ${block.uri}]`);
    } else if (block.type === "resource" && "text" in block.resource) {
      parts.push(`[${block.resource.uri}]\n${(block.resource as { text: string }).text}`);
    } else if (block.type === "image") {
      parts.push("[an image was attached; this endpoint receives text only]");
    }
  }
  return parts.join("\n");
}

const app = agent({ name: "adcode-acp" })
  .onRequest("initialize", async ({ params }) => ({
    protocolVersion: params.protocolVersion ?? 1,
    agentCapabilities: {
      loadSession: false,
      promptCapabilities: { image: true, embeddedContext: true },
    },
    agentInfo: { name: "adcode-acp", version: "0.1.0" },
  }))
  .onRequest("session/new", async ({ params, client }) => {
    const id = `adcode-${++nextId}`;
    const session = newSession(params.cwd, id);
    session.ctx = client;
    sessions.set(id, session);
    emitUpdate(client, id, {
      sessionUpdate: "available_commands_update",
      availableCommands: [
        {
          name: "compact",
          description: "Summarise older conversation to free context",
          input: { hint: "optional focus" },
        },
      ],
    });
    return { sessionId: id, configOptions: configOptions(session) };
  })
  .onRequest("session/set_config_option", async ({ params }) => {
    const session = sessions.get(params.sessionId);
    if (!session) return { configOptions: [] };
    if (
      params.configId === "model" &&
      typeof params.value === "string" &&
      config.models.some((m) => m.id === params.value)
    ) {
      session.model = params.value;
      session.agent = makeAgent(session.cwd, params.value, session.runner, session.agent.history());
    }
    return { configOptions: configOptions(session) };
  })
  .onRequest("session/prompt", async ({ params, signal, client }) => {
    const session = sessions.get(params.sessionId);
    if (!session) return { stopReason: "end_turn" satisfies StopReason };
    session.ctx = client;
    const text = promptText(params.prompt);
    if (text.trim() === "/compact" || text.trim().startsWith("/compact ")) {
      const focus = text.trim().slice("/compact".length).trim() || undefined;
      emitUpdate(client, params.sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "[compacting conversation…]" },
      });
      const outcome = await session.agent.compact(focus);
      emitUpdate(client, params.sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: outcome.ok ? "\n\n[conversation compacted]" : `\n\n[could not compact: ${outcome.reason}]`,
        },
      });
      return { stopReason: "end_turn" satisfies StopReason };
    }
    return runPrompt(client, session, params.sessionId, text, signal);
  })
  .onNotification("session/cancel", async ({ params }) => {
    sessions.get(params.sessionId)?.agent.cancel();
  });

const stream = ndJsonStream(
  Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
  Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
);
app.connect(stream);
process.stderr.write(`adcode-acp: ready (model=${config.model})\n`);
