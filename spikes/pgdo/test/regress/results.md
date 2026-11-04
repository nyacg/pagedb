# pg_regress results (Nov 4, 2026)

From `python3 test/regress/report.py native=… pglite=… do=…` (see run.py). PostgreSQL 18.6, `parallel_schedule`.

| run | pass | fail | hang |
|---|---|---|---|
| native | 231 | 0 | 0 |
| pglite | 191 | 34 | 6 |
| do | 186 | 40 | 5 |

Failures under PGlite (Node), by likely cause:
- C test library (regress.so can't load into wasm) (15): test_setup type_sanity encoding create_function_c create_type create_view triggers lock alter_generic misc misc_functions foreign_data indirect_toast conversion compression_pglz
- other (11): copy copyselect object_address select_views tsearch tsdicts plpgsql copy2 temp prepare event_trigger_login
- hang (6): opr_sanity euc_kr copyencoding infinite_recurse json jsonb
- tablespaces / server filesystem (2): psql largeobject
- parallel query / workers off (2): select_parallel partition_prune
- statistics / autovacuum timing (2): subscription stats
- non-UTF8 encoding conversion (1): collate.icu.utf8
- roles / privileges (1): guc

Fail in the Durable Object but pass under PGlite in Node (5):
- regex [fail]: - t  | - t
- sanity_check [fail]: -SELECT relname, nspname | - FROM pg_class c LEFT JOIN pg_namespace n ON n.oid = relnamespace JOIN pg_attribute a ON (attrelid = c.oid AND attname = 'oid')
- join [fail]: -         ->  Sort | +         ->  Incremental Sort
- aggregates [fail]: -                     ->  Finalize HashAggregate | +                     ->  Finalize GroupAggregate
- incremental_sort [fail]: -         ->  Sort | -               Sort Key: t2.four, t2.two

Pass in the Durable Object but fail under PGlite in Node (0): 
