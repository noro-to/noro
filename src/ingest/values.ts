// Cell-level parsing shared by ingest and the mapping guesser: numbers as
// ad platforms format them, and the date formats they use.

export interface NumberFormat {
  /** Thousands separator, "," by default. "" means none. */
  thousands: string;
  /** Decimal separator, "." by default. */
  decimal: string;
  /** Cell values that mean zero, e.g. "--" or blank. Compared after trimming. */
  zero: string[];
}

export const DEFAULT_NUMBER_FORMAT: NumberFormat = { thousands: ',', decimal: '.', zero: ['', '--', '-', 'N/A'] };

/** Result of parsing one cell as a number. `kind` says how it was read. */
export type ParsedNumber = { kind: 'number'; value: number } | { kind: 'zero'; value: 0 } | { kind: 'invalid'; value: null };

/**
 * Parse a number as exported by an ad platform: "$1,234.56", "1,234",
 * "12.5%", "(45.00)" (negative), "US$ 3.20", "€1.234,56" with a "," decimal
 * format. Blank and placeholder values ("--") count as zero.
 */
export function parseNumber(raw: string | number | null | undefined, fmt: NumberFormat = DEFAULT_NUMBER_FORMAT): ParsedNumber {
  if (typeof raw === 'number') return Number.isFinite(raw) ? { kind: 'number', value: raw } : { kind: 'invalid', value: null };
  const s0 = String(raw ?? '')
    .replace(/[  ]/g, ' ')
    .trim();
  if (fmt.zero.includes(s0) || s0 === '') return { kind: 'zero', value: 0 };

  let s = s0;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  // Currency symbols and codes, percent signs, spaces.
  s = s.replace(/[$€£¥₹]|\b[A-Z]{3}\b|US\$|%/g, '').replace(/\s+/g, '');
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.startsWith('+')) s = s.slice(1);
  if (fmt.thousands) s = s.split(fmt.thousands).join('');
  if (fmt.decimal !== '.') s = s.replace(fmt.decimal, '.');
  if (!/^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) return { kind: 'invalid', value: null };
  const value = Number(s) * (negative ? -1 : 1);
  return Number.isFinite(value) ? { kind: 'number', value } : { kind: 'invalid', value: null };
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * Parse a date cell to ISO YYYY-MM-DD, or null if it isn't a single date.
 * Accepts 2026-09-29, 2026/09/29, 9/29/2026 (or 29/9/2026 with order "dmy",
 * and automatically when the first part is over 12), Sep 29, 2026,
 * Tuesday, September 29, 2026, 29 Sep 2026, and Date objects.
 */
export function parseDate(raw: string | Date | number | null | undefined, order: 'mdy' | 'dmy' = 'mdy'): string | null {
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw.toISOString().slice(0, 10);
  const s = String(raw ?? '').trim();
  if (!s) return null;

  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ].*)?$/.exec(s);
  if (m) return iso(+m[1], +m[2], +m[3]);

  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(s);
  if (m) {
    let a = +m[1];
    let b = +m[2];
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    if (order === 'dmy' || a > 12) [a, b] = [b, a];
    return iso(y, a, b);
  }

  // Month names: "Sep 29, 2026", "Tuesday, September 29, 2026", "29 Sep 2026".
  const t = s.replace(/^[A-Za-z]+day,?\s+/i, '').replace(/,/g, ' ').replace(/\s+/g, ' ');
  m = /^([A-Za-z]{3,9})\.? (\d{1,2}) (\d{4})$/.exec(t);
  if (m && MONTHS[m[1].slice(0, 3).toLowerCase()]) return iso(+m[3], MONTHS[m[1].slice(0, 3).toLowerCase()], +m[2]);
  m = /^(\d{1,2}) ([A-Za-z]{3,9})\.? (\d{4})$/.exec(t);
  if (m && MONTHS[m[2].slice(0, 3).toLowerCase()]) return iso(+m[3], MONTHS[m[2].slice(0, 3).toLowerCase()], +m[1]);

  return null;
}

/** Excel serial day number (1900 date system) → ISO date. */
export function excelSerialToIso(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < 1 || serial > 2_958_465) return null;
  const ms = Math.round((serial - 25569) * 86_400_000);
  return new Date(ms).toISOString().slice(0, 10);
}

function iso(y: number, mo: number, d: number): string | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCMonth() !== mo - 1) return null; // e.g. Feb 30
  return `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
