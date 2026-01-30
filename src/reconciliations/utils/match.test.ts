import { describe, it, expect } from 'vitest';
import { matchOneToOne } from './match.js';

describe('matchOneToOne', () => {
  it('should match exact amounts with same date', () => {
    const systemLines = [
      { id: 's1', issueDate: new Date('2024-01-15'), dueDate: null, amountKey: 10000n },
    ];
    const extractLines = [
      { id: 'e1', date: new Date('2024-01-15'), amountKey: 10000n },
    ];

    const { matches, usedExtract, usedSystem } = matchOneToOne(systemLines, extractLines, 0);

    expect(matches).toHaveLength(1);
    expect(matches[0]).toEqual({
      extractId: 'e1',
      systemId: 's1',
      deltaDays: 0,
    });
    expect(usedExtract.has('e1')).toBe(true);
    expect(usedSystem.has('s1')).toBe(true);
  });

  it('should match within window days', () => {
    const systemLines = [
      { id: 's1', issueDate: new Date('2024-01-15'), dueDate: null, amountKey: 10000n },
    ];
    const extractLines = [
      { id: 'e1', date: new Date('2024-01-18'), amountKey: 10000n },
    ];

    const { matches } = matchOneToOne(systemLines, extractLines, 5);

    expect(matches).toHaveLength(1);
    expect(matches[0].deltaDays).toBe(3);
  });

  it('should not match outside window days', () => {
    const systemLines = [
      { id: 's1', issueDate: new Date('2024-01-15'), dueDate: null, amountKey: 10000n },
    ];
    const extractLines = [
      { id: 'e1', date: new Date('2024-01-25'), amountKey: 10000n },
    ];

    const { matches } = matchOneToOne(systemLines, extractLines, 5);

    expect(matches).toHaveLength(0);
  });

  it('should match using dueDate when closer than issueDate', () => {
    const systemLines = [
      { id: 's1', issueDate: new Date('2024-01-10'), dueDate: new Date('2024-01-20'), amountKey: 10000n },
    ];
    const extractLines = [
      { id: 'e1', date: new Date('2024-01-21'), amountKey: 10000n },
    ];

    const { matches } = matchOneToOne(systemLines, extractLines, 5);

    expect(matches).toHaveLength(1);
    expect(matches[0].deltaDays).toBe(1);
  });

  it('should not match different amounts', () => {
    const systemLines = [
      { id: 's1', issueDate: new Date('2024-01-15'), dueDate: null, amountKey: 10000n },
    ];
    const extractLines = [
      { id: 'e1', date: new Date('2024-01-15'), amountKey: 20000n },
    ];

    const { matches } = matchOneToOne(systemLines, extractLines, 0);

    expect(matches).toHaveLength(0);
  });

  it('should prefer closest date match', () => {
    const systemLines = [
      { id: 's1', issueDate: new Date('2024-01-15'), dueDate: null, amountKey: 10000n },
    ];
    const extractLines = [
      { id: 'e1', date: new Date('2024-01-17'), amountKey: 10000n },
      { id: 'e2', date: new Date('2024-01-20'), amountKey: 10000n },
    ];

    const { matches } = matchOneToOne(systemLines, extractLines, 10);

    expect(matches).toHaveLength(1);
    expect(matches[0].extractId).toBe('e1');
    expect(matches[0].deltaDays).toBe(2);
  });

  it('should handle one-to-one matching only', () => {
    const systemLines = [
      { id: 's1', issueDate: new Date('2024-01-15'), dueDate: null, amountKey: 10000n },
      { id: 's2', issueDate: new Date('2024-01-16'), dueDate: null, amountKey: 10000n },
    ];
    const extractLines = [
      { id: 'e1', date: new Date('2024-01-15'), amountKey: 10000n },
    ];

    const { matches } = matchOneToOne(systemLines, extractLines, 0);

    expect(matches).toHaveLength(1);
  });
});
