/**
 * r/place 2022: every one of ~160M pixel placements (each pixel's full history, each user's
 * pixels), the canvas as it stood before the final whiteout, and a timelapse. Visitors paint on
 * the live canvas: a paint is a placement plus one character spliced into its tile.
 */

const eq = (c: string, v: unknown) => ({ type: "simple", op: "=", left: { type: "column", name: c }, right: { type: "literal", value: v } });
const SIZE = 2000;
const TILE = 128;
const USER = /^[A-Za-z0-9+/]{10}$|^[a-z0-9-]{3,20}$/;

function need<T>(ok: boolean, v: T, what: string): T {
  if (!ok) throw new Error(`bad ${what}`);
  return v;
}
const int = (v: unknown, lo: number, hi: number, what: string) => need(Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi, v as number, what);

export function namedQuery(name: string, a: Record<string, any> = {}): unknown {
  switch (name) {
    case "meta":
      return { table: "meta", where: eq("id", "canvas"), one: true };
    case "tiles":
      return { table: "tile", orderBy: [["id", "asc"]], limit: 256 };
    case "recent":
      return { table: "placement", orderBy: [["t", "desc"], ["id", "asc"]], limit: int(a.limit ?? 200, 1, 500, "limit") };
    case "pixel":
      return { table: "placement", where: eq("pos", int(a.pos, 0, SIZE * SIZE - 1, "pixel")), orderBy: [["t", "desc"], ["id", "asc"]], limit: int(a.limit ?? 50, 1, 200, "limit") };
    case "user":
      return { table: "placement", where: eq("u", need(typeof a.u === "string" && USER.test(a.u), a.u, "user")), orderBy: [["t", "desc"], ["id", "asc"]], limit: int(a.limit ?? 1000, 1, 1000, "limit") };
    case "userCount":
      return { table: "placement", where: eq("u", need(typeof a.u === "string" && USER.test(a.u), a.u, "user")), aggregate: "count" };
    case "snap":
      return { table: "snap", where: eq("k", int(a.k, 0, 10_000, "snapshot")), orderBy: [["k", "asc"], ["id", "asc"]], limit: 256 };
  }
  throw new Error(`unknown query ${name}`);
}

/** Palette index → the character a tile row stores (see datasets/place, `color_char`). */
export const colorChar = (c: number) => String.fromCharCode(c < 26 ? 65 + c : 97 + c - 26);

export function visitor(user?: unknown) {
  return typeof user === "string" && /^[a-z0-9-]{3,20}$/.test(user) ? user : "guest";
}

export function mutate(name: string, a: Record<string, unknown>, user: string): { ops: unknown[]; created?: string } {
  if (name !== "paint") throw new Error(`unknown mutator ${name}`);
  const x = int(a.x, 0, SIZE - 1, "x");
  const y = int(a.y, 0, SIZE - 1, "y");
  const c = int(a.c, 0, 31, "colour");
  const now = Date.now();
  const id = typeof a.id === "string" && /^u-[a-z0-9]{6,24}$/.test(a.id) ? a.id : `u-${now.toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const tile = `${Math.floor(x / TILE)}:${Math.floor(y / TILE)}`;
  return {
    ops: [
      { op: "insert", table: "placement", row: { id, pos: y * SIZE + x, c, u: visitor(user), t: now } },
      { op: "update", table: "tile", id: tile, splice: { px: [(y % TILE) * TILE + (x % TILE), colorChar(c)] }, set: { t: now } },
    ],
    created: id,
  };
}
