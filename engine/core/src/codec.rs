//! Values, order-preserving key encoding, row encoding, and JSON output.
//!
//! Keys are memcmp-ordered byte strings, so a B+tree compares them without decoding:
//!   null 0x01 · false 0x02 · true 0x03 · number 0x04 + 8 bytes · string 0x05 + escaped bytes
//! Numbers are IEEE-754 bits with the sign flipped (negatives fully inverted), big-endian.
//! Strings escape 0x00 as 0x00 0xFF and end with 0x00 0x01, so a prefix sorts first.
//! A descending column is the ascending encoding with every byte inverted.
//!
//! Rows are a varint column count, then per column a tag and payload (numbers little-endian
//! f64, strings varint length + UTF-8). Columns are decoded lazily by index.

use std::fmt::Write as _;

#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
}

impl Value {
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Value::Str(s) => Some(s),
            _ => None,
        }
    }
    pub fn as_num(&self) -> Option<f64> {
        match self {
            Value::Num(n) => Some(*n),
            _ => None,
        }
    }
}

impl From<&str> for Value {
    fn from(s: &str) -> Self {
        Value::Str(s.to_string())
    }
}
impl From<String> for Value {
    fn from(s: String) -> Self {
        Value::Str(s)
    }
}
impl From<f64> for Value {
    fn from(n: f64) -> Self {
        Value::Num(n)
    }
}
impl From<i64> for Value {
    fn from(n: i64) -> Self {
        Value::Num(n as f64)
    }
}
impl From<bool> for Value {
    fn from(b: bool) -> Self {
        Value::Bool(b)
    }
}

// ------------------------------------------------------------------ keys

const K_NULL: u8 = 0x01;
const K_FALSE: u8 = 0x02;
const K_TRUE: u8 = 0x03;
const K_NUM: u8 = 0x04;
const K_STR: u8 = 0x05;

fn num_bits(n: f64) -> u64 {
    let n = if n == 0.0 { 0.0 } else if n.is_nan() { f64::NAN } else { n };
    let b = n.to_bits();
    if b >> 63 == 1 {
        !b
    } else {
        b ^ (1 << 63)
    }
}

fn bits_num(b: u64) -> f64 {
    f64::from_bits(if b >> 63 == 1 { b ^ (1 << 63) } else { !b })
}

/// Append one key element. `desc` inverts its bytes.
pub fn encode_key_part(out: &mut Vec<u8>, v: &Value, desc: bool) {
    let start = out.len();
    match v {
        Value::Null => out.push(K_NULL),
        Value::Bool(false) => out.push(K_FALSE),
        Value::Bool(true) => out.push(K_TRUE),
        Value::Num(n) => {
            out.push(K_NUM);
            out.extend_from_slice(&num_bits(*n).to_be_bytes());
        }
        Value::Str(s) => {
            out.push(K_STR);
            for &b in s.as_bytes() {
                out.push(b);
                if b == 0 {
                    out.push(0xFF);
                }
            }
            out.extend_from_slice(&[0x00, 0x01]);
        }
    }
    if desc {
        for b in &mut out[start..] {
            *b = !*b;
        }
    }
}

/// Encode a composite key; `desc[i]` marks descending columns.
pub fn encode_key(values: &[Value], desc: &[bool]) -> Vec<u8> {
    let mut out = Vec::with_capacity(32);
    for (i, v) in values.iter().enumerate() {
        encode_key_part(&mut out, v, desc.get(i).copied().unwrap_or(false));
    }
    out
}

/// Decode a composite key back into values (used by tests, debugging and the overlay).
pub fn decode_key(mut key: &[u8], desc: &[bool]) -> Vec<Value> {
    let mut out = Vec::new();
    let mut i = 0;
    while !key.is_empty() {
        let d = desc.get(i).copied().unwrap_or(false);
        let byte = |b: u8| if d { !b } else { b };
        let tag = byte(key[0]);
        match tag {
            K_NULL => {
                out.push(Value::Null);
                key = &key[1..];
            }
            K_FALSE | K_TRUE => {
                out.push(Value::Bool(tag == K_TRUE));
                key = &key[1..];
            }
            K_NUM => {
                let mut b = [0u8; 8];
                for j in 0..8 {
                    b[j] = byte(key[1 + j]);
                }
                out.push(Value::Num(bits_num(u64::from_be_bytes(b))));
                key = &key[9..];
            }
            K_STR => {
                let mut s = Vec::new();
                let mut j = 1;
                loop {
                    let b = byte(key[j]);
                    if b == 0 {
                        if byte(key[j + 1]) == 0xFF {
                            s.push(0);
                            j += 2;
                            continue;
                        }
                        j += 2;
                        break;
                    }
                    s.push(b);
                    j += 1;
                }
                out.push(Value::Str(String::from_utf8(s).unwrap_or_default()));
                key = &key[j..];
            }
            _ => panic!("bad key tag {tag:#x}"),
        }
        i += 1;
    }
    out
}

/// Smallest key strictly greater than every key with this prefix (for prefix range scans).
pub fn prefix_end(prefix: &[u8]) -> Vec<u8> {
    let mut end = prefix.to_vec();
    while let Some(last) = end.pop() {
        if last != 0xFF {
            end.push(last + 1);
            return end;
        }
    }
    vec![0xFF; 1] // unreachable for real keys (tags are < 0xFF)
}

// ------------------------------------------------------------------ varints

pub fn put_varint(out: &mut Vec<u8>, mut v: u64) {
    while v >= 0x80 {
        out.push((v as u8) | 0x80);
        v >>= 7;
    }
    out.push(v as u8);
}

#[inline]
pub fn get_varint(buf: &[u8], pos: &mut usize) -> u64 {
    let mut v = 0u64;
    let mut shift = 0;
    loop {
        let b = buf[*pos];
        *pos += 1;
        v |= ((b & 0x7F) as u64) << shift;
        if b < 0x80 {
            return v;
        }
        shift += 7;
    }
}

// ------------------------------------------------------------------ rows

const R_NULL: u8 = 0;
const R_FALSE: u8 = 1;
const R_TRUE: u8 = 2;
const R_NUM: u8 = 3;
const R_STR: u8 = 4;

pub fn encode_row(values: &[Value]) -> Vec<u8> {
    let mut out = Vec::with_capacity(64);
    put_varint(&mut out, values.len() as u64);
    for v in values {
        match v {
            Value::Null => out.push(R_NULL),
            Value::Bool(false) => out.push(R_FALSE),
            Value::Bool(true) => out.push(R_TRUE),
            Value::Num(n) => {
                out.push(R_NUM);
                out.extend_from_slice(&n.to_le_bytes());
            }
            Value::Str(s) => {
                out.push(R_STR);
                put_varint(&mut out, s.len() as u64);
                out.extend_from_slice(s.as_bytes());
            }
        }
    }
    out
}

/// A borrowed, lazily decoded row.
#[derive(Clone, Copy)]
pub struct RowRef<'a>(pub &'a [u8]);

/// One column of a row, borrowed.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Cell<'a> {
    Null,
    Bool(bool),
    Num(f64),
    Str(&'a str),
}

impl<'a> Cell<'a> {
    pub fn to_value(self) -> Value {
        match self {
            Cell::Null => Value::Null,
            Cell::Bool(b) => Value::Bool(b),
            Cell::Num(n) => Value::Num(n),
            Cell::Str(s) => Value::Str(s.to_string()),
        }
    }
    pub fn str(self) -> &'a str {
        match self {
            Cell::Str(s) => s,
            _ => "",
        }
    }
    pub fn num(self) -> f64 {
        match self {
            Cell::Num(n) => n,
            _ => 0.0,
        }
    }
    pub fn eq_value(self, v: &Value) -> bool {
        match (self, v) {
            (Cell::Null, Value::Null) => true,
            (Cell::Bool(a), Value::Bool(b)) => a == *b,
            (Cell::Num(a), Value::Num(b)) => a == *b,
            (Cell::Str(a), Value::Str(b)) => a == b,
            _ => false,
        }
    }
}

impl<'a> RowRef<'a> {
    pub fn len(&self) -> usize {
        let mut p = 0;
        get_varint(self.0, &mut p) as usize
    }

    pub fn cells(&self) -> RowCells<'a> {
        let mut pos = 0;
        let n = get_varint(self.0, &mut pos) as usize;
        RowCells { buf: self.0, pos, left: n }
    }

    pub fn get(&self, idx: usize) -> Cell<'a> {
        self.cells().nth(idx).unwrap_or(Cell::Null)
    }

    pub fn to_values(&self) -> Vec<Value> {
        self.cells().map(|c| c.to_value()).collect()
    }
}

pub struct RowCells<'a> {
    buf: &'a [u8],
    pos: usize,
    left: usize,
}

impl<'a> Iterator for RowCells<'a> {
    type Item = Cell<'a>;
    #[inline]
    fn next(&mut self) -> Option<Cell<'a>> {
        if self.left == 0 {
            return None;
        }
        self.left -= 1;
        let tag = self.buf[self.pos];
        self.pos += 1;
        Some(match tag {
            R_NULL => Cell::Null,
            R_FALSE => Cell::Bool(false),
            R_TRUE => Cell::Bool(true),
            R_NUM => {
                let n = f64::from_le_bytes(self.buf[self.pos..self.pos + 8].try_into().unwrap());
                self.pos += 8;
                Cell::Num(n)
            }
            _ => {
                let len = get_varint(self.buf, &mut self.pos) as usize;
                let s = &self.buf[self.pos..self.pos + len];
                self.pos += len;
                // Rows are only ever written by encode_row from &str.
                Cell::Str(unsafe { std::str::from_utf8_unchecked(s) })
            }
        })
    }
}

// ------------------------------------------------------------------ JSON

pub fn json_str(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

pub fn json_cell(out: &mut String, c: Cell) {
    match c {
        Cell::Null => out.push_str("null"),
        Cell::Bool(b) => out.push_str(if b { "true" } else { "false" }),
        Cell::Num(n) => {
            if n.is_finite() && n.fract() == 0.0 && n.abs() < 9.0e15 {
                let _ = write!(out, "{}", n as i64);
            } else if n.is_finite() {
                let _ = write!(out, "{}", n);
            } else {
                out.push_str("null");
            }
        }
        Cell::Str(s) => json_str(out, s),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn arb_value() -> impl Strategy<Value = Value> {
        prop_oneof![
            Just(Value::Null),
            any::<bool>().prop_map(Value::Bool),
            any::<f64>().prop_filter("finite", |n| n.is_finite()).prop_map(Value::Num),
            (-1e6f64..1e6).prop_map(Value::Num),
            ".{0,12}".prop_map(Value::Str),
            proptest::collection::vec(0u8..4, 0..6).prop_map(|b| Value::Str(b.iter().map(|&x| (x + b'a') as char).collect())),
        ]
    }

    fn cmp_values(a: &[Value], b: &[Value], desc: &[bool]) -> std::cmp::Ordering {
        use std::cmp::Ordering::*;
        fn rank(v: &Value) -> u8 {
            match v {
                Value::Null => 0,
                Value::Bool(false) => 1,
                Value::Bool(true) => 2,
                Value::Num(_) => 3,
                Value::Str(_) => 4,
            }
        }
        for i in 0..a.len().min(b.len()) {
            let o = match (&a[i], &b[i]) {
                (Value::Num(x), Value::Num(y)) => x.partial_cmp(y).unwrap(),
                (Value::Str(x), Value::Str(y)) => x.as_bytes().cmp(y.as_bytes()),
                (x, y) => rank(x).cmp(&rank(y)),
            };
            let o = if desc.get(i).copied().unwrap_or(false) { o.reverse() } else { o };
            if o != Equal {
                return o;
            }
        }
        a.len().cmp(&b.len())
    }

    proptest! {
        #[test]
        fn key_order_matches_value_order(a in proptest::collection::vec(arb_value(), 1..4),
                                         b in proptest::collection::vec(arb_value(), 1..4),
                                         desc in proptest::collection::vec(any::<bool>(), 4)) {
            let n = a.len().min(b.len());
            let (a, b) = (&a[..n], &b[..n]);
            let ka = encode_key(a, &desc);
            let kb = encode_key(b, &desc);
            let expected = cmp_values(a, b, &desc);
            // -0.0 == 0.0 as values; encoding normalizes, so equal is fine either way.
            if expected != std::cmp::Ordering::Equal {
                prop_assert_eq!(ka.cmp(&kb), expected);
            }
        }

        #[test]
        fn key_roundtrip(a in proptest::collection::vec(arb_value(), 1..4), desc in proptest::collection::vec(any::<bool>(), 4)) {
            let k = encode_key(&a, &desc);
            let back = decode_key(&k, &desc);
            prop_assert_eq!(back.len(), a.len());
            for (x, y) in back.iter().zip(a.iter()) {
                match (x, y) {
                    (Value::Num(p), Value::Num(q)) => prop_assert!(p == q),
                    _ => prop_assert_eq!(x, y),
                }
            }
        }

        #[test]
        fn row_roundtrip(a in proptest::collection::vec(arb_value(), 0..10)) {
            let r = encode_row(&a);
            prop_assert_eq!(RowRef(&r).to_values(), a);
        }
    }

    #[test]
    fn prefix_scan_bounds() {
        let p = encode_key(&[Value::from("proj-1")], &[false]);
        let inside = encode_key(&[Value::from("proj-1"), Value::from(5.0)], &[false, true]);
        let outside = encode_key(&[Value::from("proj-10")], &[false]);
        let end = prefix_end(&p);
        assert!(inside.as_slice() >= p.as_slice() && inside.as_slice() < end.as_slice());
        assert!(outside.as_slice() >= end.as_slice() || outside.as_slice() < p.as_slice());
    }
}
