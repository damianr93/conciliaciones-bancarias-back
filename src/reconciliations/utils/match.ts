import dayjs from 'dayjs';
import { toAmountKey, toAmountKeySafe } from './normalize.js';

export type ExtractLine = {
  id: string;
  date: Date | null;
  amountKey: bigint;
};

export type SystemLine = {
  id: string;
  issueDate: Date | null;
  dueDate: Date | null;
  amountKey: bigint;
};

export type SystemLineWithDescription = SystemLine & { amount: number; description: string | null };

function normComment(s: string | null | undefined): string {
  if (s == null) return '';
  return String(s).trim().toLowerCase();
}

export type MatchResult = {
  extractId: string;
  systemId: string;
  deltaDays: number;
};

function daysDiff(a: Date | null, b: Date | null) {
  if (!a || !b) return 999999;
  return Math.abs(dayjs(a).diff(dayjs(b), 'day'));
}

function daysDiffMin(ext: Date | null, issue: Date | null, due: Date | null) {
  return Math.min(daysDiff(ext, issue), daysDiff(ext, due));
}

export function matchOneToOne(
  systemLines: SystemLine[],
  extractLines: ExtractLine[],
  windowDays: number,
) {
  const extractByKey = new Map<bigint, ExtractLine[]>();
  for (const ext of extractLines) {
    const key = toAmountKeySafe(ext.amountKey as bigint | string);
    const list = extractByKey.get(key) || [];
    list.push(ext);
    extractByKey.set(key, list);
  }

  const usedExtract = new Set<string>();
  const usedSystem = new Set<string>();
  const matches: MatchResult[] = [];

  for (const sys of systemLines) {
    if (usedSystem.has(sys.id)) continue;
    const key = toAmountKeySafe(sys.amountKey as bigint | string);
    const pool = extractByKey.get(key) || [];
    let best: ExtractLine | null = null;
    let bestDelta = 0;
    for (const ext of pool) {
      if (usedExtract.has(ext.id)) continue;
      const delta = daysDiffMin(ext.date, sys.issueDate, sys.dueDate);
      if (windowDays > 0 && delta > windowDays) continue;
      if (!best || delta < bestDelta) {
        best = ext;
        bestDelta = delta;
      }
    }
    if (best) {
      matches.push({ extractId: best.id, systemId: sys.id, deltaDays: bestDelta });
      usedExtract.add(best.id);
      usedSystem.add(sys.id);
    }
  }

  return { matches, usedExtract, usedSystem };
}

export function matchManyToOneByComment(
  systemLines: SystemLineWithDescription[],
  extractLines: ExtractLine[],
  usedExtract: Set<string>,
  usedSystem: Set<string>,
): MatchResult[] {
  const extractByKey = new Map<bigint, ExtractLine[]>();
  for (const ext of extractLines) {
    if (usedExtract.has(ext.id)) continue;
    const list = extractByKey.get(ext.amountKey) || [];
    list.push(ext);
    extractByKey.set(ext.amountKey, list);
  }

  const byComment = new Map<string, SystemLineWithDescription[]>();
  for (const sys of systemLines) {
    if (usedSystem.has(sys.id)) continue;
    const key = normComment(sys.description);
    const list = byComment.get(key) || [];
    list.push(sys);
    byComment.set(key, list);
  }

  const extra: MatchResult[] = [];
  for (const [, group] of byComment) {
    if (group.length === 0) continue;
    const totalAmount = group.reduce((s, l) => s + l.amount, 0);
    const totalKey = toAmountKey(totalAmount);
    const pool = extractByKey.get(totalKey) || [];
    const ext = pool.find((e) => !usedExtract.has(e.id));
    if (!ext) continue;
    for (const sys of group) {
      extra.push({ extractId: ext.id, systemId: sys.id, deltaDays: 0 });
      usedSystem.add(sys.id);
    }
    usedExtract.add(ext.id);
  }
  return extra;
}
