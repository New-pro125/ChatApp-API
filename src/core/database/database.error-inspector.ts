/**
 * Inspects PostgreSQL/driver errors, including errors wrapped by Drizzle.
 *
 * Drizzle re-throws driver failures inside its own error wrapper, so the
 * original `pg` error (with `code` and `constraint`) may be several levels
 * deep in the `cause` chain. Repositories use this class instead of reading
 * `error.code` directly.
 */
export class PostgresErrorInspector {
  static readonly UNIQUE_VIOLATION = '23505';

  find(error: unknown): { code: string; constraint?: string } | null {
    let current: unknown = error;
    const visited = new Set<unknown>();

    while (typeof current === 'object' && current !== null && !visited.has(current)) {
      visited.add(current);

      const candidate = current as {
        code?: unknown;
        constraint?: unknown;
        cause?: unknown;
      };

      if (typeof candidate.code === 'string') {
        return {
          code: candidate.code,
          ...(typeof candidate.constraint === 'string' ? { constraint: candidate.constraint } : {}),
        };
      }

      current = candidate.cause;
    }

    return null;
  }

  isUniqueViolation(error: unknown): boolean {
    return this.find(error)?.code === PostgresErrorInspector.UNIQUE_VIOLATION;
  }

  constraintName(error: unknown): string | undefined {
    return this.find(error)?.constraint;
  }
}
