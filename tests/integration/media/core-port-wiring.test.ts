import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CORE_TYPES } from '@/core/container/core.types.js';
import type { MediaAccess } from '@/core/media/media-access.port.js';
import type { MediaReferenceReader } from '@/core/media/media-reference.port.js';
import { MediaAccessService } from '@/modules/media/logic/media-access.service.js';
import { MediaReferenceReaderService } from '@/modules/messages/logic/media-reference-reader.service.js';
import { TestApp } from '../../helpers/test-app.js';

describe('core media port wiring', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await TestApp.create();
  });

  afterAll(async () => {
    await app.close();
  });

  it('resolves both ports from the root container', () => {
    expect(app.container.get<MediaReferenceReader>(CORE_TYPES.MediaReferenceReader)).toBeInstanceOf(
      MediaReferenceReaderService,
    );
    expect(app.container.get<MediaAccess>(CORE_TYPES.MediaAccess)).toBeInstanceOf(
      MediaAccessService,
    );
  });
});
