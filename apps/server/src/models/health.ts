import type { Provider } from "@lumen/shared";

export interface HealthOptions {
  failureThreshold?: number;
  cooldownMs?: number;
  now?: () => number;
}

/** A provider is unhealthy for `cooldownMs` after N consecutive failures (docs/04 §3). */
export class HealthRegistry {
  private readonly failures = new Map<Provider, number>();
  private readonly unhealthyUntil = new Map<Provider, number>();
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  constructor(opts: HealthOptions = {}) {
    this.threshold = opts.failureThreshold ?? 2;
    this.cooldownMs = opts.cooldownMs ?? 60_000;
    this.now = opts.now ?? Date.now;
  }

  isHealthy(provider: Provider): boolean {
    const until = this.unhealthyUntil.get(provider);
    if (until === undefined) return true;
    if (this.now() >= until) {
      this.unhealthyUntil.delete(provider);
      this.failures.delete(provider);
      return true;
    }
    return false;
  }

  recordSuccess(provider: Provider): void {
    this.failures.delete(provider);
  }

  /** Returns true if this failure tipped the provider into unhealthy. */
  recordFailure(provider: Provider): boolean {
    const count = (this.failures.get(provider) ?? 0) + 1;
    this.failures.set(provider, count);
    if (count >= this.threshold && this.isHealthy(provider)) {
      this.unhealthyUntil.set(provider, this.now() + this.cooldownMs);
      return true;
    }
    return false;
  }
}
