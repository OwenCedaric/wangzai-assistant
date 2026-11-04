import { describe, expect, it } from 'vitest';
import {
  annotateSeerfarKeywordRecoveryRecords,
  scoreSeerfarKeywordRelevance,
  seerfarKeywordRecordMatches,
} from './smartToolSeerfarKeywordRecovery.js';

describe('smartToolSeerfarKeywordRecovery', () => {
  it('scores exact, phrase and token matches without inventing provider metrics', () => {
    expect(scoreSeerfarKeywordRelevance({ query: 'платье' }, 'платье')).toBe(100);
    expect(scoreSeerfarKeywordRelevance({ query: 'платье женское летнее' }, 'платье')).toBe(88);
    expect(scoreSeerfarKeywordRelevance({ query: 'рубашка женская хлопок' }, 'рубашка женская')).toBe(88);
    expect(scoreSeerfarKeywordRelevance({ query: 'наушники' }, 'платье')).toBe(0);
  });

  it('keeps category synonyms but can strictly filter an unscoped market recovery', () => {
    const records = [
      { query: 'сарафан женский летний', searchVolume: 5000 },
      { query: 'платье вечернее', searchVolume: 4000 },
      { query: 'наушники', searchVolume: 9000 },
    ];
    expect(annotateSeerfarKeywordRecoveryRecords(records, 'платье')).toHaveLength(3);
    expect(annotateSeerfarKeywordRecoveryRecords(records, 'платье', { strictMatch: true }))
      .toEqual([expect.objectContaining({ query: 'платье вечернее', relevancy: 88 })]);
    expect(seerfarKeywordRecordMatches(records[1], ['платье'])).toBe(true);
  });
});
