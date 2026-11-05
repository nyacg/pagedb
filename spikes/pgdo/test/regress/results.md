# pg_regress results (Nov 5, 2026)

From `python3 test/regress/report.py`. PostgreSQL 18.6, `parallel_schedule`.

| run | pass | fail | hang |
|---|---|---|---|
| native | 231 | 0 | 0 |
| pglite | 191 | 34 | 6 |
| do | 189 | 38 | 4 |

Failures under PGlite (Node), by likely cause:
- C test library (regress.so can't load into wasm) (15): test_setup type_sanity encoding create_function_c create_type create_view triggers lock alter_generic misc misc_functions foreign_data indirect_toast conversion compression_pglz
- other (11): copy copyselect object_address select_views tsearch tsdicts plpgsql copy2 temp prepare event_trigger_login
- hang (6): opr_sanity euc_kr copyencoding infinite_recurse json jsonb
- tablespaces / server filesystem (2): psql largeobject
- parallel query / workers off (2): select_parallel partition_prune
- statistics / autovacuum timing (2): subscription stats
- non-UTF8 encoding conversion (1): collate.icu.utf8
- roles / privileges (1): guc

Fail in the Durable Object but pass under PGlite in Node (4):
- regex [fail]: -ERROR:  invalid regular expression: regular expression is too complex | +ERROR:  invalid regular expression: out of memory
- join_hash [fail]: - multibatch  | - t
- vacuum_parallel [fail]: +ERROR:  could not map shared memory segment "/PostgreSQL.2715341656": Out of memory
- tuplesort [fail]: -           array_agg            |                                                                                         array_agg                            

Pass in the Durable Object but fail under PGlite in Node (2): tsearch tsdicts
