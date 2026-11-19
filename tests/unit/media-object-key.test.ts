import { describe, expect, it } from 'vitest';
import { InvalidMediaInputException } from '@/core/errors/domain.error.js';
import { MediaObjectKeyFactory } from '@/modules/media/logic/media-object-key.factory.js';

const factory = new MediaObjectKeyFactory();

describe('MediaObjectKeyFactory', () => {
  it('builds an owner-scoped key from the generated id and allowed type', () => {
    expect(
      factory.build(
        '01920000-0000-7000-8000-0000000000aa',
        '01920000-0000-7000-8000-0000000000bb',
        'image/png',
      ),
    ).toBe('media/01920000-0000-7000-8000-0000000000aa/01920000-0000-7000-8000-0000000000bb.png');
    expect(factory.build('owner', 'id', 'application/pdf')).toBe('media/owner/id.pdf');
    expect(factory.build('owner', 'id', 'application/octet-stream')).toBe('media/owner/id.bin');
  });

  it('never accepts a type outside the extension map', () => {
    expect(() => factory.build('owner', 'id', 'image/svg+xml')).toThrow(InvalidMediaInputException);
    expect(() => factory.build('owner', 'id', 'image/png; charset=utf-8')).toThrow(
      InvalidMediaInputException,
    );
  });
});
