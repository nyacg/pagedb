// Bundle the container's worker: node/dist/{app.js, engine.wasm, workerd.capnp}.
import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
const root = new URL("..", import.meta.url).pathname;
mkdirSync(`${root}node/dist`, { recursive: true });
await build({
  entryPoints: [`${root}src/node-entry.ts`],
  outfile: `${root}node/dist/app.js`,
  bundle: true,
  format: "esm",
  target: "es2022",
  external: ["cloudflare:workers", "./engine.wasm", "*.wasm"],
  logLevel: "info",
});
copyFileSync(`${root}src/engine.wasm`, `${root}node/dist/engine.wasm`);
copyFileSync(`${root}node/workerd.capnp`, `${root}node/dist/workerd.capnp`);
