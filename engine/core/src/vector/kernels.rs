//! Distance kernels. In the Durable Object (wasm32 with simd128) the i8 dot product runs on
//! `i32x4.dot_i16x8_s`, 16 dimensions per step; elsewhere a scalar loop the compiler vectorizes.

/// Σ a[i]·b[i] over i8 codes (|code| ≤ 127, so 512 dims can't overflow an i32).
#[inline]
pub fn dot_i8(a: &[i8], b: &[i8]) -> i32 {
    debug_assert_eq!(a.len(), b.len());
    #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
    {
        return unsafe { simd::dot_i8(a, b) };
    }
    #[allow(unreachable_code)]
    dot_i8_scalar(a, b)
}

#[inline]
pub fn dot_i8_scalar(a: &[i8], b: &[i8]) -> i32 {
    a.iter().zip(b).map(|(&x, &y)| x as i32 * y as i32).sum()
}

/// Σ q[i]·code[i] with an f32 query (exact cluster terms, writes).
#[inline]
pub fn dot_f32_i8(q: &[f32], code: &[i8]) -> f32 {
    let mut acc = [0f32; 8];
    let (cq, cc) = (q.chunks_exact(8), code.chunks_exact(8));
    let (rq, rc) = (cq.remainder(), cc.remainder());
    for (x, y) in cq.zip(cc) {
        for i in 0..8 {
            acc[i] += x[i] * y[i] as f32;
        }
    }
    acc.iter().sum::<f32>() + rq.iter().zip(rc).map(|(&x, &c)| x * c as f32).sum::<f32>()
}

/// f32 dot product with eight independent accumulators, so it vectorizes without fast-math.
#[inline]
pub fn dot_f32(a: &[f32], b: &[f32]) -> f32 {
    let mut acc = [0f32; 8];
    let (ca, cb) = (a.chunks_exact(8), b.chunks_exact(8));
    let (ra, rb) = (ca.remainder(), cb.remainder());
    for (x, y) in ca.zip(cb) {
        for i in 0..8 {
            acc[i] += x[i] * y[i];
        }
    }
    acc.iter().sum::<f32>() + ra.iter().zip(rb).map(|(x, y)| x * y).sum::<f32>()
}

/// Σ q[d]·n[d] over 4-bit codes packed in 32-dimension groups: byte j of group g holds
/// dimension 32g+j in its low nibble and 32g+16+j in its high nibble (dims % 32 == 0).
#[inline]
pub fn dot_i8_u4(q: &[i8], packed: &[u8]) -> i32 {
    debug_assert_eq!(q.len(), packed.len() * 2);
    #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
    {
        return unsafe { simd::dot_i8_u4(q, packed) };
    }
    #[allow(unreachable_code)]
    dot_i8_u4_scalar(q, packed)
}

pub fn dot_i8_u4_scalar(q: &[i8], packed: &[u8]) -> i32 {
    let mut s = 0i32;
    for (g, bytes) in packed.chunks_exact(16).enumerate() {
        let qg = &q[g * 32..g * 32 + 32];
        for (j, &b) in bytes.iter().enumerate() {
            s += qg[j] as i32 * (b & 0x0f) as i32 + qg[16 + j] as i32 * (b >> 4) as i32;
        }
    }
    s
}

/// Pack 4-bit values (0..=15) in the layout dot_i8_u4 reads.
pub fn pack_u4(n: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(n.len() / 2);
    for g in n.chunks_exact(32) {
        for j in 0..16 {
            out.push((g[j] & 0x0f) | (g[16 + j] << 4));
        }
    }
    out
}

#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
mod simd {
    use core::arch::wasm32::*;

    pub unsafe fn dot_i8(a: &[i8], b: &[i8]) -> i32 {
        let n = a.len() / 16 * 16;
        let mut acc = i32x4_splat(0);
        let mut i = 0;
        while i < n {
            // Unaligned loads (v128.load with align=1): codes sit at arbitrary cell offsets.
            let va = core::ptr::read_unaligned(a.as_ptr().add(i) as *const v128);
            let vb = core::ptr::read_unaligned(b.as_ptr().add(i) as *const v128);
            acc = i32x4_add(acc, i32x4_dot_i16x8(i16x8_extend_low_i8x16(va), i16x8_extend_low_i8x16(vb)));
            acc = i32x4_add(acc, i32x4_dot_i16x8(i16x8_extend_high_i8x16(va), i16x8_extend_high_i8x16(vb)));
            i += 16;
        }
        let mut s = i32x4_extract_lane::<0>(acc) + i32x4_extract_lane::<1>(acc) + i32x4_extract_lane::<2>(acc) + i32x4_extract_lane::<3>(acc);
        while i < a.len() {
            s += a[i] as i32 * b[i] as i32;
            i += 1;
        }
        s
    }

    pub unsafe fn dot_i8_u4(q: &[i8], packed: &[u8]) -> i32 {
        let mask = u8x16_splat(0x0f);
        let mut acc = i32x4_splat(0);
        for g in 0..packed.len() / 16 {
            let v = core::ptr::read_unaligned(packed.as_ptr().add(g * 16) as *const v128);
            let lo = v128_and(v, mask);
            let hi = u8x16_shr(v, 4);
            let qa = core::ptr::read_unaligned(q.as_ptr().add(g * 32) as *const v128);
            let qb = core::ptr::read_unaligned(q.as_ptr().add(g * 32 + 16) as *const v128);
            acc = i32x4_add(acc, i32x4_dot_i16x8(i16x8_extend_low_i8x16(qa), i16x8_extend_low_u8x16(lo)));
            acc = i32x4_add(acc, i32x4_dot_i16x8(i16x8_extend_high_i8x16(qa), i16x8_extend_high_u8x16(lo)));
            acc = i32x4_add(acc, i32x4_dot_i16x8(i16x8_extend_low_i8x16(qb), i16x8_extend_low_u8x16(hi)));
            acc = i32x4_add(acc, i32x4_dot_i16x8(i16x8_extend_high_i8x16(qb), i16x8_extend_high_u8x16(hi)));
        }
        i32x4_extract_lane::<0>(acc) + i32x4_extract_lane::<1>(acc) + i32x4_extract_lane::<2>(acc) + i32x4_extract_lane::<3>(acc)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dot_matches_scalar() {
        let mut x = 1u32;
        let mut rnd = || {
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            ((x % 255) as i32 - 127) as i8
        };
        for n in [0usize, 1, 15, 16, 17, 100, 512, 1024] {
            let a: Vec<i8> = (0..n).map(|_| rnd()).collect();
            let b: Vec<i8> = (0..n).map(|_| rnd()).collect();
            assert_eq!(dot_i8(&a, &b), dot_i8_scalar(&a, &b));
        }
        let a = vec![127i8; 1024];
        assert_eq!(dot_i8(&a, &a), 127 * 127 * 1024);
    }

    #[test]
    fn u4_dot_matches_unpacked() {
        let mut x = 7u32;
        let mut rnd = || {
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            x
        };
        for dims in [32usize, 256, 512] {
            let q: Vec<i8> = (0..dims).map(|_| ((rnd() % 255) as i32 - 127) as i8).collect();
            let n: Vec<u8> = (0..dims).map(|_| (rnd() % 16) as u8).collect();
            let want: i32 = q.iter().zip(&n).map(|(&a, &b)| a as i32 * b as i32).sum();
            assert_eq!(dot_i8_u4(&q, &pack_u4(&n)), want);
            assert_eq!(dot_i8_u4_scalar(&q, &pack_u4(&n)), want);
        }
    }
}
