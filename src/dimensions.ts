import type { WmtsDimension } from './wmts';

export interface DimensionDomain {
  /** Discrete values, sorted chronologically for temporal dimensions. */
  values: string[];
  temporal: boolean;
  /** True when only the most recent values are kept because the domain is very large. */
  truncated: boolean;
}

interface Duration {
  months: number;
  ms: number;
}

const MAX_VALUES = 50000;
const MAX_GENERATED = 500000;
const DURATION_RE =
  /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i;

function parseDuration(s: string): Duration | null {
  const m = DURATION_RE.exec(s.trim());
  if (!m) return null;
  const [y, mo, w, d, h, mi, sec] = m.slice(1).map((v) => (v ? Number(v) : 0));
  const dur = { months: y * 12 + mo, ms: (((w * 7 + d) * 24 + h) * 60 + mi) * 60000 + sec * 1000 };
  return dur.months || dur.ms ? dur : null;
}

function parseDate(s: string): Date | null {
  if (!/^\d{4}(-\d{2}){0,2}(T|$)/.test(s)) return null;
  // Date-times without an offset would otherwise be parsed in local time.
  const normalized = s.includes('T') && !/(Z|[+-]\d{2}:?\d{2})$/i.test(s) ? `${s}Z` : s;
  const t = Date.parse(normalized);
  return Number.isNaN(t) ? null : new Date(t);
}

function addDuration(start: Date, dur: Duration, n: number): Date {
  const d = new Date(start.getTime());
  if (dur.months) d.setUTCMonth(d.getUTCMonth() + dur.months * n);
  return new Date(d.getTime() + dur.ms * n);
}

/** Formats a date with the same precision as the sample value from the capabilities. */
function formatLike(sample: string, d: Date): string {
  const iso = d.toISOString();
  if (/^\d{4}$/.test(sample)) return iso.slice(0, 4);
  if (/^\d{4}-\d{2}$/.test(sample)) return iso.slice(0, 7);
  if (/^\d{4}-\d{2}-\d{2}$/.test(sample)) return iso.slice(0, 10);
  return /\.\d+/.test(sample) ? iso : iso.replace(/\.\d{3}Z$/, 'Z');
}

export function isTemporal(dim: WmtsDimension): boolean {
  return (
    /time|date/i.test(dim.identifier) ||
    /iso.?8601/i.test(dim.uom ?? '') ||
    dim.values.some((v) => /^\d{4}-\d{2}/.test(v))
  );
}

/** Expands ISO 8601 intervals (start/end/period) and comma separated lists into discrete values. */
export function expandDimension(dim: WmtsDimension): DimensionDomain {
  const temporal = isTemporal(dim);
  const out: string[] = [];
  const items = dim.values.flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean);

  for (const item of items) {
    const parts = item.split('/');
    const start = parts.length >= 2 ? parseDate(parts[0]) : null;
    const end = start ? parseDate(parts[1]) : null;
    if (!start || !end) {
      out.push(item);
      continue;
    }
    const dur = parts[2] ? parseDuration(parts[2]) : null;
    if (!dur) {
      out.push(parts[0], parts[1]);
      continue;
    }
    for (let i = 0; out.length < MAX_GENERATED; i++) {
      const d = addDuration(start, dur, i);
      if (d > end) break;
      out.push(formatLike(parts[0], d));
    }
  }

  let values = [...new Set(out)];
  if (temporal) values.sort();
  const truncated = values.length > MAX_VALUES;
  if (truncated) values = values.slice(-MAX_VALUES);
  return { values, temporal, truncated };
}
