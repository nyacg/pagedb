//! 64 KiB pages. A page is read in place: a slot directory points at cells, keys are compared
//! as bytes, values are only decoded for rows that are emitted.
//!
//! ```text
//! 0   u16 magic "PD"     2 u8 kind (1 leaf, 2 branch)   3 u8 level (0 = leaf)
//! 4   u16 tree           6 u16 cell count               8 u32 crc32 of bytes [12..PAGE_SIZE]
//! 12  u32 used bytes     16 u64 rows in this subtree (leaf: = cell count)
//! 24  u16 slot[count]    cell offsets, in key order
//! ... cells
//!     leaf:   varint klen, key, varint vlen, value
//!     branch: varint klen, key (first key of the child), u48 child page id, u40 child row count
//! ```
//! Page id = part × PAGES_PER_PART + slot, so its R2 location is arithmetic, not a lookup.

use crate::codec::{get_varint, put_varint};

pub const PAGE_SIZE: usize = 64 * 1024;
pub const PAGES_PER_PART: u64 = 64; // 4 MiB parts
pub const HEADER: usize = 24;
const MAGIC: u16 = 0x5044;
pub const LEAF: u8 = 1;
pub const BRANCH: u8 = 2;
/// Largest cell we accept, so every page holds at least 3 cells.
pub const MAX_CELL: usize = (PAGE_SIZE - HEADER) / 3 - 2;

pub type PageId = u64;

pub fn part_of(id: PageId) -> (u64, usize) {
    (id / PAGES_PER_PART, ((id % PAGES_PER_PART) as usize) * PAGE_SIZE)
}

// ------------------------------------------------------------------ crc32 (IEEE)

const fn crc_table() -> [u32; 256] {
    let mut t = [0u32; 256];
    let mut i = 0;
    while i < 256 {
        let mut c = i as u32;
        let mut k = 0;
        while k < 8 {
            c = if c & 1 != 0 { 0xEDB88320 ^ (c >> 1) } else { c >> 1 };
            k += 1;
        }
        t[i] = c;
        i += 1;
    }
    t
}
static CRC: [u32; 256] = crc_table();

pub fn crc32(data: &[u8]) -> u32 {
    let mut c = 0xFFFF_FFFFu32;
    for &b in data {
        c = CRC[((c ^ b as u32) & 0xFF) as usize] ^ (c >> 8);
    }
    c ^ 0xFFFF_FFFF
}

// ------------------------------------------------------------------ builder

/// Accumulates cells for one page; `fits` before `push`, then `finish`.
pub struct PageBuilder {
    kind: u8,
    level: u8,
    tree: u16,
    cells: Vec<u8>,
    offsets: Vec<u32>,
    rows: u64,
    first_key: Vec<u8>,
}

impl PageBuilder {
    pub fn new(kind: u8, level: u8, tree: u16) -> Self {
        Self { kind, level, tree, cells: Vec::with_capacity(PAGE_SIZE), offsets: Vec::new(), rows: 0, first_key: Vec::new() }
    }

    pub fn is_empty(&self) -> bool {
        self.offsets.is_empty()
    }

    pub fn first_key(&self) -> &[u8] {
        &self.first_key
    }

    pub fn rows(&self) -> u64 {
        self.rows
    }

    fn used_after(&self, cell_len: usize) -> usize {
        HEADER + 2 * (self.offsets.len() + 1) + self.cells.len() + cell_len
    }

    pub fn leaf_cell_len(key: &[u8], val: &[u8]) -> usize {
        varint_len(key.len() as u64) + key.len() + varint_len(val.len() as u64) + val.len()
    }

    pub fn branch_cell_len(key: &[u8]) -> usize {
        varint_len(key.len() as u64) + key.len() + 11
    }

    pub fn fits(&self, cell_len: usize) -> bool {
        self.used_after(cell_len) <= PAGE_SIZE
    }

    pub fn push_leaf(&mut self, key: &[u8], val: &[u8]) {
        debug_assert!(self.kind == LEAF);
        if self.offsets.is_empty() {
            self.first_key = key.to_vec();
        }
        self.offsets.push(self.cells.len() as u32);
        put_varint(&mut self.cells, key.len() as u64);
        self.cells.extend_from_slice(key);
        put_varint(&mut self.cells, val.len() as u64);
        self.cells.extend_from_slice(val);
        self.rows += 1;
    }

    pub fn push_branch(&mut self, key: &[u8], child: PageId, rows: u64) {
        debug_assert!(self.kind == BRANCH);
        if self.offsets.is_empty() {
            self.first_key = key.to_vec();
        }
        self.offsets.push(self.cells.len() as u32);
        put_varint(&mut self.cells, key.len() as u64);
        self.cells.extend_from_slice(key);
        self.cells.extend_from_slice(&child.to_le_bytes()[..6]);
        self.cells.extend_from_slice(&rows.to_le_bytes()[..5]);
        self.rows += rows;
    }

    /// Lay out header, slots and cells into a full 64 KiB page.
    pub fn finish(&self) -> Vec<u8> {
        let n = self.offsets.len();
        let mut page = vec![0u8; PAGE_SIZE];
        let cell_base = HEADER + 2 * n;
        page[0..2].copy_from_slice(&MAGIC.to_le_bytes());
        page[2] = self.kind;
        page[3] = self.level;
        page[4..6].copy_from_slice(&self.tree.to_le_bytes());
        page[6..8].copy_from_slice(&(n as u16).to_le_bytes());
        page[12..16].copy_from_slice(&((cell_base + self.cells.len()) as u32).to_le_bytes());
        page[16..24].copy_from_slice(&self.rows.to_le_bytes());
        for (i, &off) in self.offsets.iter().enumerate() {
            let abs = (cell_base + off as usize) as u16;
            page[HEADER + 2 * i..HEADER + 2 * i + 2].copy_from_slice(&abs.to_le_bytes());
        }
        page[cell_base..cell_base + self.cells.len()].copy_from_slice(&self.cells);
        let crc = crc32(&page[12..]);
        page[8..12].copy_from_slice(&crc.to_le_bytes());
        page
    }
}

pub fn varint_len(mut v: u64) -> usize {
    let mut n = 1;
    while v >= 0x80 {
        v >>= 7;
        n += 1;
    }
    n
}

// ------------------------------------------------------------------ reader

/// A page read in place.
#[derive(Clone, Copy)]
pub struct Page<'a>(pub &'a [u8]);

impl<'a> Page<'a> {
    pub fn check(bytes: &[u8]) -> Result<(), &'static str> {
        if bytes.len() != PAGE_SIZE {
            return Err("bad page size");
        }
        if u16::from_le_bytes([bytes[0], bytes[1]]) != MAGIC {
            return Err("bad page magic");
        }
        let crc = u32::from_le_bytes(bytes[8..12].try_into().unwrap());
        if crc32(&bytes[12..]) != crc {
            return Err("page checksum mismatch");
        }
        Ok(())
    }

    #[inline]
    pub fn kind(&self) -> u8 {
        self.0[2]
    }
    #[inline]
    pub fn level(&self) -> u8 {
        self.0[3]
    }
    #[inline]
    pub fn tree(&self) -> u16 {
        u16::from_le_bytes([self.0[4], self.0[5]])
    }
    #[inline]
    pub fn count(&self) -> usize {
        u16::from_le_bytes([self.0[6], self.0[7]]) as usize
    }
    #[inline]
    pub fn rows(&self) -> u64 {
        u64::from_le_bytes(self.0[16..24].try_into().unwrap())
    }
    #[inline]
    fn cell(&self, i: usize) -> usize {
        u16::from_le_bytes([self.0[HEADER + 2 * i], self.0[HEADER + 2 * i + 1]]) as usize
    }

    #[inline]
    pub fn key(&self, i: usize) -> &'a [u8] {
        let mut p = self.cell(i);
        let len = get_varint(self.0, &mut p) as usize;
        &self.0[p..p + len]
    }

    /// Leaf: (key, value).
    #[inline]
    pub fn entry(&self, i: usize) -> (&'a [u8], &'a [u8]) {
        let mut p = self.cell(i);
        let klen = get_varint(self.0, &mut p) as usize;
        let key = &self.0[p..p + klen];
        p += klen;
        let vlen = get_varint(self.0, &mut p) as usize;
        (key, &self.0[p..p + vlen])
    }

    /// Branch: (first key of child, child id, rows under child).
    #[inline]
    pub fn child(&self, i: usize) -> (&'a [u8], PageId, u64) {
        let mut p = self.cell(i);
        let klen = get_varint(self.0, &mut p) as usize;
        let key = &self.0[p..p + klen];
        p += klen;
        let mut id = [0u8; 8];
        id[..6].copy_from_slice(&self.0[p..p + 6]);
        let mut rows = [0u8; 8];
        rows[..5].copy_from_slice(&self.0[p + 6..p + 11]);
        (key, u64::from_le_bytes(id), u64::from_le_bytes(rows))
    }

    /// First index whose key is >= `key` (count if none).
    #[inline]
    pub fn lower_bound(&self, key: &[u8]) -> usize {
        let (mut lo, mut hi) = (0, self.count());
        while lo < hi {
            let mid = (lo + hi) / 2;
            if self.key(mid) < key {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        lo
    }

    /// Branch: index of the child whose range contains `key` (last child with first key <= key).
    #[inline]
    pub fn child_for(&self, key: &[u8]) -> usize {
        let (mut lo, mut hi) = (0, self.count());
        while lo < hi {
            let mid = (lo + hi) / 2;
            if self.key(mid) <= key {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        lo.saturating_sub(1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn leaf_roundtrip_and_search() {
        let mut b = PageBuilder::new(LEAF, 0, 7);
        let mut keys = Vec::new();
        for i in 0..1000u32 {
            let k = format!("key-{i:06}").into_bytes();
            let v = vec![i as u8; (i % 50) as usize];
            if !b.fits(PageBuilder::leaf_cell_len(&k, &v)) {
                break;
            }
            b.push_leaf(&k, &v);
            keys.push((k, v));
        }
        let bytes = b.finish();
        Page::check(&bytes).unwrap();
        let p = Page(&bytes);
        assert_eq!(p.count(), keys.len());
        assert_eq!(p.tree(), 7);
        for (i, (k, v)) in keys.iter().enumerate() {
            let (pk, pv) = p.entry(i);
            assert_eq!(pk, k.as_slice());
            assert_eq!(pv, v.as_slice());
            assert_eq!(p.lower_bound(k), i);
        }
        let mut bad = bytes.clone();
        bad[100] ^= 1;
        assert!(Page::check(&bad).is_err());
    }
}
