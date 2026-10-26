/**
 * Headless ToolRunner for ADCode's built-in tool set.
 *
 * Implements the filesystem, search, command and fetch tools against one
 * workspace root. Browser/preview/team/memory tools get an honest error so the
 * model adapts instead of hanging.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import picomatch from "picomatch";
import type {
  ImageBlock,
  ImageMediaType,
  ToolCallBlock,
  ToolRunResult,
  ToolRunner,
} from "../vendor/adcode-ai/types.ts";

const MAX_READ_LINES = 2000;
const MAX_OUTPUT_CHARS = 60_000;
const FETCH_CHARS = 24_000;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "out", ".next", "coverage", "__pycache__"]);
const IMAGE_TYPES: Record<string, ImageMediaType> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

const ok = (content: string, images?: ImageBlock[]): ToolRunResult => ({ content, isError: false, images });
const err = (content: string): ToolRunResult => ({ content, isError: true });

// Models emit unix-style commands; use Git Bash instead of cmd.exe when present.
const SHELL: string | true =
  process.platform === "win32"
    ? (["C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files (x86)\\Git\\bin\\bash.exe"].find((p) =>
        existsSync(p),
      ) ?? true)
    : true;

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
const bool = (v: unknown): boolean => v === true;

interface BackgroundCmd {
  id: string;
  command: string;
  proc: ChildProcess;
  output: string;
  cursor: number;
  exited: boolean;
  exitCode: number | null;
}

export class HeadlessToolRunner implements ToolRunner {
  private readonly background = new Map<string, BackgroundCmd>();
  private cmdSeq = 0;
  /** Latest plan emitted by update_plan, forwarded as an ACP plan update by main.ts. */
  onPlan?: (entries: { content: string; status: string }[]) => void;
  /** Gate mutating/executing tools; return false to deny. Wired to session/request_permission by main.ts. */
  onPermission?: (call: ToolCallBlock) => Promise<boolean>;
  /** Wired to elicitation/create by main.ts. */
  onAsk?: (input: Record<string, unknown>) => Promise<ToolRunResult>;

  private readonly root: string;
  /** Oversized tool output goes here instead of the conversation; read_file reaches it. */
  private readonly spillDir: string;
  private spillSeq = 0;

  constructor(root: string) {
    let r = root.trim();
    if (r.startsWith("file://")) {
      try {
        r = fileURLToPath(r);
      } catch {}
    }
    this.root = resolve(r);
    this.spillDir = join(this.root, ".adcode", "spill");
    void rm(this.spillDir, { recursive: true, force: true }).catch(() => {});
  }

  private resolve(wsPath: unknown): string {
    let raw = str(wsPath).trim();
    if (raw.startsWith("file://")) {
      try {
        raw = fileURLToPath(raw);
      } catch {}
    }
    const rel = raw === "" || raw === "." || raw === "/" ? "" : raw;
    const abs = resolve(this.root, rel);
    const same =
      process.platform === "win32"
        ? abs.toLowerCase() === this.root.toLowerCase() ||
          abs.toLowerCase().startsWith(this.root.toLowerCase() + sep)
        : abs === this.root || abs.startsWith(this.root + sep);
    if (!same) {
      throw new Error(`path escapes the workspace: ${rel}`);
    }
    return abs;
  }

  private static readonly NEEDS_PERMISSION = new Set([
    "edit_file",
    "propose_edit",
    "move_file",
    "delete_file",
    "run_command",
  ]);

  private static readonly SPILL_CHARS = 8_000;
  private static readonly SPILL_PREVIEW = 3_000;

  /** Result bigger than the in-context budget lands on disk; the model gets a preview. */
  private async spill(result: ToolRunResult): Promise<ToolRunResult> {
    if (result.content.length <= HeadlessToolRunner.SPILL_CHARS) return result;
    try {
      await mkdir(this.spillDir, { recursive: true });
      const file = join(this.spillDir, `output-${++this.spillSeq}.txt`);
      await writeFile(file, result.content, "utf8");
      const kept = result.content.slice(0, HeadlessToolRunner.SPILL_PREVIEW);
      return {
        ...result,
        content: `${kept}\n[... ${result.content.length - HeadlessToolRunner.SPILL_PREVIEW} more characters - the full output was saved to ${rel(this.root, file)}. read_file it with offset and limit for the rest.]`,
      };
    } catch {
      return result;
    }
  }

  async run(call: ToolCallBlock, signal: AbortSignal): Promise<ToolRunResult> {
    return this.spill(await this.dispatch(call, signal));
  }

  private async dispatch(call: ToolCallBlock, signal: AbortSignal): Promise<ToolRunResult> {
    const input = call.input ?? {};
    try {
      if (
        HeadlessToolRunner.NEEDS_PERMISSION.has(call.name) &&
        this.onPermission !== undefined &&
        !(await this.onPermission(call))
      ) {
        return err("The user denied this action.");
      }
      switch (call.name) {
        case "read_file": return await this.readFile(input);
        case "list_files": return await this.listFiles(input);
        case "search": return await this.search(input);
        case "glob_files": return await this.globFiles(input);
        case "get_outline": return await this.getOutline(input);
        case "propose_edit": return await this.proposeEdit(input);
        case "edit_file": return await this.editFile(input);
        case "move_file": return await this.moveFile(input);
        case "delete_file": return await this.deleteFile(input);
        case "run_command": return await this.runCommand(input, signal);
        case "command_output": return await this.commandOutput(input, signal);
        case "stop_command": return this.stopCommand(input);
        case "fetch_url": return await this.fetchUrl(input);
        case "inspect_project": return await this.inspectProject(input);
        case "run_project_checks": return await this.runProjectChecks(input, signal);
        case "update_plan": return this.updatePlan(input);
        case "project_context": return await this.projectContext();
        case "memory_search":
        case "memory_write":
        case "message_teammate":
        case "read_messages":
          return err(`${call.name} is not available in the ACP adapter (no shared memory or teammates).`);
        case "open_preview":
        case "view_page":
        case "audit_page":
          return err(`${call.name} needs a browser; the ACP adapter is headless. Use run_command to start the server and tell the user the URL, or fetch_url to read a page's text.`);
        case "ask_user":
          return this.onAsk !== undefined
            ? await this.onAsk(input)
            : err("ask_user is not wired to this client. Put the question in your reply text instead; the user will answer in the next message.");
        default:
          return err(`Unknown tool: ${call.name}`);
      }
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  }

  /* ── files ─────────────────────────────────────────────────────────── */

  private async readFile(input: Record<string, unknown>): Promise<ToolRunResult> {
    const abs = this.resolve(input.path);
    const media = IMAGE_TYPES[extname(abs).toLowerCase()];
    if (media) {
      const data = await readFile(abs);
      return ok(`image ${rel(this.root, abs)}`, [{ type: "image", mediaType: media, data: data.toString("base64") }]);
    }
    const text = await readFile(abs, "utf8");
    const lines = text.split("\n");
    const offset = Math.max(1, num(input.offset) ?? 1);
    const limit = Math.min(MAX_READ_LINES, num(input.limit) ?? MAX_READ_LINES);
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    const withNumbers = input.line_numbers !== false;
    const body = slice
      .map((line, i) => (withNumbers ? `${offset + i}\t${line}` : line))
      .join("\n");
    const more = offset - 1 + limit < lines.length;
    return ok(body + (more ? `\n[...truncated; continue with offset=${offset + limit}]` : ""));
  }

  private async listFiles(input: Record<string, unknown>): Promise<ToolRunResult> {
    const abs = this.resolve(input.path);
    const recursive = bool(input.recursive);
    const out: string[] = [];
    const walk = async (dir: string, depth: number): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
        const p = join(dir, e.name);
        out.push(rel(this.root, p) + (e.isDirectory() ? "/" : ""));
        if (recursive && e.isDirectory() && out.length < 4000) await walk(p, depth + 1);
      }
    };
    await walk(abs, 0);
    return ok(out.slice(0, 4000).join("\n") || "(empty)");
  }

  private async *walkFiles(dir: string): AsyncGenerator<string> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) yield* this.walkFiles(p);
      else if (e.isFile()) yield p;
    }
  }

  private async search(input: Record<string, unknown>): Promise<ToolRunResult> {
    const base = this.resolve(input.path);
    const literal = bool(input.literal);
    const ci = !bool(input.case_sensitive);
    const pattern = str(input.pattern);
    const re = new RegExp(literal ? pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : pattern, ci ? "i" : "");
    const include = str(input.include) ? picomatch(str(input.include)) : null;
    const max = Math.min(300, num(input.max_results) ?? 80);
    const context = Math.min(5, num(input.context) ?? 0);
    const filesOnly = bool(input.files_only);
    const results: string[] = [];
    outer: for await (const f of this.walkFiles(base)) {
      const r = rel(this.root, f);
      if (include && !include(r)) continue;
      if (IMAGE_TYPES[extname(f).toLowerCase()]) continue;
      let text: string;
      try {
        const buf = await readFile(f);
        if (buf.includes(0)) continue;
        text = buf.toString("utf8");
      } catch {
        continue;
      }
      const lines = text.split("\n");
      let matched = false;
      for (let i = 0; i < lines.length; i++) {
        if (!re.test(lines[i])) continue;
        matched = true;
        if (filesOnly) break;
        for (let c = Math.max(0, i - context); c <= Math.min(lines.length - 1, i + context); c++) {
          results.push(`${r}:${c + 1}: ${lines[c]}`);
        }
        if (context > 0) results.push("--");
        if (results.length >= max) break outer;
      }
      if (filesOnly && matched) results.push(r);
      if (filesOnly && results.length >= max) break;
    }
    return ok(results.join("\n") || "No matches.");
  }

  private async globFiles(input: Record<string, unknown>): Promise<ToolRunResult> {
    const base = this.resolve(input.path);
    const match = picomatch(str(input.pattern));
    const out: string[] = [];
    for await (const f of this.walkFiles(base)) {
      const r = rel(base, f);
      if (match(r)) out.push(rel(this.root, f));
      if (out.length >= 2000) break;
    }
    return ok(out.join("\n") || "No matches.");
  }

  private async getOutline(input: Record<string, unknown>): Promise<ToolRunResult> {
    const abs = this.resolve(input.path);
    const text = await readFile(abs, "utf8");
    const lines = text.split("\n");
    const re =
      /^\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?(?:function\*?\s+\w+|class\s+\w+|interface\s+\w+|type\s+\w+|enum\s+\w+|const\s+\w+\s*=\s*(?:async\s*)?\(|def\s+\w+|#+\s+\S)/;
    const out: string[] = [];
    lines.forEach((line, i) => {
      const t = line.trim();
      if (re.test(line)) out.push(`${i + 1}: ${t.slice(0, 120)}`);
    });
    return ok(out.join("\n") || "No symbols found.");
  }

  private async proposeEdit(input: Record<string, unknown>): Promise<ToolRunResult> {
    const abs = this.resolve(input.path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, str(input.contents), "utf8");
    return ok(`Wrote ${rel(this.root, abs)} (${str(input.contents).split("\n").length} lines).`);
  }

  private async editFile(input: Record<string, unknown>): Promise<ToolRunResult> {
    const abs = this.resolve(input.path);
    const text = await readFile(abs, "utf8");
    const edits = Array.isArray(input.edits)
      ? (input.edits as Record<string, unknown>[])
      : [{ old_string: input.old_string, new_string: input.new_string, replace_all: input.replace_all }];
    if (edits.length === 0 || edits.some((e) => typeof e.old_string !== "string" || typeof e.new_string !== "string")) {
      return err("edit_file needs old_string and new_string (or an edits array). Read the file without line numbers and retry.");
    }
    let updated = text;
    for (const e of edits) {
      const oldS = e.old_string as string;
      const newS = e.new_string as string;
      const count = updated.split(oldS).length - 1;
      if (count === 0) {
        return err(
          `No match for old_string in ${rel(this.root, abs)}. Current file text:\n${text.slice(0, 20_000)}\nRe-read with read_file(line_numbers:false) and correct the replacement; do not repeat this call unchanged.`,
        );
      }
      if (count > 1 && !e.replace_all) {
        return err(`old_string matches ${count} places in ${rel(this.root, abs)}; add surrounding context or pass replace_all: true.`);
      }
      updated = e.replace_all ? updated.split(oldS).join(newS) : updated.replace(oldS, newS);
    }
    await writeFile(abs, updated, "utf8");
    return ok(`Edited ${rel(this.root, abs)} (${edits.length} replacement${edits.length > 1 ? "s" : ""}).`);
  }

  private async moveFile(input: Record<string, unknown>): Promise<ToolRunResult> {
    const from = this.resolve(input.from);
    const to = this.resolve(input.to);
    try {
      await stat(to);
      if (!bool(input.overwrite)) return err(`${rel(this.root, to)} already exists; pass overwrite: true to replace it.`);
    } catch {}
    await mkdir(dirname(to), { recursive: true });
    await rename(from, to);
    return ok(`Moved ${rel(this.root, from)} -> ${rel(this.root, to)}.`);
  }

  private async deleteFile(input: Record<string, unknown>): Promise<ToolRunResult> {
    const abs = this.resolve(input.path);
    await rm(abs, { recursive: false });
    return ok(`Deleted ${rel(this.root, abs)}.`);
  }

  /* ── commands ──────────────────────────────────────────────────────── */

  private async runCommand(input: Record<string, unknown>, signal: AbortSignal): Promise<ToolRunResult> {
    const command = str(input.command);
    const cwd = this.resolve(input.cwd);
    const timeout = Math.min(600, num(input.timeout_seconds) ?? 120);
    const serverish = /(?:^|\s)(npm run dev|vite|serve|http\.server|next dev|flask run|uvicorn|streamlit)\b/.test(command);
    if (bool(input.background) || serverish) {
      const id = `cmd-${++this.cmdSeq}`;
      const proc = spawn(command, { cwd, shell: SHELL });
      const rec: BackgroundCmd = { id, command, proc, output: "", cursor: 0, exited: false, exitCode: null };
      proc.stdout?.on("data", (d) => (rec.output += d.toString()));
      proc.stderr?.on("data", (d) => (rec.output += d.toString()));
      proc.on("exit", (code) => {
        rec.exited = true;
        rec.exitCode = code;
      });
      this.background.set(id, rec);
      return ok(`Started in background as ${id}: ${command}`);
    }
    return await this.execAndWait(command, cwd, timeout * 1000, signal);
  }

  private execAndWait(command: string, cwd: string, timeoutMs: number, signal: AbortSignal): Promise<ToolRunResult> {
    return new Promise((resolvePromise) => {
      const proc = spawn(command, { cwd, shell: SHELL });
      let output = "";
      proc.stdout?.on("data", (d) => (output += d.toString()));
      proc.stderr?.on("data", (d) => (output += d.toString()));
      const killer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
      const onAbort = () => proc.kill("SIGKILL");
      signal.addEventListener("abort", onAbort, { once: true });
      proc.on("error", (e) => {
        clearTimeout(killer);
        signal.removeEventListener("abort", onAbort);
        resolvePromise(err(`Failed to start: ${e.message}`));
      });
      proc.on("close", (code) => {
        clearTimeout(killer);
        signal.removeEventListener("abort", onAbort);
        const clipped = output.length > MAX_OUTPUT_CHARS
          ? output.slice(0, 20_000) + `\n[...${output.length - 40_000} chars clipped...]\n` + output.slice(-20_000)
          : output;
        const text = `exit ${code ?? "?"}\n${clipped}`.trimEnd();
        resolvePromise(code === 0 ? ok(text) : err(text));
      });
    });
  }

  private async commandOutput(input: Record<string, unknown>, signal: AbortSignal): Promise<ToolRunResult> {
    if (!input.id) {
      const lines = [...this.background.values()].map(
        (c) => `${c.id}: ${c.exited ? `exited ${c.exitCode}` : "running"} — ${c.command}`,
      );
      return ok(lines.join("\n") || "No background commands.");
    }
    const rec = this.background.get(str(input.id));
    if (!rec) return err(`No background command ${str(input.id)}.`);
    const wait = Math.min(60, num(input.wait_seconds) ?? 0);
    const deadline = Date.now() + wait * 1000;
    while (!rec.exited && rec.output.length === rec.cursor && Date.now() < deadline && !signal.aborted) {
      await new Promise((r) => setTimeout(r, 250));
    }
    const fresh = rec.output.slice(rec.cursor);
    rec.cursor = rec.output.length;
    return ok(`${rec.id} ${rec.exited ? `exited ${rec.exitCode}` : "running"}\n${fresh}`);
  }

  private stopCommand(input: Record<string, unknown>): ToolRunResult {
    const rec = this.background.get(str(input.id));
    if (!rec) return err(`No background command ${str(input.id)}.`);
    rec.proc.kill("SIGKILL");
    return ok(`Stopped ${rec.id}.`);
  }

  /* ── fetch & project ───────────────────────────────────────────────── */

  private async fetchUrl(input: Record<string, unknown>): Promise<ToolRunResult> {
    const url = str(input.url);
    if (!/^https:\/\//.test(url) && !/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(url)) {
      return err("Only https URLs (or local loopback http) may be fetched.");
    }
    const res = await fetch(url, { redirect: "follow" });
    const body = await res.text();
    const clipped = body.slice(0, FETCH_CHARS);
    const text = bool(input.raw) ? clipped : htmlToText(clipped);
    return ok(`HTTP ${res.status}\n${text}${body.length > FETCH_CHARS ? "\n[truncated]" : ""}`);
  }

  private async inspectProject(input: Record<string, unknown>): Promise<ToolRunResult> {
    const dir = this.resolve(input.cwd);
    const out: string[] = [];
    const manifests = ["package.json", "pyproject.toml", "requirements.txt", "Cargo.toml", "go.mod", "pom.xml", "build.gradle", "Gemfile", "composer.json"];
    for (const m of manifests) {
      try {
        const c = await readFile(join(dir, m), "utf8");
        out.push(`== ${m}\n${c.slice(0, 4000)}`);
      } catch {}
    }
    return ok(out.join("\n\n") || "No known manifests found at this path.");
  }

  private async runProjectChecks(input: Record<string, unknown>, signal: AbortSignal): Promise<ToolRunResult> {
    const dir = this.resolve(input.cwd);
    let scripts: Record<string, string> = {};
    try {
      scripts = JSON.parse(await readFile(join(dir, "package.json"), "utf8")).scripts ?? {};
    } catch {
      return err("No package.json here; run native check commands with run_command.");
    }
    const wanted = Array.isArray(input.scripts)
      ? (input.scripts as unknown[]).map(String)
      : ["typecheck", "lint", "test", "build"].filter((s) => scripts[s] !== undefined);
    const existing = wanted.filter((s) => scripts[s] !== undefined);
    const missing = wanted.filter((s) => scripts[s] === undefined);
    const timeout = Math.min(600, num(input.timeout_seconds) ?? 120);
    const parts: string[] = [];
    for (const s of existing.slice(0, 4)) {
      const r = await this.execAndWait(`npm run ${s} --if-present`, dir, timeout * 1000, signal);
      parts.push(`== npm run ${s} ${r.isError ? "(failed)" : "(passed)"}\n${r.content}`);
    }
    if (missing.length) parts.push(`missing scripts: ${missing.join(", ")}`);
    return ok(parts.join("\n\n") || "No check scripts found.");
  }

  /* ── plan / context ────────────────────────────────────────────────── */

  private updatePlan(input: Record<string, unknown>): ToolRunResult {
    const steps = (input.steps as { step: string; status: string }[] | undefined) ?? [];
    this.onPlan?.(steps.map((s) => ({ content: s.step, status: s.status === "done" ? "completed" : s.status })));
    return ok(`Plan updated (${steps.length} steps).`);
  }

  private async projectContext(): Promise<ToolRunResult> {
    for (const name of ["AGENTS.md", "CLAUDE.md", "README.md"]) {
      try {
        const c = await readFile(join(this.root, name), "utf8");
        return ok(`== ${name}\n${c.slice(0, 12_000)}`);
      } catch {}
    }
    return ok("No AGENTS.md, CLAUDE.md or README.md at the workspace root.");
  }
}

const rel = (root: string, abs: string): string => {
  const r = relative(root, abs);
  return r === "" ? "." : r.split(sep).join("/");
};

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, "$2 ($1)")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}
