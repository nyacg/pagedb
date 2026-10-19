//! Page output shared by both build modes: sequential 4 MiB part files, and trees whose
//! branch pages are written last (into the pinned region).

use pagedb_core::page::{PageId, PAGES_PER_PART, PAGE_SIZE};
use pagedb_core::tree::{PageSink, PendingTree, TreeBuilder, TreeRoot};
use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::time::Instant;

/// Writes pages into sequential part files of PAGES_PER_PART pages each.
pub struct PartSink {
    dir: PathBuf,
    pub next: PageId,
    part: Option<BufWriter<File>>,
    crcs: Vec<u32>,
    part_hasher: Vec<u8>, // small running digest input: page crcs of the current part
}

impl PartSink {
    pub fn new(dir: &Path) -> Self {
        fs::create_dir_all(dir.join("parts")).unwrap();
        Self { dir: dir.to_path_buf(), next: 0, part: None, crcs: Vec::new(), part_hasher: Vec::new() }
    }

    fn part_path(&self, n: u64) -> PathBuf {
        self.dir.join("parts").join(format!("part-{n:06}"))
    }

    fn close_part(&mut self) {
        if let Some(mut w) = self.part.take() {
            w.flush().unwrap();
            self.crcs.push(pagedb_core::page::crc32(&self.part_hasher));
            self.part_hasher.clear();
        }
    }

    pub fn finish(mut self) -> (u64, Vec<u32>) {
        self.close_part();
        (self.next, self.crcs)
    }
}

impl PageSink for PartSink {
    fn write(&mut self, page: Vec<u8>) -> PageId {
        assert_eq!(page.len(), PAGE_SIZE);
        let id = self.next;
        if id % PAGES_PER_PART == 0 {
            self.close_part();
            self.part = Some(BufWriter::with_capacity(1 << 20, File::create(self.part_path(id / PAGES_PER_PART)).unwrap()));
        }
        self.part.as_mut().unwrap().write_all(&page).unwrap();
        self.part_hasher.extend_from_slice(&page[8..12]); // the page's own crc
        self.next += 1;
        id
    }
}

pub struct Built {
    pub pending: Option<PendingTree>,
    pub root: TreeRoot,
    pub name: String,
    pub first_page: PageId,
    pub pages: u64,
    pub secs: f64,
}

pub fn build_tree(sink: &mut PartSink, tree: u16, name: &str, entries: &mut dyn FnMut(&mut dyn FnMut(&[u8], &[u8]))) -> Built {
    let t0 = Instant::now();
    let first_page = sink.next;
    let mut b = TreeBuilder::new(tree);
    entries(&mut |k, v| b.push(sink, k, v));
    let pending = b.finish_leaves(sink);
    Built { pending: Some(pending), root: TreeRoot::empty(tree), name: name.to_string(), first_page, pages: sink.next - first_page, secs: t0.elapsed().as_secs_f64() }
}

