import { describe, expect, it } from 'vitest';
import type { AppConfig } from '@/core/config/app.config.js';
import {
  InvalidMediaInputException,
  MediaInfectedException,
  MediaNotFoundException,
  MediaNotReadyException,
  MediaScanUnavailableException,
} from '@/core/errors/domain.error.js';
import { ErrorCode } from '@/core/errors/error-code.js';
import { ErrorMapper } from '@/core/errors/error-mapper.js';
import { ObjectStoreException, VirusScannerException } from '@/core/errors/repository.error.js';

const mapper = new ErrorMapper({ nodeEnv: 'test' } as AppConfig);

describe('Media error mapping', () => {
  it.each([
    [new InvalidMediaInputException(), 400, ErrorCode.VALIDATION_ERROR],
    [new MediaNotFoundException(), 404, ErrorCode.NOT_FOUND],
    [new MediaNotReadyException(), 409, ErrorCode.MEDIA_NOT_READY],
    [new MediaInfectedException(), 422, ErrorCode.MEDIA_INFECTED],
    [new MediaScanUnavailableException(), 503, ErrorCode.MEDIA_SCAN_UNAVAILABLE],
  ])('maps %s', (error, status, code) => {
    expect(mapper.map(error)).toMatchObject({ status, code });
  });

  it('sanitizes adapter failures as internal errors', () => {
    expect(mapper.map(new ObjectStoreException('secret bucket detail'))).toMatchObject({
      status: 500,
      code: ErrorCode.INTERNAL_ERROR,
    });
    expect(mapper.map(new VirusScannerException('socket detail'))).toMatchObject({
      status: 500,
      code: ErrorCode.INTERNAL_ERROR,
    });
  });

  it('never exposes cause details in the public message', () => {
    const mapped = mapper.map(new MediaScanUnavailableException(undefined, { cause: 'secret' }));
    expect(mapped.message).not.toContain('secret');
    expect(mapped.details).toBeUndefined();
  });
});
