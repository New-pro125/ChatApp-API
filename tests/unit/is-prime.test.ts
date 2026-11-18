import { isPrime } from "@/core/math/is-prime.js";
import { describe, expect, it } from "vitest";

describe("isPrime", () => {
  it.each([
    { value: 2, expected: true },
    { value: 3, expected: true },
    { value: 4, expected: false },
    { value: 561, expected: false },
    { value: 104729, expected: true },
    { value: 0, expected: false },
    { value: 1, expected: false },
    { value: -7, expected: false },
    { value: 2.5, expected: false },
    { value: Number.NaN, expected: false },
    { value: Number.POSITIVE_INFINITY, expected: false },
    { value: Number.MAX_SAFE_INTEGER + 1, expected: false },
    { value: 2n, expected: true },
    { value: 2305843009213693951n, expected: true },
    { value: 4n, expected: false },
    { value: -2n, expected: false },
  ])("classifies $value as $expected", ({ value, expected }) => {
    expect(isPrime(value)).toBe(expected);
  });
});
