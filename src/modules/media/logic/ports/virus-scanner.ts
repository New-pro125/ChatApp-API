import type { Readable } from 'node:stream';

export type ScanResult = { verdict: 'clean' } | { verdict: 'infected'; signature: string };

export interface VirusScanner {
  scan(stream: Readable): Promise<ScanResult>;
}
