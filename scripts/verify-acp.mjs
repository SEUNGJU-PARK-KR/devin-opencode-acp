#!/usr/bin/env node
/**
 * Verifies the FreeLLMAPI -> OpenCode -> Devin (ACP) wiring without touching a
 * real FreeLLMAPI instance or the user's config.
 *
 *   node scripts/verify-acp.mjs [--opencode <path>] [--proxy <path>] [--keep]
 *
 * It writes a throw-away opencode.json in a temp directory, starts a mock
 * OpenAI-compatible upstream, spawns `<opencode> acp` (or the proxy in front of
 * it) and checks:
 *
 *   1. ACP initialize + session/new succeed
 *   2. all three FreeLLMAPI models show up in the model selector
 *   3. every model can be selected through session/set_config_option
 *   4. a prompt carrying a `file:///C%3A%5C...` resource_link actually attaches
 *      the file (openCode V2 drops the attachment silently without the proxy)
 *
 * Exit code 0 = PASS, 1 = FAIL.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const CONFIG = JSON.parse(await readFile(join(ROOT, "config", "freellmapi.json"), "utf8"));

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};
const keep = argv.includes("--keep");

const opencode =
  flag("--opencode") ??
  (process.env.APPDATA ? join(process.env.APPDATA, "npm", "opencode.exe") : "opencode");
const proxy = flag("--proxy");

const results = [];
const pass = (name, detail = "") => results.push({ ok: true, name, detail });
const fail = (name, detail = "") => results.push({ ok: false, name, detail });

// ---------------------------------------------------------------- mock upstream
const seen = [];
const mock = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString("utf8");

  if (req.url.startsWith("/v1/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        object: "list",
        data: CONFIG.models.map((m) => ({ id: m.modelID, object: "model", owned_by: "freellmapi" })),
      }),
    );
    return;
  }
  if (req.url.startsWith("/v1/chat/completions")) {
    let payload = {};
    try {
      payload = JSON.parse(body);
    } catch {
      /* ignore */
    }
    seen.push(payload);
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (delta, finish = null) =>
      res.write(
        `data: ${JSON.stringify({
          id: "mock",
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`,
      );
    send({ role: "assistant", content: "" });
    send({ content: "OK" });
    send({}, "stop");
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }
  res.writeHead(404).end();
});

const port = await new Promise((done) => {
  mock.listen(0, "127.0.0.1", () => done(mock.address().port));
});

// ------------------------------------------------------------- throw-away project
const project = await mkdtemp(join(tmpdir(), "freellmapi-acp-"));
await writeFile(join(project, "seed.txt"), "SEED-CONTENT-12345\n");
await writeFile(
  join(project, "opencode.json"),
  JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      model: `${CONFIG.providerId}/${CONFIG.defaultModelId}`,
      providers: {
        [CONFIG.providerId]: {
          name: CONFIG.providerName,
          package: "@opencode/ai/providers/openai-compatible",
          settings: { baseURL: `http://127.0.0.1:${port}/v1` },
          models: Object.fromEntries(
            CONFIG.models.map((m) => [
              m.id,
              {
                modelID: m.modelID,
                name: m.name,
                capabilities: { tools: true, input: ["text"], output: ["text"] },
                limit: { context: m.context, output: m.output },
              },
            ]),
          ),
        },
      },
    },
    null,
    2,
  ),
);

// ------------------------------------------------------------------- ACP client
const env = { ...process.env };
const command = proxy ?? opencode;
if (proxy) env.OPENCODE_REAL = opencode;

const child = spawn(command, ["acp"], { cwd: project, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env });
let buffer = "";
let nextId = 0;
const pending = new Map();
const errors = [];

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.method) continue;
    const waiter = pending.get(message.id);
    if (!waiter) continue;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
    else waiter.resolve(message.result);
  }
});

child.stderr.setEncoding("utf8");
child.stderr.on("data", (text) => {
  if (/ERR_INVALID_FILE_URL|Internal error|-32603/.test(text)) errors.push(text.trim());
});

const request = (method, params, timeoutMs = 45000) =>
  new Promise((resolvePromise, rejectPromise) => {
    const id = ++nextId;
    pending.set(id, { resolve: resolvePromise, reject: rejectPromise });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    const timer = setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      rejectPromise(new Error(`timeout: ${method}`));
    }, timeoutMs);
    timer.unref?.();
  });

const started = Date.now();
try {
  await request("initialize", { protocolVersion: 1, clientCapabilities: {} });
  pass("initialize");

  const session = await request("session/new", { cwd: project, mcpServers: [] });
  const models = session.configOptions?.find((o) => o.id === "model");
  const values = new Set((models?.options ?? []).map((o) => o.value));
  const missing = CONFIG.models
    .map((m) => `${CONFIG.providerId}/${m.id}`)
    .filter((id) => !values.has(id));
  if (missing.length === 0) pass("model list", `${CONFIG.models.length} FreeLLMAPI models`);
  else fail("model list", `missing: ${missing.join(", ")}`);

  const expectedDefault = `${CONFIG.providerId}/${CONFIG.defaultModelId}`;
  if (models?.currentValue === expectedDefault) pass("default model", expectedDefault);
  else fail("default model", `got ${models?.currentValue ?? "(none)"}, expected ${expectedDefault}`);

  const switchFailures = [];
  for (const model of CONFIG.models) {
    const value = `${CONFIG.providerId}/${model.id}`;
    const reply = await request("session/set_config_option", {
      sessionId: session.sessionId,
      configId: "model",
      value,
    });
    const current = reply.configOptions?.find((o) => o.id === "model")?.currentValue;
    if (current !== value) switchFailures.push(`${value} -> ${current}`);
  }
  if (switchFailures.length === 0) pass("model switching");
  else fail("model switching", switchFailures.join("; "));

  // Warm-up prompt: openCode skips file attachments on the very first turn.
  await request("session/prompt", {
    sessionId: session.sessionId,
    prompt: [{ type: "text", text: "warmup" }],
  });

  seen.length = 0;
  const badUri = `file:///${project.replace(/\\/g, "%5C").replace(/:/g, "%3A")}%5Cseed.txt`;
  await request("session/prompt", {
    sessionId: session.sessionId,
    prompt: [
      { type: "text", text: "Read the attached file." },
      { type: "resource_link", uri: badUri, name: "seed.txt", mimeType: "text/plain" },
    ],
  });

  const attached = JSON.stringify(seen[0]?.messages ?? []).includes("SEED-CONTENT-12345");
  if (attached) pass("file attachment (%5C URI)");
  else if (proxy) fail("file attachment (%5C URI)", "proxy did not restore the attachment");
  else fail("file attachment (%5C URI)", "attachment dropped - run OpenCode behind proxy/");

  if (errors.length === 0) pass("no ACP protocol errors");
  else fail("no ACP protocol errors", errors[0].slice(0, 200));
} catch (error) {
  fail("handshake", error.message?.slice(0, 300) ?? String(error));
} finally {
  child.kill();
  mock.close();
}

const elapsed = ((Date.now() - started) / 1000).toFixed(1);
const width = Math.max(...results.map((r) => r.name.length));
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name.padEnd(width)}  ${r.detail}`);
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${failed === 0 ? "PASS" : "FAIL"} - ${results.length - failed}/${results.length} checks, ${elapsed}s`);
if (keep) console.log(`project kept at ${project}`);
process.exit(failed === 0 ? 0 : 1);
