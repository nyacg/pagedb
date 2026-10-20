//! The probe tier: one bit per dimension (RaBitQ-style) so a search can score many candidates
//! per page, then rerank the best with finer codes.
//!
//! A vector v in cluster c has residual r = v − c. With ŷ = R(r / ‖r‖) (R = the fixed random
//! rotation, kernels::rotate) the entry stores the signs of ŷ as bits and one f32,
//!   w = ‖r‖ / (√D · Σ|ŷ_d| / √D) = ‖r‖ / Σ|ŷ_d|,
//! and estimates q·r as  w · Σ_d sign(ŷ_d) · (Rq)_d  (RaBitQ's estimator: ⟨x̄, Rq⟩ / ⟨x̄, ŷ⟩ · ‖r‖,
//! with x̄ = sign(ŷ)/√D). The query side is quantized to i8 and turned into byte lookup tables,
//! so scoring a vector is D/8 table lookups.
//!
//! Entry value: w f32 ‖ bits[D/8] ‖ encode_row(probe columns).

use super::kernels::rotate;
use super::quantize;
use crate::codec::{encode_row, RowRef, Value};

/// The probe entry for normalized `v` against the (dequantized) centroid `c`.
pub fn encode(v: &[f32], c: &[f32], row: &[Value]) -> Vec<u8> {
    let d = v.len();
    let mut r: Vec<f32> = v.iter().zip(c).map(|(a, b)| a - b).collect();
    let norm = r.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > 0.0 {
        r.iter_mut().for_each(|x| *x /= norm);
    }
    rotate(&mut r);
    let l1: f32 = r.iter().map(|x| x.abs()).sum();
    let w = if l1 > 0.0 { norm / l1 } else { 0.0 };
    let mut out = Vec::with_capacity(4 + d / 8 + 16);
    out.extend_from_slice(&w.to_le_bytes());
    for j in 0..d / 8 {
        let mut b = 0u8;
        for k in 0..8 {
            if r[8 * j + k] >= 0.0 {
                b |= 1 << k;
            }
        }
        out.push(b);
    }
    out.extend(encode_row(row));
    out
}

/// (w, bits, row) of a probe entry.
#[inline]
pub fn split(dims: usize, v: &[u8]) -> (f32, &[u8], RowRef<'_>) {
    let w = f32::from_le_bytes(v[..4].try_into().unwrap());
    (w, &v[4..4 + dims / 8], RowRef(&v[4 + dims / 8..]))
}

/// The query side: byte lookup tables over the rotated, quantized query.
pub struct ProbeScorer {
    table: Vec<i32>,
    alpha: f32,
}

impl ProbeScorer {
    pub fn new(q: &[f32]) -> ProbeScorer {
        let mut qr = q.to_vec();
        rotate(&mut qr);
        let (q8, alpha) = quantize(&qr);
        let groups = q8.len() / 8;
        let mut table = vec![0i32; groups * 256];
        for j in 0..groups {
            let g = &q8[8 * j..8 * j + 8];
            let t = &mut table[j * 256..(j + 1) * 256];
            t[0] = -g.iter().map(|&x| x as i32).sum::<i32>();
            for byte in 1..256usize {
                // Same as the byte without its lowest set bit, with that dimension's sign flipped.
                let low = byte.trailing_zeros() as usize;
                t[byte] = t[byte & (byte - 1)] + 2 * g[low] as i32;
            }
        }
        ProbeScorer { table, alpha }
    }

    /// Estimated q·r for an entry's (w, bits).
    #[inline]
    pub fn estimate(&self, w: f32, bits: &[u8]) -> f32 {
        let mut s = 0i32;
        for (j, &b) in bits.iter().enumerate() {
            s += self.table[j * 256 + b as usize];
        }
        w * self.alpha * s as f32
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vector::normalize;

    #[test]
    fn estimates_track_the_true_residual_dot() {
        let d = 1024;
        let mut x = 12345u32;
        let mut rnd = || {
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            (x % 20001) as f32 / 10000.0 - 1.0
        };
        let (mut err, mut n) = (0f32, 0);
        for _ in 0..50 {
            let mut v: Vec<f32> = (0..d).map(|_| rnd()).collect();
            normalize(&mut v);
            let c: Vec<f32> = v.iter().map(|a| a * 0.7).collect();
            let mut q: Vec<f32> = v.iter().map(|a| a + 0.3 * rnd() / (d as f32).sqrt()).collect();
            normalize(&mut q);
            let e = encode(&v, &c, &[]);
            let (w, bits, _) = split(d, &e);
            let est = ProbeScorer::new(&q).estimate(w, bits);
            let truth: f32 = q.iter().zip(v.iter().zip(&c)).map(|(q, (v, c))| q * (v - c)).sum();
            err += (est - truth).abs();
            n += 1;
        }
        // The residual dot is ~0.3 here; the 1-bit estimate is within a few percent of it.
        assert!(err / (n as f32) < 0.02, "mean abs error {}", err / n as f32);
    }
}
