export function fmtTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec % 60);
  const m = Math.floor(sec / 60) % 60;
  const h = Math.floor(sec / 3600);
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

export const fmtMs = (ms?: number | null) => (ms ? fmtTime(ms / 1000) : "");

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let i = -1;
  do {
    n /= 1024;
    i++;
  } while (n >= 1024 && i < u.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${u[i]}`;
}

export function totalDuration(tracks: { durationMs?: number | null }[]): number {
  return tracks.reduce((a, t) => a + (t.durationMs ?? 0), 0) / 1000;
}

export function cls(...xs: (string | false | null | undefined)[]): string {
  return xs.filter(Boolean).join(" ");
}
