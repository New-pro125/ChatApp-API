import { describe, expect, it } from 'vitest';
import type { AppConfig } from '@/core/config/app.config.js';
import {
  E2eeDeviceConflictException,
  E2eeDeviceNotFoundException,
  E2eeNotAllowedException,
  E2eePrekeyConflictException,
  E2eePrekeyExhaustedException,
  InvalidE2eeKeyException,
} from '@/core/errors/domain.error.js';
import { ErrorCode } from '@/core/errors/error-code.js';
import { ErrorMapper } from '@/core/errors/error-mapper.js';

const mapper = new ErrorMapper({ nodeEnv: 'test' } as AppConfig);

describe('E2EE error mapping', () => {
  it.each([
    [new E2eeDeviceConflictException(), 409, ErrorCode.E2EE_DEVICE_CONFLICT],
    [new E2eeDeviceNotFoundException(), 404, ErrorCode.E2EE_DEVICE_NOT_FOUND],
    [new E2eePrekeyConflictException(), 409, ErrorCode.CONFLICT],
    [new E2eePrekeyExhaustedException(), 409, ErrorCode.E2EE_PREKEY_EXHAUSTED],
    [new E2eeNotAllowedException(), 403, ErrorCode.E2EE_NOT_ALLOWED],
    [new InvalidE2eeKeyException(), 400, ErrorCode.VALIDATION_ERROR],
  ])('maps %s', (error, status, code) => {
    expect(mapper.map(error)).toMatchObject({ status, code });
  });
});
