// How Postgres is started, shared by the Durable Object and the Node reference server.
// PGlite's own defaults (its defaultStartParams) minus two departures from stock Postgres:
// "-O" (allow_system_table_mods: lets anyone alter pg_class) and a hard-wired search_path=public
// (stock is "$user", public). Single-user mode, fsync off (the host makes writes durable).
export const START = ["--single", "-F", "-j", "-c", "exit_on_error=false", "-c", "log_checkpoints=false", "-c", "max_worker_processes=0", "-c", "max_parallel_workers=0", "-c", "max_parallel_workers_per_gather=0", "-c", "io_method=sync", "-c", "max_parallel_maintenance_workers=0", "-c", "timezone=UTC"];

/** Shared memory is sized for max_connections backends; PGlite is one. */
export const SMALL_SHMEM = ["-c", "max_connections=4", "-c", "max_wal_senders=0", "-c", "max_replication_slots=0", "-c", "max_prepared_transactions=0", "-c", "max_locks_per_transaction=64", "-c", "autovacuum_worker_slots=1"];
