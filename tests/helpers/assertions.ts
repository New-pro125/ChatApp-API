import type { Response } from 'supertest';
import { expect } from 'vitest';

export interface ExpectedError {
  code: string;
  message: string;
  details?: unknown;
}

export function expectSuccess<T = unknown>(response: Response, expectedStatus: number = 200): T {
  expect(response.status).toBe(expectedStatus);
  expect(response.body).toHaveProperty('success', true);
  expect(response.body).toHaveProperty('data');
  expect(response.body).toHaveProperty('meta');
  expect(typeof response.body.meta?.requestId).toBe('string');
  expect(response.body.meta.requestId.length).toBeGreaterThan(0);

  return response.body.data as T;
}

export function expectError(
  response: Response,
  expectedStatus: number,
  expectedCode?: string,
): ExpectedError {
  expect(response.status).toBe(expectedStatus);
  expect(response.body).toHaveProperty('success', false);
  expect(response.body).toHaveProperty('error');
  expect(response.body).toHaveProperty('meta');
  expect(typeof response.body.meta?.requestId).toBe('string');
  expect(response.body.meta.requestId.length).toBeGreaterThan(0);

  if (expectedCode) {
    expect(response.body.error.code).toBe(expectedCode);
  }

  return response.body.error as ExpectedError;
}

export function expectNoContent(response: Response): void {
  expect(response.status).toBe(204);
  expect(response.text).toBe('');
}
