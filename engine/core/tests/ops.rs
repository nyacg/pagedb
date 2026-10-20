//! Update ops beyond `set`: `add` (counters) and `splice` (a pixel in a tile), on a schema
//! that isn't the tracker's.
use pagedb_core::build::build_tables;
use pagedb_core::catalog::Schema;
use pagedb_core::codec::Value;
use pagedb_core::overlay::{Overlay, View};
use pagedb_core::page::PageId;
use pagedb_core::query::read_row;
use pagedb_core::tree::{Ctx, PageStore};
use pagedb_core::write::{parse_ops, plan_write, WriteError};
use serde_json::json;
use std::rc::Rc;

struct All<'a>(&'a [Rc<[u8]>]);
impl PageStore for All<'_> {
    fn get(&self, id: PageId) -> Option<Rc<[u8]>> {
        self.0.get(id as usize).cloned()
    }
}

#[test]
fn add_and_splice() {
    let schema = Schema::parse(
        r#"{"tables":[{"name":"tile","columns":["id","px",{"name":"n","type":"number"}]}],
            "indexes":[{"tree":1,"name":"tile_by_id","table":"tile","key":["id"],"primary":true}]}"#,
    )
    .unwrap();
    let rows = vec![vec![Value::from("0:0"), Value::from("AAAA"), Value::Num(1.0)]];
    let db = build_tables(schema, &[&rows], &|_| None);
    let store = All(&db.pages);
    let overlay = Overlay::default();
    let run = |ops: serde_json::Value| -> Result<Vec<Value>, String> {
        let view = View::new(&overlay);
        let ctx = Ctx::with_view(&store, &view);
        let ops = parse_ops(schema, &ops)?;
        plan_write(&ctx, &db.roots, &view, &ops).map_err(|e| match e {
            WriteError::Invalid(m) => m,
            WriteError::Miss => "miss".into(),
        })?;
        Ok(read_row(&ctx, &db.roots, 0, "0:0").unwrap().unwrap())
    };
    let r = run(json!({"ops":[{"op":"update","table":"tile","id":"0:0","splice":{"px":[2,"Z"]},"add":{"n":2}}]})).unwrap();
    assert_eq!(r[1], Value::from("AAZA"));
    assert_eq!(r[2], Value::Num(3.0));
    assert!(run(json!({"ops":[{"op":"update","table":"tile","id":"0:0","splice":{"px":[3,"ZZ"]}}]})).unwrap_err().contains("splice outside"));
    assert!(run(json!({"ops":[{"op":"update","table":"tile","id":"0:0","add":{"id":1}}]})).is_err());
}
