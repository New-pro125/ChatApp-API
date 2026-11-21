import { describe, expect, it } from 'vitest';
import { searchMessagesQuerySchema } from '@/modules/messages/web/dto/message.schemas.js';

describe('searchMessagesQuerySchema', () => {
  it('trims q and applies the default limit', () => {
    expect(searchMessagesQuerySchema.parse({ q: '  running  ' })).toEqual({
      q: 'running',
      limit: 30,
    });
  });

  it('accepts a cursor and a valid limit', () => {
    expect(
      searchMessagesQuerySchema.parse({
        q: 'running',
        limit: 100,
        cursor: '018f7c3e-4f1a-7c30-8000-000000000000',
      }),
    ).toEqual({
      q: 'running',
      limit: 100,
      cursor: '018f7c3e-4f1a-7c30-8000-000000000000',
    });
  });

  it('rejects a missing or blank q', () => {
    expect(() => searchMessagesQuerySchema.parse({})).toThrow();
    expect(() => searchMessagesQuerySchema.parse({ q: '   ' })).toThrow();
  });

  it('rejects an overlong q', () => {
    expect(() => searchMessagesQuerySchema.parse({ q: 'a'.repeat(201) })).toThrow();
  });

  it('rejects a bad cursor or out-of-range limit', () => {
    expect(() => searchMessagesQuerySchema.parse({ q: 'x', cursor: 'not-a-uuid' })).toThrow();
    expect(() => searchMessagesQuerySchema.parse({ q: 'x', limit: 0 })).toThrow();
    expect(() => searchMessagesQuerySchema.parse({ q: 'x', limit: 101 })).toThrow();
  });
});
