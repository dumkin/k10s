/** kubectl's `duration.HumanDuration`: 45s, 5m30s, 3h12m, 6d4h, 2y31d… */
export function humanDuration(totalSeconds: number): string {
  const s = Math.floor(totalSeconds);
  if (s < -1) return "<invalid>";
  if (s < 0) return "0s";
  if (s < 120) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 10) return s % 60 === 0 ? `${m}m` : `${m}m${s % 60}s`;
  if (m < 180) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 8) return m % 60 === 0 ? `${h}h` : `${h}h${m % 60}m`;
  if (h < 48) return `${h}h`;
  if (h < 24 * 8) return h % 24 === 0 ? `${Math.floor(h / 24)}d` : `${Math.floor(h / 24)}d${h % 24}h`;
  if (h < 24 * 365 * 2) return `${Math.floor(h / 24)}d`;
  const y = Math.floor(h / 24 / 365);
  const dy = Math.floor(h / 24) % 365;
  if (h < 24 * 365 * 8) return dy === 0 ? `${y}y` : `${y}y${dy}d`;
  return `${y}y`;
}

export function age(unixSeconds: number | null | undefined, now: number): string {
  if (!unixSeconds) return "";
  return humanDuration(now - unixSeconds);
}

const BINARY = ["", "Ki", "Mi", "Gi", "Ti", "Pi", "Ei"];

/** 536870912 → "512Mi", 1610612736 → "1.5Gi" */
export function bytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "";
  let v = n;
  let i = 0;
  while (Math.abs(v) >= 1024 && i < BINARY.length - 1) {
    v /= 1024;
    i++;
  }
  const s = v >= 100 || Number.isInteger(v) ? Math.round(v).toString() : v.toFixed(1).replace(/\.0$/, "");
  return `${s}${BINARY[i]}`;
}

/** millicores → "250m", "4", "1.5" */
export function cpu(milli: number | null | undefined): string {
  if (milli == null || !Number.isFinite(milli)) return "";
  if (milli < 1000) return `${Math.round(milli)}m`;
  const cores = milli / 1000;
  return Number.isInteger(cores) ? String(cores) : cores.toFixed(1).replace(/\.0$/, "");
}

export function count(n: number): string {
  return n.toLocaleString("en-US");
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${count(n)} ${n === 1 ? one : many}`;
}

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const dateTimeFmt = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

export function clock(ms: number): string {
  const d = new Date(ms);
  return `${timeFmt.format(d)}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

export function dateTime(unixSeconds: number): string {
  return dateTimeFmt.format(new Date(unixSeconds * 1000));
}

/** "2024-01-01T00:00:00Z" → unix seconds */
export function parseTime(s: string | null | undefined): number | null {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : Math.floor(t / 1000);
}
