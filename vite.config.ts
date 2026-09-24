import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// `@types/node` is now a devDependency (added so site/ — which imports Node
// built-ins like `node:url` and `node:fs/promises` — type-checks under
// tsconfig.json's shared `include`). Its mere presence in node_modules makes
// `process` resolve globally for every file in this program, because vite's
// own type declarations carry `/// <reference types="node" />`, and a
// reference directive is honored regardless of any `types` compiler option.
// The `@ts-expect-error` comments that used to sit here are stale now that
// `process` is genuinely typed; keeping them would fail `npm run check` with
// "Unused '@ts-expect-error' directive" instead of suppressing anything.
const host = process.env.TAURI_DEV_HOST;
const port = Number(process.env.VITE_PORT) || 1420;
const hmrPort = Number(process.env.VITE_HMR_PORT) || port + 1;

// https://vite.dev/config/
export default defineConfig({
  plugins: [svelte()],

  // Component tests mount Svelte in jsdom. Without the browser condition
  // vitest resolves `svelte` to its server build, where `mount` throws
  // `lifecycle_function_unavailable` and `tick` never waits for a render.
  resolve: process.env.VITEST ? { conditions: ["browser"] } : undefined,

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: hmrPort,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
});
