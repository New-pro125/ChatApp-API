declare module 'passport-local' {
  import type { Request } from 'express';
  import { Strategy as PassportStrategy } from 'passport-strategy';

  interface StrategyOptions {
    usernameField?: string;
    passwordField?: string;
    session?: boolean;
    passReqToCallback?: false;
  }

  interface StrategyOptionsWithRequest extends StrategyOptions {
    passReqToCallback: true;
  }

  interface VerifyOptions {
    message?: string;
    mfaRequired?: boolean;
    challengeToken?: string;
    expiresAt?: string;
  }

  type VerifyFunction = (
    username: string,
    password: string,
    done: (error: unknown, user?: Express.User | false, options?: VerifyOptions) => void,
  ) => void;

  type VerifyFunctionWithRequest = (
    req: Request,
    username: string,
    password: string,
    done: (error: unknown, user?: Express.User | false, options?: VerifyOptions) => void,
  ) => void;

  class Strategy extends PassportStrategy {
    constructor(options: StrategyOptionsWithRequest, verify: VerifyFunctionWithRequest);
    constructor(options: StrategyOptions, verify: VerifyFunction);
    constructor(verify: VerifyFunction);

    name: string;
  }

  export = Strategy;
}
