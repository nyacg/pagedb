-- One tenant's database for the many-tenants benchmark: the bench tables at 10k rows each.
create table acct (id int primary key, bal bigint not null default 0, note text);
create table docs (id int primary key, owner int not null, data jsonb not null);
create index docs_gin on docs using gin (data jsonb_path_ops);
create table scratch (id int, data jsonb);
insert into acct (id, note) select g, 'n' || g from generate_series(1, 10000) g;
insert into docs select g, g % 1000, jsonb_build_object('name', 'doc ' || g, 'tags', jsonb_build_array('t' || (g % 50), 't' || (g % 7)), 'n', g,
  'nested', jsonb_build_object('score', g % 100, 'flags', jsonb_build_array(g % 2 = 0, g % 3 = 0))) from generate_series(1, 10000) g;
