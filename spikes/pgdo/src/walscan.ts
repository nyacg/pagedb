// Which data blocks crash recovery will touch: the block references in every WAL record from the
// last checkpoint's redo point to the end of the WAL. A primary whose pages live on page servers
// (or a replica booting from them) fetches these before Postgres starts, since recovery runs
// inside startup where a missed read can't be retried.
//
// Only the headers are decoded (PostgreSQL 18 formats): the control file's redo pointer, page
// headers, record headers and block-reference headers. Record data and images are skipped.

const XLOG_BLCKSZ = 8192;
const RELSEG_BLOCKS = 131072; // 1 GiB segments of 8 KiB blocks
const XLP_LONG_HEADER = 0x0002;
const SHORT_PHD = 24; // MAXALIGN(SizeOfXLogShortPHD = 20)
const LONG_PHD = 40; // MAXALIGN(SizeOfXLogLongPHD = 36)
const RECORD_HEADER = 24;
const FORKS = ["", "_fsm", "_vm", "_init"];

/** Reads a whole file of PGDATA (null if it doesn't exist). */
export type ReadFile = (path: string) => Uint8Array | null;

export interface WalScan {
  redo: bigint;
  end: bigint;
  records: number;
  /** Blocks referenced, as `${path}\0${block}` (path in PGDATA, block within that segment file). */
  blocks: Set<string>;
}

const hex8 = (n: number) => n.toString(16).toUpperCase().padStart(8, "0");

export function scanWal(read: ReadFile): WalScan | null {
  const control = read("/global/pg_control");
  if (!control) return null;
  const cv = new DataView(control.buffer, control.byteOffset, control.byteLength);
  const redo = cv.getBigUint64(40, true); // ControlFileData.checkPointCopy.redo
  const tli = cv.getUint32(48, true); // checkPointCopy.ThisTimeLineID
  const blocks = new Set<string>();

  // segment size: from the long header of the segment holding the redo point
  let segSize = 0;
  const segName = (segno: bigint) => {
    const perLog = BigInt(0x100000000) / BigInt(segSize);
    return `/pg_wal/${hex8(tli)}${hex8(Number(segno / perLog))}${hex8(Number(segno % perLog))}`;
  };
  for (const size of [1 << 20, 16 << 20, 2 << 20, 4 << 20, 8 << 20, 32 << 20, 64 << 20, 1 << 30]) {
    segSize = size;
    const f = read(segName(redo / BigInt(size)));
    if (f && f.length >= LONG_PHD && new DataView(f.buffer, f.byteOffset).getUint32(32, true) === size) break;
    segSize = 0;
  }
  if (!segSize) return null;

  // A byte stream of WAL contents (page headers stripped) starting at `redo`.
  const segs = new Map<bigint, Uint8Array | null>();
  const seg = (segno: bigint) => {
    if (!segs.has(segno)) segs.set(segno, read(segName(segno)));
    return segs.get(segno)!;
  };
  /** Copy `n` bytes of WAL at `pos` (skipping page headers); null past the end of the WAL. */
  const take = (pos: bigint, n: number): { bytes: Uint8Array; next: bigint } | null => {
    const out = new Uint8Array(n);
    let got = 0;
    while (got < n) {
      const s = seg(pos / BigInt(segSize));
      if (!s) return null;
      const inSeg = Number(pos % BigInt(segSize));
      const pageOff = inSeg % XLOG_BLCKSZ;
      const hdr = inSeg < XLOG_BLCKSZ ? LONG_PHD : SHORT_PHD;
      if (pageOff < hdr) {
        pos += BigInt(hdr - pageOff);
        continue;
      }
      const avail = Math.min(XLOG_BLCKSZ - pageOff, n - got, s.length - inSeg);
      if (avail <= 0) return null;
      out.set(s.subarray(inSeg, inSeg + avail), got);
      got += avail;
      pos += BigInt(avail);
    }
    return { bytes: out, next: pos };
  };

  let pos = redo, records = 0, prev = BigInt(-1);
  for (;;) {
    // records start 8-aligned; a record never starts inside a page header
    pos = (pos + BigInt(7)) & ~BigInt(7);
    const inPage = Number(pos % BigInt(XLOG_BLCKSZ));
    const hdrLen = Number(pos % BigInt(segSize)) < XLOG_BLCKSZ ? LONG_PHD : SHORT_PHD;
    if (inPage < hdrLen) pos += BigInt(hdrLen - inPage);
    const head = take(pos, RECORD_HEADER);
    if (!head) break;
    const hv = new DataView(head.bytes.buffer);
    const total = hv.getUint32(0, true);
    const xlPrev = hv.getBigUint64(8, true);
    if (total < RECORD_HEADER || total > 64 << 20) break; // zeros or garbage: the end of the WAL
    if (prev >= BigInt(0) && xlPrev !== prev) break; // a stale record from a recycled segment
    const rec = take(pos, total);
    if (!rec) break;
    const r = rec.bytes, rv = new DataView(r.buffer);
    // block references (best effort: a header that doesn't parse ends this record's list; the
    // caller boots anyway and fetches whatever recovery still misses)
    let off = RECORD_HEADER, rel: [number, number, number] | null = null;
    while (off + 4 <= total) {
      const id = r[off];
      if (id === 255) break; // XLR_BLOCK_ID_DATA_SHORT: main data follows
      if (id === 254) break; // XLR_BLOCK_ID_DATA_LONG
      if (id === 253) {
        off += 3; // XLR_BLOCK_ID_ORIGIN
        continue;
      }
      if (id === 252) {
        off += 5; // XLR_BLOCK_ID_TOPLEVEL_XID
        continue;
      }
      if (id > 32) break; // not a block reference: stop
      const forkFlags = r[off + 1];
      off += 4; // id, fork_flags, data_length
      if (forkFlags & 0x10) {
        // BKPBLOCK_HAS_IMAGE: length, hole_offset, bimg_info (+ hole_length if compressed with a hole)
        const bimg = r[off + 4];
        off += 5;
        if (bimg & 0x01 && bimg & (0x04 | 0x08 | 0x10)) off += 2;
      }
      if (!(forkFlags & 0x80)) {
        // BKPBLOCK_SAME_REL unset: a RelFileLocator follows
        if (off + 16 > total) break;
        rel = [rv.getUint32(off, true), rv.getUint32(off + 4, true), rv.getUint32(off + 8, true)];
        off += 12;
      }
      if (off + 4 > total) break;
      const blk = rv.getUint32(off, true);
      off += 4;
      if (rel) {
        const [spc, db, relNumber] = rel;
        const dir = spc === 1664 || db === 0 ? "/global" : spc === 1663 ? `/base/${db}` : null;
        if (dir) {
          const segno = Math.floor(blk / RELSEG_BLOCKS);
          blocks.add(`${dir}/${relNumber}${FORKS[forkFlags & 0x0f] ?? ""}${segno ? `.${segno}` : ""}\0${blk % RELSEG_BLOCKS}`);
        }
      }
    }
    records++;
    prev = pos;
    pos = rec.next;
  }
  return { redo, end: pos, records, blocks };
}
