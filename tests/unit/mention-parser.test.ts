import { describe, expect, it } from 'vitest';
import { MentionParser } from '@/modules/messages/logic/mention-parser.js';

describe('MentionParser', () => {
  const parser = new MentionParser();

  it('deduplicates case-insensitively and keeps only valid names', () => {
    expect(parser.parse('hi @alice_01 and @ALICE_01 and @bob_02')).toEqual(['alice_01', 'bob_02']);
    expect(parser.parse('')).toEqual([]);
    expect(parser.parse('@abc @abcdefghijklmnopqrstuvwxyz1234567')).toEqual([]);
  });

  it('ignores email-like and URL-like tokens', () => {
    expect(parser.parse('mail alice@example.com and https://x/@alice_01')).toEqual([]);
    expect(parser.parse('hello,@alice_01! (@bob_02)')).toEqual(['alice_01', 'bob_02']);
  });
});
