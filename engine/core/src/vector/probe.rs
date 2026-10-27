//! The probe tier: one bit per dimension (RaBitQ-style) so a search can score many candidates
//! per page, then rerank the best with finer codes.
//!
//! A vector v in cluster c has residual r = v − c. With ŷ = R(r / ‖r‖) (R = the fixed random
//! rotation, kernels::rotate) the entry stores the signs of ŷ as bits and one f32,
//!   w = ‖r‖ / (√D · Σ|ŷ_d| / √D) = ‖r‖ / Σ|ŷ_d|,
//! and estimates q·r as  w · Σ_d sign(ŷ_d) · (Rq)_d  (RaBitQ's estimator: ⟨x̄, Rq⟩ / ⟨x̄, ŷ⟩ · ‖r‖,
//! with x̄ = sign(ŷ)/√D). The query side is quantized to 4 bits and split into bit planes, so
//! scoring a vector is 4 · D/64 popcounts (no lookup table: one would be D/8 × 256 entries,
//! more than L1 holds).
//!
//! Entry value: w f32 ‖ bits[D/8] ‖ encode_row(probe columns).

use super::kernels::rotate;
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

/// The query side: the rotated query quantized to 4 bits, q̂_d = lo + Δ·u_d (u_d in 0..=15),
/// as four bit planes. With b the entry's sign bits, Σ_d sign_d·q̂_d = 2·Σ_{b_d=1} q̂_d − Σ_d q̂_d
/// and Σ_{b_d=1} q̂_d = lo·|b| + Δ·Σ_k 2^k·|b ∧ plane_k|.
pub struct ProbeScorer {
    planes: [Vec<u64>; 4],
    lo: f32,
    delta: f32,
    sum: f32,
}

impl ProbeScorer {
    pub fn new(q: &[f32]) -> ProbeScorer {
        let mut qr = q.to_vec();
        rotate(&mut qr);
        let lo = qr.iter().copied().fold(f32::INFINITY, f32::min);
        let hi = qr.iter().copied().fold(f32::NEG_INFINITY, f32::max);
        let delta = if hi > lo { (hi - lo) / 15.0 } else { 1.0 };
        let words = qr.len() / 64;
        let mut planes: [Vec<u64>; 4] = std::array::from_fn(|_| vec![0u64; words]);
        let mut sum = 0f32;
        for (d, &x) in qr.iter().enumerate() {
            let u = ((x - lo) / delta).round().clamp(0.0, 15.0) as u32;
            sum += lo + delta * u as f32;
            for (k, plane) in planes.iter_mut().enumerate() {
                if u >> k & 1 == 1 {
                    plane[d / 64] |= 1 << (d % 64);
                }
            }
        }
        ProbeScorer { planes, lo, delta, sum }
    }

    /// Estimated q·r for an entry's (w, bits).
    #[inline]
    pub fn estimate(&self, w: f32, bits: &[u8]) -> f32 {
        let (mut ones, mut acc) = (0u32, [0u32; 4]);
        for (i, b) in bits.chunks_exact(8).enumerate() {
            let b = u64::from_le_bytes(b.try_into().unwrap());
            ones += b.count_ones();
            for k in 0..4 {
                acc[k] += (b & self.planes[k][i]).count_ones();
            }
        }
        let weighted = acc[0] + 2 * acc[1] + 4 * acc[2] + 8 * acc[3];
        w * (2.0 * (self.lo * ones as f32 + self.delta * weighted as f32) - self.sum)
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
