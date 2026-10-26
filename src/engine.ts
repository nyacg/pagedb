/**
 * engine.wasm (Rust) behind a small TS wrapper. Calls never block: status 0 = ok, 1 = fault
 * (payload = u64 page ids the caller must supply, then call again), 2 = error.
 */
import wasmModule from "./engine.wasm";

export const PAGE = 65536;
export const OK = 0;
export const FAULT = 1;

interface Exports {
  memory: WebAssembly.Memory;
  alloc(len: number): number;
  dealloc(ptr: number, len: number): void;
  out_ptr(): number;
  out_len(): number;
  init(ptr: number, len: number): number;
  query(ptr: number, len: number): number;
  page_put(lo: number, hi: number, ptr: number): number;
  page_put_trusted(lo: number, hi: number, ptr: number): void;
  set_ram_budget(pages: number): void;
  stats(): number;
  subscribe(ptr: number, len: number): number;
  unsubscribe(pid: number): number;
  write(ptr: number, len: number): number;
  ovl_load(ptr: number, len: number, version: number): number;
  overlay_stats(): number;
  ovl_export(): number;
  layer_set(ptr: number, len: number): number;
  fold_touch(): number;
  fold_build(first: number): number;
  fold_commit(): number;
  fold_abort(): number;
}

/** A folded layer's trees, as `fold_build` returns them: per index tree, [root, height, rows]
 *  of its `d`, `plus` and `minus` trees. */
export interface LayerTrees {
  trees: { tree: number; d: [number | null, number, number]; plus: [number | null, number, number]; minus: [number | null, number, number] }[];
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export class Engine {
  private x: Exports;

  /** `pageGet` = the synchronous tier below RAM (DO SQLite): fill `dst` and return true if held.
   *  `pageOut` stores a page a fold wrote (synchronously; the bytes are only valid during the call).
   *  `pagesGet` (optional) = the synchronous tier for many pages at once, calling `put` for each one held. */
  constructor(
    pageGet: (id: number, dst: Uint8Array) => boolean,
    pageOut: (id: number, page: Uint8Array) => void = () => {
      throw new Error("this engine can't fold");
    },
    pagesGet?: (ids: number[], put: (id: number, page: Uint8Array) => void) => void,
  ) {
    const instance = new WebAssembly.Instance(wasmModule, {
      host: {
        host_page_get: (lo: number, hi: number, dst: number) =>
          pageGet(hi * 2 ** 32 + lo, new Uint8Array(this.x.memory.buffer, dst, PAGE)) ? 1 : 0,
        host_pages_prefetch: (ptr: number, n: number) => {
          if (!pagesGet) return;
          const ids = [...new BigUint64Array(this.x.memory.buffer, ptr, n)].map(Number);
          pagesGet(ids, (id, page) => this.withBytes(page, (p) => this.x.page_put_trusted(id % 2 ** 32, Math.floor(id / 2 ** 32), p)));
        },
        host_page_out: (lo: number, hi: number, src: number) => pageOut(hi * 2 ** 32 + lo, new Uint8Array(this.x.memory.buffer, src, PAGE)),
      },
    });
    this.x = instance.exports as unknown as Exports;
  }

  private withBytes<T>(bytes: Uint8Array, f: (ptr: number, len: number) => T): T {
    const len = bytes.length || 1;
    const ptr = this.x.alloc(len);
    new Uint8Array(this.x.memory.buffer, ptr, bytes.length).set(bytes);
    try {
      return f(ptr, bytes.length);
    } finally {
      this.x.dealloc(ptr, len);
    }
  }

  private out(): Uint8Array {
    return new Uint8Array(this.x.memory.buffer, this.x.out_ptr(), this.x.out_len()).slice();
  }

  private result(status: number): { status: number; out: Uint8Array } {
    const out = this.out();
    if (status === 2) throw new Error(dec.decode(out));
    return { status, out };
  }

  init(manifest: string) {
    this.result(this.withBytes(enc.encode(manifest), (p, l) => this.x.init(p, l)));
  }

  query(ast: string) {
    return this.result(this.withBytes(enc.encode(ast), (p, l) => this.x.query(p, l)));
  }

  subscribe(ast: string) {
    return this.result(this.withBytes(enc.encode(ast), (p, l) => this.x.subscribe(p, l)));
  }

  unsubscribe(pid: number) {
    this.x.unsubscribe(pid);
  }

  /** OK payload: u32 json length, json ({version, changes, pokes}), then overlay records. */
  write(ops: string) {
    return this.result(this.withBytes(enc.encode(ops), (p, l) => this.x.write(p, l)));
  }

  loadOverlay(records: Uint8Array, version: number) {
    this.result(this.withBytes(records, (p, l) => this.x.ovl_load(p, l, version)));
  }

  /** The committed overlay as records (one per entry): a compaction snapshot. */
  exportOverlay(): Uint8Array {
    this.x.ovl_export();
    const out = this.out();
    this.x.overlay_stats(); // release the export buffer inside the engine
    return out;
  }

  setLayer(layer: LayerTrees) {
    this.result(this.withBytes(enc.encode(JSON.stringify(layer)), (p, l) => this.x.layer_set(p, l)));
  }

  /** Fold step 1: OK once every page of the current layer is resident (else FAULT). */
  foldTouch() {
    return this.result(this.x.fold_touch());
  }

  /** Fold step 2: OK payload = {pages, layer}; pages go out through `pageOut` from `first`. */
  foldBuild(first: number) {
    return this.result(this.x.fold_build(first));
  }

  /** Fold step 3: swap the new layer in (FAULT: supply its pages and call again). */
  foldCommit() {
    return this.result(this.x.fold_commit());
  }

  foldAbort() {
    this.x.fold_abort();
  }

  overlayStats() {
    this.x.overlay_stats();
    const [entries, bytes, version, partitions] = [...new BigUint64Array(this.out().buffer)].map(Number);
    return { entries, bytes, version, partitions };
  }

  putPage(id: number, page: Uint8Array): boolean {
    return this.withBytes(page, (p) => this.x.page_put(id % 2 ** 32, Math.floor(id / 2 ** 32), p)) === 1;
  }

  setRamBudget(pages: number) {
    this.x.set_ram_budget(pages);
  }

  stats() {
    this.x.stats();
    const [ramPages, ramHits, hostHits] = [...new BigUint64Array(this.out().buffer)].map(Number);
    return { ramPages, ramHits, hostHits, wasmMemMB: +(this.x.memory.buffer.byteLength / 1e6).toFixed(1) };
  }

  static faults(out: Uint8Array): number[] {
    return [...new BigUint64Array(out.buffer, out.byteOffset, out.byteLength / 8)].map(Number);
  }

  static text(out: Uint8Array): string {
    return dec.decode(out);
  }
}
