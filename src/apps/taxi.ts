/**
 * Every NYC yellow-cab trip of 2015 (~146M rows) as a live spreadsheet: sort by a column, jump
 * to any row (row N is found from the branch pages' row counts, not by scanning), filter and
 * count by group, and edit cells with everyone watching.
 */

const eq = (c: string, v: unknown) => ({ type: "simple", op: "=", left: { type: "column", name: c }, right: { type: "literal", value: v } });
const and = (...c: unknown[]) => (c.length === 1 ? c[0] : { type: "and", conditions: c });
export const SORTS = ["pickup", "total", "tip", "distance", "duration"] as const;
const BOROUGHS = ["Manhattan", "Brooklyn", "Queens", "Bronx", "Staten Island", "EWR", "Unknown"];
const ID = /^\d{9}$/;

function need<T>(ok: boolean, v: T, what: string): T {
  if (!ok) throw new Error(`bad ${what}`);
  return v;
}
const int = (v: unknown, lo: number, hi: number, what: string) => need(Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi, v as number, what);

/** Group filters (each has an index: payment, borough or passengers, then trip id). */
function groups(a: Record<string, any>) {
  const c: unknown[] = [];
  if (a.payment !== undefined) c.push(eq("payment", int(a.payment, 0, 6, "payment")));
  if (a.borough !== undefined) c.push(eq("borough", need(BOROUGHS.includes(a.borough), a.borough, "borough")));
  if (a.passengers !== undefined) c.push(eq("passengers", int(a.passengers, 0, 9, "passengers")));
  need(c.length <= 1, 0, "filter (one group at a time)");
  return c;
}

export function namedQuery(name: string, a: Record<string, any> = {}): unknown {
  switch (name) {
    case "rows": {
      const sort = a.sort ?? "pickup";
      need(SORTS.includes(sort), 0, "sort");
      const desc = (a.dir ?? (sort === "pickup" ? "asc" : "desc")) === "desc";
      const where = groups(a);
      need(sort === "pickup" || !where.length, 0, "filter (filtered views are in pickup order)");
      // Trip ids are numbered in pickup order, so "pickup" is the primary key's order.
      const orderBy = sort === "pickup" ? [["id", desc ? "desc" : "asc"]] : [[sort, desc ? "desc" : "asc"], ["id", desc ? "asc" : "desc"]];
      return {
        table: "trip",
        ...(where.length ? { where: and(...where) } : {}),
        orderBy,
        limit: int(a.limit ?? 100, 1, 200, "limit"),
        offset: int(a.offset ?? 0, 0, 500_000_000, "row"),
      };
    }
    case "count": {
      const where = groups(a);
      return { table: "trip", ...(where.length ? { where: and(...where) } : {}), aggregate: "count" };
    }
    case "zones":
      return { table: "zone", orderBy: [["id", "asc"]], limit: 300 };
    case "trip":
      return { table: "trip", where: eq("id", need(typeof a.id === "string" && ID.test(a.id), a.id, "trip")), one: true };
  }
  throw new Error(`unknown query ${name}`);
}

export function mutate(name: string, a: Record<string, unknown>): { ops: unknown[] } {
  if (name !== "edit") throw new Error(`unknown mutator ${name}`);
  const id = need(typeof a.id === "string" && ID.test(a.id), a.id as string, "trip");
  const op: Record<string, unknown> = { op: "update", table: "trip", id };
  if (a.note !== undefined) {
    need(a.note === null || (typeof a.note === "string" && a.note.length <= 200), 0, "note");
    op.set = { note: typeof a.note === "string" && a.note.trim() ? a.note.trim() : null };
  }
  if (a.tipDelta !== undefined) {
    // A tip change moves the total with it (an increment each: no read needed).
    const d = need(typeof a.tipDelta === "number" && Number.isFinite(a.tipDelta) && Math.abs(a.tipDelta) <= 10_000, a.tipDelta as number, "tip");
    op.add = { tip: d, total: d };
  }
  need(!!op.set || !!op.add, 0, "edit");
  return { ops: [op] };
}
