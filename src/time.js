const UNIT = { m: 60, min: 60, h: 3600, d: 86400, w: 604800 };

/** "30m" | "2h" | "1d" | "1w" -> seconds */
export function parseEvery(s) {
  const m = /^(\d+)\s*(min|m|h|d|w)$/i.exec(String(s).trim());
  if (!m || Number(m[1]) === 0) throw new Error(`bad interval "${s}" (use e.g. 30m, 2h, 1d, 1w)`);
  return Number(m[1]) * UNIT[m[2].toLowerCase()];
}

function atTime(day, hhmm) {
  const [h, mi] = hhmm.split(':').map(Number);
  if (h > 23 || mi > 59) throw new Error(`bad time "${hhmm}"`);
  const d = new Date(day);
  d.setHours(h, mi, 0, 0);
  return d;
}

/**
 * Accepts: now | 30m | +2h | in 3d | 17:30 | today 17:30 | tomorrow [09:00]
 *          | 2026-12-01 | 2026-12-01 14:00 | any ISO timestamp.
 * Times without a zone are local. Returns an ISO UTC string.
 */
export function parseWhen(input, now = new Date()) {
  const s = String(input).trim().toLowerCase();
  let m;
  if (s === 'now') return now.toISOString();
  if ((m = /^(?:in\s+)?\+?(\d+)\s*(min|m|h|d|w)$/.exec(s))) {
    return new Date(now.getTime() + Number(m[1]) * UNIT[m[2]] * 1000).toISOString();
  }
  if ((m = /^(\d{1,2}:\d{2})$/.exec(s))) {
    const d = atTime(now, m[1]);
    if (d <= now) d.setDate(d.getDate() + 1);
    return d.toISOString();
  }
  if ((m = /^(today|tomorrow)(?:\s+(?:at\s+)?(\d{1,2}:\d{2}))?$/.exec(s))) {
    const d = atTime(now, m[2] || '09:00');
    if (m[1] === 'tomorrow') d.setDate(d.getDate() + 1);
    return d.toISOString();
  }
  if ((m = /^(\d{4}-\d{2}-\d{2})(?:[ t](\d{1,2}:\d{2}))?$/.exec(s))) {
    const [y, mo, da] = m[1].split('-').map(Number);
    const d = atTime(new Date(y, mo - 1, da), m[2] || '09:00');
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  const d = new Date(String(input).trim());
  if (Number.isNaN(d.getTime())) {
    throw new Error(`can't parse time "${input}" (try: 30m, 2h, tomorrow 9:00, 2026-12-01 14:00)`);
  }
  return d.toISOString();
}

const pad = (n) => String(n).padStart(2, '0');

export function fmtLocal(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtRelative(iso, now = new Date()) {
  const diff = Math.round((new Date(iso).getTime() - now.getTime()) / 1000);
  const abs = Math.abs(diff);
  const txt = abs < 60 ? 'now' : abs < 3600 ? `${Math.round(abs / 60)}m` : abs < 86400 ? `${Math.round(abs / 3600)}h` : `${Math.round(abs / 86400)}d`;
  if (txt === 'now') return 'now';
  return diff < 0 ? `overdue ${txt}` : `in ${txt}`;
}
