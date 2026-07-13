import { defineConfig } from "@trigger.dev/sdk";

export default defineConfig({
  // Set after `npx trigger.dev@latest init` links this repo to your Trigger.dev
  // cloud project — replace with the real project ref (proj_...). Docs: SETUP.md step 4.
  project: process.env.TRIGGER_PROJECT_REF ?? "proj_wqranelivqmrykbfrobi",
  dirs: ["./src/trigger"],
  // node-22 required: @supabase/supabase-js constructs a realtime client that
  // needs Node's native WebSocket — plain "node" (21) crashes every task at
  // the first db() call. The Railway Dockerfile already runs node:22.
  runtime: "node-22",
  logLevel: "info",
  // Global default: every task retries with backoff before its failure branch
  // (errors table + owner alert) runs. Individual tasks override where needed.
  retries: {
    enabledInDev: false,
    default: {
      maxAttempts: 3,
      minTimeoutInMs: 1_000,
      maxTimeoutInMs: 30_000,
      factor: 2,
      randomize: true,
    },
  },
  maxDuration: 300,
});
