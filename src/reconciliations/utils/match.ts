import dayjs from 'dayjs';

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
    const list = extractByKey.get(ext.amountKey) || [];
    list.push(ext);
    extractByKey.set(ext.amountKey, list);
  }

  const usedExtract = new Set<string>();
  const usedSystem = new Set<string>();
  const matches: MatchResult[] = [];

  for (const sys of systemLines) {
    if (usedSystem.has(sys.id)) continue;
    const pool = extractByKey.get(sys.amountKey) || [];
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
