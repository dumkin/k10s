//! Allocation-free RFC 3339 parsing. Kubernetes timestamps are parsed on every watch event,
//! so this stays deliberately tiny and branch-light instead of going through a datetime crate.

use std::time::{SystemTime, UNIX_EPOCH};

/// Parses `YYYY-MM-DDTHH:MM:SS[.fraction](Z|±HH:MM)` into (unix seconds, nanoseconds).
pub fn parse_rfc3339(s: &str) -> Option<(i64, u32)> {
    let b = s.as_bytes();
    if b.len() < 20 || b[4] != b'-' || b[7] != b'-' || !matches!(b[10], b'T' | b't' | b' ') || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let year = digits(&b[0..4])? as i64;
    let month = digits(&b[5..7])?;
    let day = digits(&b[8..10])?;
    let hour = digits(&b[11..13])? as i64;
    let min = digits(&b[14..16])? as i64;
    let sec = digits(&b[17..19])? as i64;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 23 || min > 59 || sec > 60 {
        return None;
    }

    let mut i = 19;
    let mut nanos: u32 = 0;
    if b.get(i) == Some(&b'.') {
        i += 1;
        let start = i;
        while i < b.len() && b[i].is_ascii_digit() {
            if i - start < 9 {
                nanos = nanos * 10 + (b[i] - b'0') as u32;
            }
            i += 1;
        }
        let n = i - start;
        if n == 0 {
            return None;
        }
        if n < 9 {
            nanos *= 10u32.pow((9 - n) as u32);
        }
    }

    let offset = match b.get(i)? {
        b'Z' | b'z' => 0,
        sign @ (b'+' | b'-') => {
            let rest = b.get(i + 1..i + 6)?;
            if rest[2] != b':' {
                return None;
            }
            let off = digits(&rest[0..2])? as i64 * 3600 + digits(&rest[3..5])? as i64 * 60;
            if *sign == b'+' { off } else { -off }
        }
        _ => return None,
    };

    let days = days_from_civil(year, month, day);
    Some((days * 86_400 + hour * 3600 + min * 60 + sec - offset, nanos))
}

/// Unix seconds of an RFC 3339 timestamp.
#[inline]
pub fn unix_seconds(s: &str) -> Option<i64> {
    parse_rfc3339(s).map(|(s, _)| s)
}

/// Unix milliseconds of an RFC 3339 timestamp.
#[inline]
pub fn unix_millis(s: &str) -> Option<i64> {
    parse_rfc3339(s).map(|(s, n)| s * 1000 + (n / 1_000_000) as i64)
}

pub fn now_unix() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// Current time as RFC 3339 with second precision (what kubectl writes in `restartedAt`).
pub fn now_rfc3339() -> String {
    format_rfc3339(now_unix())
}

pub fn format_rfc3339(unix: i64) -> String {
    let days = unix.div_euclid(86_400);
    let secs = unix.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", secs / 3600, (secs % 3600) / 60, secs % 60)
}

#[inline]
fn digits(b: &[u8]) -> Option<u32> {
    let mut v = 0u32;
    for &c in b {
        if !c.is_ascii_digit() {
            return None;
        }
        v = v * 10 + (c - b'0') as u32;
    }
    Some(v)
}

/// Days since 1970-01-01 (Howard Hinnant's algorithm).
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u64;
    let mp = ((m + 9) % 12) as u64;
    let doy = (153 * mp + 2) / 5 + d as u64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe as i64 - 719_468
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_kubernetes_timestamps() {
        assert_eq!(unix_seconds("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(unix_seconds("2024-02-29T12:34:56Z"), Some(1_709_210_096));
        assert_eq!(unix_seconds("2024-02-29T14:34:56+02:00"), Some(1_709_210_096));
        assert_eq!(parse_rfc3339("2024-02-29T12:34:56.123456789Z"), Some((1_709_210_096, 123_456_789)));
        assert_eq!(unix_millis("2024-02-29T12:34:56.5Z"), Some(1_709_210_096_500));
        assert_eq!(unix_seconds("garbage"), None);
        assert_eq!(unix_seconds("2024-13-01T00:00:00Z"), None);
    }

    #[test]
    fn formats_round_trip() {
        for t in [0, 1_709_210_096, 951_782_400, 4_102_444_800] {
            assert_eq!(unix_seconds(&format_rfc3339(t)), Some(t));
        }
        assert_eq!(format_rfc3339(1_709_210_096), "2024-02-29T12:34:56Z");
    }
}
