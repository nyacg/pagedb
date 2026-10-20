/**
 * The apps this Worker serves. Each app is a database (an R2 base), one shared object that
 * serves it, the queries pages may ask for (signed into leases) and the mutators they may call.
 */
import * as tracker from "./tracker";
import * as hn from "./hn";
import * as place from "./place";
import * as taxi from "./taxi";

type Args = Record<string, any>;
export interface Ref {
  name: string;
  args?: Args;
}

/** First paint: queries run before the HTML is sent (results inlined as `boot[key]`), and the
 *  leases the page's first subscriptions will need. */
export interface FirstPaint {
  asset: string;
  boot: Record<string, unknown>;
  prefetch: (Ref & { key: string })[];
  leases: Ref[];
}

export interface App {
  name: string;
  db(env: Record<string, unknown>): string;
  obj(env: Record<string, unknown>): string;
  /** The AST for a named query. May be async and use the Worker's env (a semantic search
   *  embeds its text first). */
  namedQuery(name: string, args: Args, env?: Record<string, unknown>): unknown | Promise<unknown>;
  mutate(name: string, args: Args, user: string): { ops: unknown[]; created?: string };
  /** The acting user's handle (a label, not authentication). */
  user(raw: unknown): string;
  firstPaint(url: URL): FirstPaint | null;
  /** Reset to the published base every night (the tracker demo); HN keeps its live items. */
  nightlyReset: boolean;
}

const s = (env: Record<string, unknown>, k: string, d: string) => (typeof env[k] === "string" ? (env[k] as string) : d);

export const APPS: Record<string, App> = {
  tracker: {
    name: "tracker",
    db: (env) => s(env, "DEMO_DB", "db1g"),
    obj: (env) => s(env, "DEMO_OBJ", "demo"),
    namedQuery: tracker.namedQuery,
    mutate: tracker.mutate,
    user: (raw) => (typeof raw === "string" && /^u\d{5}$/.test(raw) ? raw : "u00000"),
    nightlyReset: true,
    firstPaint(url) {
      const project = /^p\d{4}$/.test(url.searchParams.get("project") ?? "") ? url.searchParams.get("project")! : "p0003";
      const view = url.searchParams.get("view") ?? "list";
      const list = view === "list" && !url.searchParams.get("q");
      return {
        asset: "/app",
        boot: { project },
        prefetch: list
          ? [
              { key: "list", name: "issues", args: { project, filter: {}, limit: 50 } },
              { key: "count", name: "count", args: { project } },
            ]
          : [],
        leases: list ? [{ name: "project", args: { id: project } }] : [],
      };
    },
  },
  hn: {
    name: "hn",
    db: (env) => s(env, "HN_DB", "hn"),
    obj: (env) => s(env, "HN_OBJ", "hn"),
    namedQuery: hn.namedQuery,
    mutate: hn.mutate,
    user: hn.visitor,
    nightlyReset: false,
    firstPaint(url) {
      const p = url.searchParams.get("p") ?? "news";
      const id = url.searchParams.get("id") ?? "";
      const q = (url.searchParams.get("q") ?? "").trim();
      const ref: Ref | null =
        p === "news"
          ? { name: "top" }
          : p === "newest"
            ? { name: "new" }
            : p === "best"
              ? { name: "best" }
              : p === "item" && /^(\d{1,10}|u-[a-z0-9]{6,24})$/.test(id)
                ? { name: "item", args: { id } }
                : p === "semantic" && q.length >= 2 && q.length <= 200
                  ? { name: "semantic", args: hn.semanticArgs(url.searchParams) }
                  : null;
      return { asset: "/hn", boot: { p }, prefetch: ref ? [{ key: "list", ...ref }] : [], leases: [] };
    },
  },
  place: {
    name: "place",
    db: (env) => s(env, "PLACE_DB", "place"),
    obj: (env) => s(env, "PLACE_OBJ", "place"),
    namedQuery: place.namedQuery,
    mutate: place.mutate,
    user: place.visitor,
    nightlyReset: true,
    firstPaint: () => ({ asset: "/place", boot: {}, prefetch: [{ key: "meta", name: "meta" }], leases: [{ name: "tiles" }, { name: "recent" }] }),
  },
  taxi: {
    name: "taxi",
    db: (env) => s(env, "TAXI_DB", "taxi"),
    obj: (env) => s(env, "TAXI_OBJ", "taxi"),
    namedQuery: taxi.namedQuery,
    mutate: taxi.mutate,
    user: (raw) => (typeof raw === "string" && /^[a-z0-9-]{3,20}$/.test(raw) ? raw : "guest"),
    nightlyReset: true,
    firstPaint: () => ({
      asset: "/sheet",
      boot: {},
      prefetch: [
        { key: "rows", name: "rows", args: { offset: 0, limit: 100 } },
        { key: "count", name: "count" },
        { key: "zones", name: "zones" },
      ],
      leases: [],
    }),
  },
};

/** Which app a request is for: `?app=` on API calls, or the page path. */
export function appFor(url: URL): App {
  const page = url.pathname.split("/")[1];
  const name = url.searchParams.get("app") ?? (page === "hn" || page === "place" ? page : page === "sheet" ? "taxi" : "tracker");
  return APPS[name] ?? APPS.tracker;
}
