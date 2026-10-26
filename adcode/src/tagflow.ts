/**
 * ADCode's free "Included AI" (Tagflow relay) as a provider.
 *
 * Reuses the account ADCode itself signed into: the identity file ADCode's
 * Electron main writes at <userData>/ads/ads/identity.json holds a Firebase
 * refresh token, which we exchange for an ID token and send to the relay.
 * Refresh rotates the token, so the rotated one is written back — ADCode keeps
 * working on the same identity.
 *
 * Sign in inside ADCode once first. Without the identity file there is no
 * account to authenticate as, and the relay refuses.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir, platform } from "node:os";
import { createOpenAiCompatibleProvider } from "../vendor/adcode-ai/providers/openaiCompatible.ts";
import type { Provider } from "../vendor/adcode-ai/types.ts";

const FIREBASE_API_KEY =
  process.env.ADCODE_FIREBASE_API_KEY ?? "AIzaSyATZzX5Fw2HjR34VxB3UQWTmljprA5uXqE";
const REFRESH_URL = "https://securetoken.googleapis.com/v1/token";
const DEFAULT_API_ORIGIN = "https://adcode.bluethenics.com";

const apiOrigin = (): string => process.env.ADCODE_AD_SERVER ?? DEFAULT_API_ORIGIN;
const apiBase = (): string => `${apiOrigin()}/v1`;

function identityFile(): string {
  if (process.env.ADCODE_IDENTITY_FILE) return process.env.ADCODE_IDENTITY_FILE;
  const home = homedir();
  const userData =
    platform() === "win32"
      ? join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "ADCode")
      : platform() === "darwin"
        ? join(home, "Library", "Application Support", "ADCode")
        : join(home, ".config", "ADCode");
  return join(userData, "ads", "ads", "identity.json");
}

interface Identity {
  uid: string;
  refreshToken: string;
}

async function readIdentity(): Promise<Identity> {
  let parsed: { uid?: unknown; refreshToken?: unknown };
  try {
    parsed = JSON.parse(await readFile(identityFile(), "utf8"));
  } catch {
    throw new Error(
      `No ADCode account identity at ${identityFile()} — sign in inside ADCode once first, or use ADCODE_ACP_BASE_URL/ADCODE_ACP_MODEL with your own endpoint.`,
    );
  }
  if (typeof parsed.uid !== "string" || typeof parsed.refreshToken !== "string") {
    throw new Error(`Malformed identity file at ${identityFile()}.`);
  }
  return { uid: parsed.uid, refreshToken: parsed.refreshToken };
}

let cached: { token: string; expiresAt: number } | null = null;
let refreshing: Promise<string> | null = null;

async function refresh(): Promise<string> {
  const identity = await readIdentity();
  const res = await fetch(`${REFRESH_URL}?key=${FIREBASE_API_KEY}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(identity.refreshToken)}`,
  });
  const body = (await res.json()) as {
    id_token?: unknown;
    refresh_token?: unknown;
    user_id?: unknown;
    expires_in?: unknown;
  };
  if (!res.ok || typeof body.id_token !== "string") {
    throw new Error(`ADCode account token refresh failed (HTTP ${res.status}). Sign in again inside ADCode.`);
  }
  // Refresh rotates the token: persist the new one so ADCode keeps working.
  if (typeof body.refresh_token === "string" && body.refresh_token !== identity.refreshToken) {
    const next = { uid: typeof body.user_id === "string" ? body.user_id : identity.uid, refreshToken: body.refresh_token };
    await mkdir(dirname(identityFile()), { recursive: true });
    await writeFile(identityFile(), JSON.stringify(next), "utf8");
  }
  const ttl = typeof body.expires_in === "string" ? Number(body.expires_in) : 3600;
  cached = { token: body.id_token, expiresAt: Date.now() + (ttl - 60) * 1000 };
  return cached.token;
}

async function token(): Promise<string> {
  if (cached !== null && cached.expiresAt > Date.now()) return cached.token;
  refreshing ??= refresh().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

interface TagflowModel {
  id: string;
  name?: string;
  label?: string;
  contextWindow: number;
  maxOutput: number;
}

interface TagflowConfig {
  available: boolean;
  defaultModel: string;
  models: TagflowModel[];
}

export async function tagflowConfig(): Promise<TagflowConfig | null> {
  try {
    const res = await fetch(`${apiBase()}/ai/tagflow/config`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    return (await res.json()) as TagflowConfig;
  } catch {
    return null;
  }
}

const reportedPlatform = (): string => {
  switch (platform()) {
    case "win32": return "windows";
    case "darwin": return "macos";
    default: return "linux";
  }
};

export async function createTagflowProvider(): Promise<{ provider: Provider; model: string; models: TagflowModel[] }> {
  const offered = await tagflowConfig();
  if (offered === null || !offered.available || offered.models.length === 0) {
    throw new Error("Included AI is not available right now (tagflow config fetch failed).");
  }
  const model = process.env.ADCODE_ACP_MODEL ?? offered.defaultModel;
  const provider = createOpenAiCompatibleProvider({
    id: "tagflow",
    displayName: "ADCode Included AI",
    baseUrl: `${apiBase()}/ai/tagflow`,
    apiKey: "",
    models: offered.models.map((m) => m.id),
    traits: (id) => {
      const m = offered.models.find((one) => one.id === id);
      return m === undefined ? undefined : { reasoning: false, effortLevels: [], maxOutput: m.maxOutput ?? null };
    },
    fetchImpl: async (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${await token()}`);
      headers.set("x-adcode-ai-source", "agent");
      headers.set("x-adcode-ai-persona", "coding-assistant");
      headers.set("x-adcode-platform", reportedPlatform());
      return fetch(input, { ...init, headers });
    },
  });
  return { provider, model, models: offered.models };
}
