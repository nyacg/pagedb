# Postgres in a Durable Object

Postgres 18.6 (PGlite, compiled to WebAssembly) inside a Cloudflare Durable Object: one database
per object, its data directory in the object's SQLite, branches copy-on-write from images in R2.
It speaks the Postgres wire protocol, so psql, node-postgres, postgres.js, Drizzle (including
drizzle-kit) and pgbench work unchanged. Results and limits: [FINDINGS.md](FINDINGS.md).

## Connect

Workers can't accept TCP, so a small local proxy carries each Postgres connection over a WebSocket
to the Worker (`/wire`), which hands it to the database's object. The database name in the URL
picks the object (a new name is a new, empty database); the password is the deployment's token
(`PGDO_TOKEN` in the repo's `.env`).

```sh
node scripts/pgdo-proxy.mjs 6543            # listens on localhost:6543
psql "postgres://postgres:$PGDO_TOKEN@localhost:6543/mydb"
DATABASE_URL="postgres://postgres:$PGDO_TOKEN@localhost:6543/mydb" npx drizzle-kit migrate
```

How one single-session Postgres serves many connections (`src/wire.ts`):

- a connection inside a transaction block holds the database until it commits or rolls back,
  everyone else's statements wait their turn;
- session settings (SET, startup parameters such as `TimeZone`, `DateStyle`) are saved and
  restored per connection;
- prepared statement and portal names, including each connection's unnamed statement, are private
  to the connection;
- `COPY … FROM STDIN` is collected by the object and loaded through PGlite (its raw protocol
  can't).

## Other ways in

- HTTP (bearer token): `POST /sql?db=<name>[&image=<template>]` with the SQL as the body.
- Worker RPC: `env.PG.getByName(name).q(sql, params)` / `.tx([{ sql, params }, …])` (one round
  trip per transaction).

## Tests

- `test/regress/run.py local|do|native <outdir>`: Postgres's own regression suite (pg_regress),
  one test at a time, against PGlite in Node (`scripts/local-wire.ts`), a Durable Object, or a
  native Postgres. Needs a Postgres 18.6 source tree built in `/tmp/pgsrc` (see the script).
- `test/drizzle`: `drizzle-kit migrate` on a real project's migrations, an app-style Drizzle test
  (`app.ts`), and a crash-consistency test (`crash.mjs`).
- `/vs?compat` (HTTP): 36 feature checks side by side with Neon.

## Deploy

`./deploy.sh` (wrangler with the repo's Cloudflare credentials). `npm install` patches PGlite;
`npm run vendor` extracts the wasm, side modules and extensions it needs.
