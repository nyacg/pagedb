//! PVEC shards: embeddings as the model returned them (full dims, f16), each with the JSON row
//! it belongs to. They are the source of truth for vector indexes: an index at other dims, or
//! with other clusters, is rebuilt from shards without calling the model again.
//!
//! ```text
//! "PVEC" | u32 version = 1 | u32 dims | u32 count | count × (u32 json_len | json | f16[dims])
//! ```

pub const MAGIC: &[u8; 4] = b"PVEC";

pub fn encode(dims: usize, items: &[(String, Vec<f32>)]) -> Vec<u8> {
    let mut out = Vec::with_capacity(16 + items.iter().map(|(j, _)| 4 + j.len() + 2 * dims).sum::<usize>());
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&1u32.to_le_bytes());
    out.extend_from_slice(&(dims as u32).to_le_bytes());
    out.extend_from_slice(&(items.len() as u32).to_le_bytes());
    for (json, v) in items {
        assert_eq!(v.len(), dims);
        out.extend_from_slice(&(json.len() as u32).to_le_bytes());
        out.extend_from_slice(json.as_bytes());
        for &x in v {
            out.extend_from_slice(&f32_to_f16(x).to_le_bytes());
        }
    }
    out
}

/// Every (row JSON, vector) of a shard.
pub fn decode(b: &[u8]) -> Result<(usize, Vec<(String, Vec<f32>)>), String> {
    if b.len() < 16 || &b[..4] != MAGIC {
        return Err("not a PVEC shard".into());
    }
    let u32_at = |p: usize| u32::from_le_bytes(b[p..p + 4].try_into().unwrap()) as usize;
    let (dims, count) = (u32_at(8), u32_at(12));
    let mut items = Vec::with_capacity(count);
    let mut p = 16;
    for _ in 0..count {
        if p + 4 > b.len() {
            return Err("truncated shard".into());
        }
        let jl = u32_at(p);
        p += 4;
        if p + jl + 2 * dims > b.len() {
            return Err("truncated shard".into());
        }
        let json = String::from_utf8(b[p..p + jl].to_vec()).map_err(|_| "row is not UTF-8")?;
        p += jl;
        let v = (0..dims).map(|i| f16_to_f32(u16::from_le_bytes([b[p + 2 * i], b[p + 2 * i + 1]]))).collect();
        p += 2 * dims;
        items.push((json, v));
    }
    Ok((dims, items))
}

pub fn f32_to_f16(x: f32) -> u16 {
    let b = x.to_bits();
    let sign = ((b >> 16) & 0x8000) as u16;
    let exp = ((b >> 23) & 0xff) as i32;
    let man = b & 0x7f_ffff;
    if exp == 0xff {
        return sign | 0x7c00 | if man != 0 { 0x200 } else { 0 };
    }
    let e = exp - 127 + 15;
    if e >= 0x1f {
        return sign | 0x7c00;
    }
    if e <= 0 {
        if e < -10 {
            return sign;
        }
        // Subnormal: shift the implicit bit in, round to nearest even.
        let m = man | 0x80_0000;
        let shift = (14 - e) as u32;
        let half = 1u32 << (shift - 1);
        let rounded = (m + half - 1 + ((m >> shift) & 1)) >> shift;
        return sign | rounded as u16;
    }
    let mut h = (sign as u32) | ((e as u32) << 10) | (man >> 13);
    // Round to nearest even on the dropped 13 bits (a carry into the exponent is correct).
    let rest = man & 0x1fff;
    if rest > 0x1000 || (rest == 0x1000 && (h & 1) == 1) {
        h += 1;
    }
    h as u16
}

pub fn f16_to_f32(h: u16) -> f32 {
    let sign = ((h & 0x8000) as u32) << 16;
    let exp = ((h >> 10) & 0x1f) as u32;
    let man = (h & 0x3ff) as u32;
    let bits = match exp {
        0 if man == 0 => sign,
        0 => {
            // Subnormal: normalize.
            let mut e = 127 - 15 + 1;
            let mut m = man;
            while m & 0x400 == 0 {
                m <<= 1;
                e -= 1;
            }
            sign | ((e as u32) << 23) | ((m & 0x3ff) << 13)
        }
        0x1f => sign | 0x7f80_0000 | (man << 13),
        _ => sign | ((exp + 127 - 15) << 23) | (man << 13),
    };
    f32::from_bits(bits)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn f16_roundtrip() {
        for x in [0.0f32, 1.0, -1.0, 0.5, 0.1234, -0.0731, 65504.0, 6.1e-5, 3.0e-7, 1e-3] {
            let y = f16_to_f32(f32_to_f16(x));
            assert!((x - y).abs() <= x.abs() * 1e-3 + 1e-7, "{x} → {y}");
        }
        for h in 0u16..0x7c00 {
            assert_eq!(f32_to_f16(f16_to_f32(h)), h, "h={h:#x}");
        }
    }

    #[test]
    fn shard_roundtrip() {
        let items = vec![("{\"id\":\"1\"}".to_string(), vec![0.5f32, -0.25, 0.125]), ("{\"id\":\"2\"}".to_string(), vec![0.0, 1.0, -1.0])];
        let (dims, got) = decode(&encode(3, &items)).unwrap();
        assert_eq!(dims, 3);
        assert_eq!(got, items);
    }
}
