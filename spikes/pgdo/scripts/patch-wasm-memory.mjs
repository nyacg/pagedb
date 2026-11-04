// Lower pglite.wasm's declared minimum memory (2048 pages = 128 MB, a whole Durable Object) in place:
// the memory grows on demand (max 2 GB), and static data ends at 2.8 MB.
//   node scripts/patch-wasm-memory.mjs <src> <dst> [pages=512]
import { readFileSync, writeFileSync } from "node:fs";
const [src, dst, pages] = [process.argv[2], process.argv[3], Number(process.argv[4] ?? 512)];
const b = Buffer.from(readFileSync(src));
const at = Number(process.argv[5] ?? 2357);
// at: flags byte; then min as LEB128
if (b[at] !== 1 || b[at + 1] !== 0x80 || b[at + 2] !== 0x10) throw new Error(`unexpected bytes at ${at}: ${[...b.subarray(at, at + 4)]}`);
if (pages < 128 || pages > 16383) throw new Error("pages must encode in 2 LEB bytes (128..16383)");
b[at + 1] = (pages & 0x7f) | 0x80; b[at + 2] = pages >> 7;
writeFileSync(dst, b);
console.log(`min ${2048} → ${pages} pages (${pages * 64 / 1024} MB)`);
