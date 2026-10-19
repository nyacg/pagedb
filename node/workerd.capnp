using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "main", worker = .node),
    (name = "data", disk = (path = "/data", writable = true)),
    # Egress is intercepted by the PageNode DO: http://r2.internal → the R2 bridge Worker.
    (name = "net", network = (allow = ["public", "private", "local"])),
  ],
  sockets = [ (name = "http", address = "*:8080", http = (), service = "main") ],
);

const node :Workerd.Worker = (
  modules = [
    (name = "app.js", esModule = embed "app.js"),
    (name = "engine.wasm", wasm = embed "engine.wasm"),
  ],
  compatibilityDate = "2026-09-01",
  compatibilityFlags = ["nodejs_compat"],
  bindings = [
    (name = "DB", durableObjectNamespace = "DbObject"),
    (name = "BUCKET", service = "net"),
    (name = "R2_BRIDGE", text = "1"),
    (name = "RAM_PAGES", fromEnvironment = "RAM_PAGES"),
    (name = "FETCH_CONCURRENCY", fromEnvironment = "FETCH_CONCURRENCY"),
  ],
  durableObjectNamespaces = [ (className = "DbObject", uniqueKey = "pagedb-db", enableSql = true) ],
  durableObjectStorage = (localDisk = "data"),
  globalOutbound = "net",
);
