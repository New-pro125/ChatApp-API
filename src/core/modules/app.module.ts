import type { Router } from 'express';

export interface AppModule {
  readonly name: string;
  readonly mountPath: string;
  readonly router: Router;
  configure(): void | Promise<void>;
  dispose(): Promise<void>;
}
