/** Overlay records shared with engine.wasm: u16 tree | u32 klen | key | u8 kind | i8 delta |
 *  u8 has_val | u32 vlen | val.  kind 0 = drop the entry (key back to its base state). */
export interface OvRecord {
  tree: number;
  key: Uint8Array;
  kind: number;
  delta: number;
  val: Uint8Array | null;
}

export function decodeRecords(b: Uint8Array): OvRecord[] {
  const out: OvRecord[] = [];
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let p = 0;
  while (p < b.length) {
    const tree = dv.getUint16(p, true);
    const klen = dv.getUint32(p + 2, true);
    const key = b.slice(p + 6, p + 6 + klen);
    p += 6 + klen;
    const kind = b[p];
    const delta = dv.getInt8(p + 1);
    const has = b[p + 2];
    const vlen = dv.getUint32(p + 3, true);
    p += 7;
    const val = has ? b.slice(p, p + vlen) : null;
    p += vlen;
    out.push({ tree, key, kind, delta, val });
  }
  return out;
}

export function encodeRecords(recs: OvRecord[]): Uint8Array {
  let len = 0;
  for (const r of recs) len += 13 + r.key.length + (r.val?.length ?? 0);
  const b = new Uint8Array(len);
  const dv = new DataView(b.buffer);
  let p = 0;
  for (const r of recs) {
    dv.setUint16(p, r.tree, true);
    dv.setUint32(p + 2, r.key.length, true);
    b.set(r.key, p + 6);
    p += 6 + r.key.length;
    b[p] = r.kind;
    dv.setInt8(p + 1, r.delta);
    b[p + 2] = r.val ? 1 : 0;
    dv.setUint32(p + 3, r.val?.length ?? 0, true);
    p += 7;
    if (r.val) b.set(r.val, p);
    p += r.val?.length ?? 0;
  }
  return b;
}
