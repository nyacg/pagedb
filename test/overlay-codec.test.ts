import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeRecords, encodeRecords, splitRecords, type OvRecord } from "../src/overlay-codec";

const rec = (i: number, vlen: number, kind = 1): OvRecord => ({
  tree: i % 7,
  key: new Uint8Array(3 + (i % 5)).fill(i),
  kind,
  delta: (i % 3) - 1,
  val: vlen ? new Uint8Array(vlen).fill(i) : null,
});

test("splitRecords cuts at record boundaries, under the limit, losing nothing", () => {
  const recs = Array.from({ length: 500 }, (_, i) => rec(i, (i * 37) % 900, i % 11 === 0 ? 0 : 1));
  const all = encodeRecords(recs);
  for (const max of [64, 1000, 5000, all.length, all.length * 2]) {
    const pieces = splitRecords(all, max);
    const one = recs.reduce((m, r) => Math.max(m, 13 + r.key.length + (r.val?.length ?? 0)), 0);
    for (const p of pieces) assert.ok(p.length <= Math.max(max, one), `piece ${p.length} > ${max}`);
    assert.deepEqual(pieces.flatMap((p) => decodeRecords(p)), recs);
    assert.equal(pieces.reduce((n, p) => n + p.length, 0), all.length);
  }
});

test("a record bigger than the limit gets a piece of its own", () => {
  const recs = [rec(1, 10), rec(2, 4000), rec(3, 10)];
  const pieces = splitRecords(encodeRecords(recs), 1000);
  assert.deepEqual(pieces.map((p) => decodeRecords(p).length), [1, 1, 1]);
});

test("empty input splits to nothing", () => {
  assert.deepEqual(splitRecords(new Uint8Array(0), 100), []);
});
