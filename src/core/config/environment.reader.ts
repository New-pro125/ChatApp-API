/**
 * Reads and validates environment variables.
 *
 * Keeping `process.env` access in one place makes configuration parsing easy to
 * audit and keeps the rest of the application free of direct environment access.
 */
export class EnvironmentReader {
  readRequired(name: string): string {
    const value = this.readOptional(name);

    if (value === undefined) {
      throw new Error(`Missing required environment variable: ${name}`);
    }

    return value;
  }

  readOptional(name: string): string | undefined {
    const value = process.env[name];

    return value === undefined || value.length === 0 ? undefined : value;
  }

  readString(name: string, fallback: string): string {
    return this.readOptional(name) ?? fallback;
  }

  readNumber(name: string, fallback: number): number {
    const raw = this.readOptional(name);

    if (raw === undefined) {
      return fallback;
    }

    const value = Number(raw);

    if (!Number.isFinite(value)) {
      throw new Error(`Environment variable ${name} must be a number`);
    }

    return value;
  }

  readBoolean(name: string, fallback: boolean): boolean {
    const raw = this.readOptional(name);

    if (raw === undefined) {
      return fallback;
    }

    if (raw === 'true') {
      return true;
    }

    if (raw === 'false') {
      return false;
    }

    throw new Error(`Environment variable ${name} must be "true" or "false"`);
  }

  readEnum<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
    const raw = this.readOptional(name);

    if (raw === undefined) {
      return fallback;
    }

    if (!allowed.includes(raw as T)) {
      throw new Error(`Environment variable ${name} must be one of: ${allowed.join(', ')}`);
    }

    return raw as T;
  }
}
