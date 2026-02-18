import dayjs from 'dayjs';

const EXCEL_EPOCH = new Date(Date.UTC(1899, 11, 30));

export type AmountMode = 'single' | 'debe-haber';

export function parseAmount(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== 'string') {
    return null;
  }
  let text = value.trim();
  if (!text) return null;
  let negative = false;
  if (text.startsWith('(') && text.endsWith(')')) {
    negative = true;
    text = text.slice(1, -1);
  }
  if (text.includes('-')) {
    const minusCount = (text.match(/-/g) || []).length;
    if (minusCount % 2 === 1) negative = true;
    text = text.replace(/-/g, '');
  }
  text = text.replace(/[^0-9,\.]/g, '');
  if (!text) return null;

  const lastComma = text.lastIndexOf(',');
  const lastDot = text.lastIndexOf('.');
  if (lastComma > -1 && lastDot > -1) {
    if (lastComma > lastDot) {
      text = text.replace(/\./g, '').replace(',', '.');
    } else {
      text = text.replace(/,/g, '');
    }
  } else if (lastComma > -1) {
    text = text.replace(',', '.');
  }

  const parsed = Number(text);
  if (!Number.isFinite(parsed)) return null;
  return negative ? -parsed : parsed;
}

export function parseDate(value: unknown): Date | null {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(EXCEL_EPOCH.getTime() + value * 86400000);
    if (!Number.isNaN(date.getTime())) {
      return date;
    }
  }
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return null;
    const ddmmyyyy = /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/;
    const match = text.match(ddmmyyyy);
    if (match) {
      const day = Number(match[1]);
      const month = Number(match[2]);
      let year = Number(match[3]);
      if (year < 100) year += 2000;
      const date = new Date(year, month - 1, day);
      if (!Number.isNaN(date.getTime())) return date;
    }
    const parsed = dayjs(text);
    if (parsed.isValid()) return parsed.toDate();
  }
  return null;
}

export function toAmountKey(amount: number, decimals = 2): bigint {
  const factor = Math.pow(10, decimals);
  return BigInt(Math.round(amount * factor));
}

export function toAmountKeySafe(value: bigint | string | number): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string') return BigInt(value);
  return BigInt(Math.round(Number(value)));
}

export function extractAmount(
  row: Record<string, unknown>,
  mode: AmountMode,
  amountCol?: string,
  debeCol?: string,
  haberCol?: string,
): number | null {
  if (mode === 'single') {
    if (!amountCol) return null;
    return parseAmount(row[amountCol]);
  }
  const debe = debeCol ? parseAmount(row[debeCol]) : null;
  const haber = haberCol ? parseAmount(row[haberCol]) : null;
  if (debe && debe !== 0) return Math.abs(debe);
  if (haber && haber !== 0) return -Math.abs(haber);
  if (debe === 0 && haber === 0) return 0;
  return null;
}

export function normalizeText(text?: string | null) {
  return text?.toString().trim() || null;
}
