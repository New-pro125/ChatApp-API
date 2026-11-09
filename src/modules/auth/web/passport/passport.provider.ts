import type passport from 'passport';

export type PassportStatic = typeof passport;

export interface PassportProvider {
  readonly name: string;
  readonly routePath: string;
  readonly scope: string | string[];
  register(passport: PassportStatic): void | Promise<void>;
}
