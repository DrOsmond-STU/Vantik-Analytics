/** Deklarasi tipe untuk jembatan — lihat catatan di `mqtt.d.ts`. */

export interface Mapping {
  topic: string;
  assetCode?: string;
  sensorCode?: string;
  valuePath?: string;
  timePath?: string;
}

export interface Reading {
  assetCode: string;
  sensorCode: string;
  value: number;
  observedAt?: string;
}

export declare function readValue(
  payload: Buffer,
  mapping: Partial<Mapping>,
): { value: number; observedAt: string | null } | null;

export declare function resolveCodes(
  topic: string,
  mapping: Partial<Mapping> & { topic: string },
): { assetCode: string; sensorCode: string };

export declare function subscriptionFilter(pattern: string): string;
export declare function normaliseTime(raw: unknown): string | null;
export declare function pluck(object: unknown, path: string): unknown;

export declare class Forwarder {
  constructor(
    config: { vantik: { baseUrl: string; ingestToken: string; batchSize?: number; flushIntervalMs?: number; maxQueue?: number; timeoutMs?: number } },
    log: (message: string) => void,
  );
  queue: Reading[];
  dropped: number;
  push(reading: Reading): void;
  start(): void;
  stop(): void;
  flush(): Promise<void>;
}
