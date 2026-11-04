// PGlite's Emscripten loader takes its Node path (createRequire(import.meta.url), undefined in a
// bundled Worker) whenever globalThis.process.versions.node exists, which it does in workerd.
// This Worker needs no Node APIs, so hide `process` before PGlite's module is evaluated.
try {
  Object.defineProperty(globalThis, "process", { value: undefined, configurable: true, writable: true });
} catch {
  (globalThis as any).process = undefined;
}
export {};
