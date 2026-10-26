import { chmodSync } from "node:fs";
import { build } from "esbuild";

await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  banner: { js: "#!/usr/bin/env node" },
  outfile: "dist/adcode-acp.mjs",
});

try {
  chmodSync("dist/adcode-acp.mjs", 0o755);
} catch {}
