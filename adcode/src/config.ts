import { createOpenAiCompatibleProvider } from "../vendor/adcode-ai/providers/openaiCompatible.ts";
import type { Provider } from "../vendor/adcode-ai/types.ts";
import { createTagflowProvider } from "./tagflow.ts";

export interface AdapterConfig {
  provider: Provider;
  model: string;
  models: { id: string; label?: string; contextWindow?: number; maxOutput?: number }[];
}

/**
 * Provider selection:
 *
 *   ADCODE_ACP_PROVIDER=tagflow — ADCode's free "Included AI" relay, reusing
 *     the account signed into ADCode (sign in inside ADCode once first).
 *     ADCODE_ACP_MODEL picks one of the offered models; default = relay default.
 *
 *   otherwise — any OpenAI-compatible endpoint:
 *     ADCODE_ACP_BASE_URL  e.g. http://127.0.0.1:11434/v1 (default)
 *     ADCODE_ACP_API_KEY   optional Bearer token
 *     ADCODE_ACP_MODEL     model id, required for this mode
 */
export async function loadConfig(): Promise<AdapterConfig> {
  if (process.env.ADCODE_ACP_PROVIDER === "tagflow") {
    const { provider, model, models } = await createTagflowProvider();
    process.stderr.write(
      `adcode-acp: included AI — ${models.map((m) => m.id).join(", ")} (using ${model})\n`,
    );
    return { provider, model, models };
  }

  const baseUrl = process.env.ADCODE_ACP_BASE_URL ?? "http://127.0.0.1:11434/v1";
  const apiKey = process.env.ADCODE_ACP_API_KEY ?? "";
  const model = process.env.ADCODE_ACP_MODEL ?? "";
  if (!model) {
    process.stderr.write(
      "adcode-acp: ADCODE_ACP_MODEL is not set. " +
        "Export the model id the endpoint should serve, e.g. ADCODE_ACP_MODEL=qwen2.5-coder:14b\n" +
        "(or set ADCODE_ACP_PROVIDER=tagflow to use ADCode's free included AI)\n",
    );
    process.exit(2);
  }
  return {
    provider: createOpenAiCompatibleProvider({
      id: "custom",
      displayName: process.env.ADCODE_ACP_PROVIDER_NAME ?? baseUrl,
      baseUrl,
      apiKey,
      models: [model],
    }),
    model,
    models: [{ id: model }],
  };
}
