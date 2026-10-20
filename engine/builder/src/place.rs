//! r/place 2022 → pagedb tables as JSON lines: every pixel placement, the canvas as tiles, and
//! timelapse snapshots.
//!
//!   pagedb-builder place-prep [--files 79] [--snap-mins 30] --placements A,B --snaps C --tiles D --meta E
//!
//! Reads Reddit's canvas history (gzipped CSV, not time-sorted), sorts every placement by time
//! (16 bytes each, in memory), and replays them onto a 2000×2000 canvas. Writes, in this order:
//! the placements (once per path in --placements: the builder reads them in several passes),
//! the snapshots (every --snap-mins, as 128×128 PNG tiles), the live canvas (tiles of one
//! character per pixel, taken just before the final whiteout) and one meta row.

use base64::Engine;
use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::time::Instant;

pub const SIZE: usize = 2000;
pub const TILE: usize = 128;
const TILES: usize = SIZE.div_ceil(TILE); // 16 per side
pub const PALETTE: [&str; 32] = [
    "#000000", "#00756F", "#009EAA", "#00A368", "#00CC78", "#00CCC0", "#2450A4", "#3690EA", "#493AC1", "#515252", "#51E9F4", "#6A5CFF", "#6D001A", "#6D482F", "#7EED56", "#811E9F",
    "#898D90", "#94B3FF", "#9C6926", "#B44AC0", "#BE0039", "#D4D7D9", "#DE107F", "#E4ABFF", "#FF3881", "#FF4500", "#FF99AA", "#FFA800", "#FFB470", "#FFD635", "#FFF8B8", "#FFFFFF",
];
const WHITE: u8 = 31;
/// Pixel colours as characters in tile rows: palette index → 'A'..'Z', 'a'..'f'.
pub fn color_char(c: u8) -> char {
    (if c < 26 { b'A' + c } else { b'a' + c - 26 }) as char
}
/// Times are stored relative to this (2022-04-01 00:00 UTC) inside the sort key.
const EPOCH0: u64 = 1_648_771_200_000;
const B64: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// "2022-04-04 00:53:51.577 UTC" → epoch ms.
fn parse_time(s: &str) -> Option<u64> {
    let b = s.as_bytes();
    let n = |a: usize, l: usize| s.get(a..a + l)?.parse::<i64>().ok();
    let days = days_from_civil(n(0, 4)?, n(5, 2)?, n(8, 2)?);
    let secs = days * 86400 + n(11, 2)? * 3600 + n(14, 2)? * 60 + n(17, 2)?;
    let mut ms = 0i64;
    if b.get(19) == Some(&b'.') {
        let frac: String = s[20..].chars().take_while(|c| c.is_ascii_digit()).collect();
        let f = format!("{frac:0<3}");
        ms = f[..3].parse().ok()?;
    }
    Some((secs * 1000 + ms) as u64)
}

fn user60(hash: &str) -> u64 {
    hash.bytes().take(10).fold(0u64, |acc, ch| (acc << 6) | B64.iter().position(|&x| x == ch).unwrap_or(0) as u64)
}

fn user_str(u: u64) -> String {
    (0..10).rev().map(|i| B64[((u >> (i * 6)) & 63) as usize] as char).collect()
}

fn b36(mut n: u64) -> String {
    let mut out = Vec::new();
    loop {
        out.push(b"0123456789abcdefghijklmnopqrstuvwxyz"[(n % 36) as usize]);
        n /= 36;
        if n == 0 {
            break;
        }
    }
    out.reverse();
    String::from_utf8(out).unwrap()
}

fn tile_png(canvas: &[u8], tx: usize, ty: usize) -> String {
    let mut buf = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut buf, TILE as u32, TILE as u32);
        enc.set_color(png::ColorType::Indexed);
        enc.set_depth(png::BitDepth::Eight);
        let pal: Vec<u8> = PALETTE.iter().flat_map(|h| (0..3).map(move |i| u8::from_str_radix(&h[1 + i * 2..3 + i * 2], 16).unwrap())).collect();
        enc.set_palette(pal);
        enc.set_compression(png::Compression::Best);
        let mut w = enc.write_header().unwrap();
        let mut data = vec![WHITE; TILE * TILE];
        for y in 0..TILE {
            let cy = ty * TILE + y;
            if cy >= SIZE {
                continue;
            }
            for x in 0..TILE {
                let cx = tx * TILE + x;
                if cx < SIZE {
                    data[y * TILE + x] = canvas[cy * SIZE + cx];
                }
            }
        }
        w.write_image_data(&data).unwrap();
    }
    base64::engine::general_purpose::STANDARD.encode(buf)
}

fn open_out(path: &str) -> BufWriter<std::fs::File> {
    BufWriter::with_capacity(1 << 20, OpenOptions::new().write(true).create(true).truncate(true).open(path).unwrap_or_else(|e| panic!("{path}: {e}")))
}

pub fn run(args: &[String]) {
    let arg = |name: &str| args.iter().position(|a| a == name).map(|i| args[i + 1].clone());
    let files: usize = arg("--files").map(|v| v.parse().unwrap()).unwrap_or(79);
    let snap_ms: u64 = arg("--snap-mins").map(|v| v.parse::<u64>().unwrap()).unwrap_or(30) * 60_000;
    let placements: Vec<String> = arg("--placements").expect("--placements A[,B]").split(',').map(str::to_string).collect();
    let t0 = Instant::now();

    // 1. Read every placement: (time << 27 | pos << 5 | colour, user), and moderation rectangles.
    let mut ev: Vec<(u64, u64)> = Vec::with_capacity(if files >= 79 { 175_000_000 } else { files * 2_100_000 });
    let mut rects: Vec<(u64, u16, u16, u16, u16, u8)> = Vec::new();
    let agent = ureq::AgentBuilder::new().timeout_read(std::time::Duration::from_secs(120)).build();
    for i in 0..files {
        let url = format!("https://placedata.reddit.com/data/canvas-history/2022_place_canvas_history-{i:012}.csv.gzip");
        let resp = agent.get(&url).call().unwrap_or_else(|e| panic!("{url}: {e}"));
        let r = BufReader::with_capacity(1 << 20, flate2::read::MultiGzDecoder::new(resp.into_reader()));
        let mut bad = 0u64;
        for line in r.lines() {
            let line = line.expect("read csv");
            let mut f = line.splitn(4, ',');
            let (Some(ts), Some(user), Some(color), Some(coord)) = (f.next(), f.next(), f.next(), f.next()) else { continue };
            if ts == "timestamp" {
                continue;
            }
            let (Some(t), Some(c)) = (parse_time(ts), PALETTE.iter().position(|p| p.eq_ignore_ascii_case(color))) else {
                bad += 1;
                continue;
            };
            let nums: Vec<u16> = coord.trim_matches('"').split(',').filter_map(|v| v.trim().parse().ok()).collect();
            let t = t - EPOCH0;
            match nums.as_slice() {
                [x, y] if (*x as usize) < SIZE && (*y as usize) < SIZE => {
                    let pos = *y as u64 * SIZE as u64 + *x as u64;
                    ev.push(((t << 27) | (pos << 5) | c as u64, user60(user)));
                }
                [x1, y1, x2, y2] => rects.push((t, *x1, *y1, *x2, *y2, c as u8)),
                _ => bad += 1,
            }
        }
        eprintln!("file {i}: {} placements so far, {} rectangles ({bad} skipped) {:.0}s", ev.len(), rects.len(), t0.elapsed().as_secs_f64());
    }
    ev.sort_unstable();
    rects.sort_unstable();
    eprintln!("sorted {} placements in {:.0}s", ev.len(), t0.elapsed().as_secs_f64());
    let time_of = |e: &(u64, u64)| e.0 >> 27;
    let (start, end) = (ev.first().map(time_of).unwrap_or(0), ev.last().map(time_of).unwrap_or(0));

    // 2. The whiteout: from the first minute after which every minute is ≥ 90% white.
    let minutes = ((end - start) / 60_000 + 1) as usize;
    let mut per_min = vec![(0u32, 0u32); minutes];
    for e in &ev {
        let m = ((time_of(e) - start) / 60_000) as usize;
        per_min[m].1 += 1;
        if (e.0 & 31) as u8 == WHITE {
            per_min[m].0 += 1;
        }
    }
    let mut cut_min = minutes;
    while cut_min > 0 && per_min[cut_min - 1].1 > 0 && per_min[cut_min - 1].0 as f64 >= 0.9 * per_min[cut_min - 1].1 as f64 {
        cut_min -= 1;
    }
    let cut = start + cut_min as u64 * 60_000;
    eprintln!("whiteout from {} (minute {cut_min} of {minutes})", EPOCH0 + cut);

    // 3. Placements, once per pass (the builder sorts each pass for its own indexes).
    for path in &placements {
        let mut w = open_out(path);
        for (i, e) in ev.iter().enumerate() {
            let pos = (e.0 >> 5) & ((1 << 22) - 1);
            writeln!(w, r#"{{"id":"{}","pos":{},"c":{},"u":"{}","t":{}}}"#, b36(i as u64), pos, e.0 & 31, user_str(e.1), EPOCH0 + time_of(e)).unwrap();
        }
        w.flush().unwrap();
        drop(w);
        eprintln!("placements written to {path} {:.0}s", t0.elapsed().as_secs_f64());
    }

    // 4. Replay: snapshots every snap_ms (PNG tiles), and the canvas at the whiteout.
    let mut canvas = vec![WHITE; SIZE * SIZE];
    let mut live: Option<Vec<u8>> = None;
    let mut snaps = open_out(&arg("--snaps").expect("--snaps PATH"));
    let mut k = 0u64;
    let mut next_snap = start + snap_ms;
    let mut ri = 0;
    let snap = |canvas: &[u8], k: u64, at: u64, w: &mut BufWriter<std::fs::File>| {
        for ty in 0..TILES {
            for tx in 0..TILES {
                writeln!(w, r#"{{"id":"{k}:{tx}:{ty}","k":{k},"tx":{tx},"ty":{ty},"t":{},"png":"{}"}}"#, EPOCH0 + at, tile_png(canvas, tx, ty)).unwrap();
            }
        }
    };
    for e in ev.iter().map(Some).chain(std::iter::once(None)) {
        let t = e.map(time_of).unwrap_or(u64::MAX);
        while next_snap <= t && next_snap <= end + snap_ms {
            snap(&canvas, k, next_snap, &mut snaps);
            k += 1;
            next_snap += snap_ms;
        }
        while ri < rects.len() && rects[ri].0 <= t {
            let (_, x1, y1, x2, y2, c) = rects[ri];
            for y in y1.min(y2)..=y1.max(y2).min(SIZE as u16 - 1) {
                for x in x1.min(x2)..=x1.max(x2).min(SIZE as u16 - 1) {
                    canvas[y as usize * SIZE + x as usize] = c;
                }
            }
            ri += 1;
        }
        if live.is_none() && t >= cut {
            live = Some(canvas.clone());
        }
        let Some(e) = e else { break };
        let pos = ((e.0 >> 5) & ((1 << 22) - 1)) as usize;
        canvas[pos] = (e.0 & 31) as u8;
    }
    snaps.flush().unwrap();
    drop(snaps);
    eprintln!("{k} snapshots {:.0}s", t0.elapsed().as_secs_f64());

    // 5. The live canvas, as tiles of one character per pixel (a paint splices one character).
    let live = live.unwrap_or(canvas);
    let mut tiles = open_out(&arg("--tiles").expect("--tiles PATH"));
    for ty in 0..TILES {
        for tx in 0..TILES {
            let mut px = String::with_capacity(TILE * TILE);
            for y in 0..TILE {
                for x in 0..TILE {
                    let (cx, cy) = (tx * TILE + x, ty * TILE + y);
                    px.push(color_char(if cx < SIZE && cy < SIZE { live[cy * SIZE + cx] } else { WHITE }));
                }
            }
            writeln!(tiles, r#"{{"id":"{tx}:{ty}","tx":{tx},"ty":{ty},"px":"{px}","t":{}}}"#, EPOCH0 + cut).unwrap();
        }
    }
    tiles.flush().unwrap();
    drop(tiles);
    let mut meta = open_out(&arg("--meta").expect("--meta PATH"));
    let pal: Vec<String> = PALETTE.iter().map(|p| format!("\"{p}\"")).collect();
    writeln!(
        meta,
        r#"{{"id":"canvas","info":"{{\"size\":{SIZE},\"tile\":{TILE},\"palette\":[{}],\"start\":{},\"end\":{},\"cut\":{},\"snapEvery\":{snap_ms},\"snaps\":{k},\"placements\":{}}}"}}"#,
        pal.join(",").replace('"', "\\\""),
        EPOCH0 + start,
        EPOCH0 + end,
        EPOCH0 + cut,
        ev.len()
    )
    .unwrap();
    meta.flush().unwrap();
    eprintln!("done in {:.0}s", t0.elapsed().as_secs_f64());
}
