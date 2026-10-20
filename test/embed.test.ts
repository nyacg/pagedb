// storyText must match the builder's story_text (the same fixture runs in engine/builder).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { storyText, packVector } from "../src/embed";

test("storyText matches the shared fixture", () => {
  const fx = JSON.parse(readFileSync(new URL("../datasets/hn/embed-fixture.json", import.meta.url), "utf8")) as { row: any; text: string }[];
  for (const c of fx) assert.equal(storyText(c.row), c.text, JSON.stringify(c.row).slice(0, 80));
});

test("packVector truncates and normalizes", () => {
  const b = Buffer.from(packVector([3, 4, 12], 2), "base64");
  const f = new Float32Array(b.buffer, b.byteOffset, 2);
  assert.ok(Math.abs(f[0] - 0.6) < 1e-6 && Math.abs(f[1] - 0.8) < 1e-6);
});
