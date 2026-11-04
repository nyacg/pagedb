// Clocks for Postgres inside a Worker. Workers don't advance time while code runs (it moves on
// I/O), so a Postgres loop that waits for the clock (pg_sleep, anything polling for a timeout)
// would spin until the CPU limit. Here both clocks read real time plus a shared lead: a reading
// that wouldn't move past the previous one moves a microsecond ahead instead, and the lead shrinks
// again as real time catches up. Monotonic, close to real, and a busy-wait finishes after a few
// thousand readings (so pg_sleep returns at once: waiting for real would stall every connection).
// (scripts/patch-pglite.mjs routes PGlite's two clock imports through these.)
let lead = 0;
let lastReal = 0;
const last = { wall: 0, mono: 0 };

function read(kind: "wall" | "mono", real: number) {
  const now = performance.now();
  if (now > lastReal) {
    lead = Math.max(0, lead - (now - lastReal)); // real time moved: give back the lead
    lastReal = now;
  }
  let t = real + lead;
  if (t <= last[kind]) {
    lead += last[kind] + 0.001 - t;
    t = last[kind] + 0.001;
  }
  return (last[kind] = t);
}

(globalThis as any).__pgDateNow = () => read("wall", Date.now());
(globalThis as any).__pgNow = () => read("mono", performance.now());
export {};
