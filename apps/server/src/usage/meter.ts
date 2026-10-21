import { AsyncLocalStorage } from "node:async_hooks";
import { and, eq, gte, sql } from "drizzle-orm";
import type { ModelsConfig, PricingConfig, Provider } from "@lumen/shared";
import type { Db } from "../db/client.js";
import { usageLog } from "../db/schema.js";
import { estimateUsd } from "./pricing.js";

export interface UsageEvent {
  agent: string;
  provider: Provider;
  model: string;
  inputTokens?: number;
  cachedTokens?: number;
  outputTokens?: number;
  images?: number;
  imageQuality?: "low" | "medium" | "high";
  latencyMs?: number;
  fallbackUsed?: boolean;
  /** Defaults to the ambient usage context (withUsageContext). */
  periodId?: string;
}

export type BudgetState = "ok" | "warn" | "degrade" | "pause";

export interface UsageTotals {
  periodUsd: number | null;
  dayUsd: number;
  monthUsd: number;
  capUsd: number;
  /** Calls this month whose price is unknown ("≈?"). */
  unpricedCalls: number;
}

export class BudgetPausedError extends Error {
  constructor(
    readonly monthUsd: number,
    readonly capUsd: number,
  ) {
    super(
      `Monthly budget reached ($${monthUsd.toFixed(2)} of $${capUsd.toFixed(2)}); agents paused`,
    );
    this.name = "BudgetPausedError";
  }
}

interface UsageContext {
  periodId?: string;
}
const context = new AsyncLocalStorage<UsageContext>();

/** Tags every call made inside `fn` with this period (for per-period cost). */
export function withUsageContext<T>(ctx: UsageContext, fn: () => T): T {
  return context.run(ctx, fn);
}

export interface MeterDeps {
  db: Db;
  pricing: PricingConfig;
  budget: ModelsConfig["budget"];
  now?: () => Date;
  /** The image role's model id, for imagePrice(). */
  imageModel?: string;
}

/**
 * Records every provider call to usage_log and derives the budget state from
 * this month's spend (local calendar month). Spend is cached in memory and
 * reloaded from the DB at month rollover.
 */
export class UsageMeter {
  private readonly now: () => Date;
  private monthKey = "";
  private monthUsd = 0;
  private state: BudgetState = "ok";
  private readonly listeners = new Set<(state: BudgetState, totals: UsageTotals) => void>();

  constructor(private readonly deps: MeterDeps) {
    this.now = deps.now ?? (() => new Date());
    this.refreshMonth();
    this.state = this.computeState();
  }

  record(e: UsageEvent): { estUsd: number | null; state: BudgetState } {
    const at = this.now();
    this.refreshMonth();
    const estUsd = estimateUsd(this.deps.pricing, { ...e, at });
    this.deps.db
      .insert(usageLog)
      .values({
        ts: at.toISOString(),
        agent: e.agent,
        provider: e.provider,
        model: e.model,
        inputTokens: e.inputTokens ?? null,
        cachedTokens: e.cachedTokens ?? null,
        outputTokens: e.outputTokens ?? null,
        images: e.images ?? null,
        latencyMs: e.latencyMs == null ? null : Math.round(e.latencyMs),
        estUsd,
        periodId: e.periodId ?? context.getStore()?.periodId ?? null,
        fallbackUsed: e.fallbackUsed ?? false,
      })
      .run();
    if (estUsd != null) this.monthUsd += estUsd;

    const next = this.computeState();
    if (next !== this.state) {
      this.state = next;
      const totals = this.totals();
      for (const fn of this.listeners) fn(next, totals);
    }
    return { estUsd, state: this.state };
  }

  budgetState(): BudgetState {
    this.refreshMonth();
    this.state = this.computeState();
    return this.state;
  }

  /** Throws BudgetPausedError when agents must stop (docs/03 §8). */
  assertCanCall(): void {
    if (this.budgetState() === "pause") {
      throw new BudgetPausedError(this.monthUsd, this.deps.budget.monthlyUsdCap);
    }
  }

  /** Image spend this month (usage_log rows tagged image*). */
  imageMonthUsd(): number {
    return (
      this.deps.db
        .select({ usd: sql<number>`coalesce(sum(${usageLog.estUsd}), 0)` })
        .from(usageLog)
        .where(
          and(
            gte(usageLog.ts, startOfMonth(this.now()).toISOString()),
            sql`${usageLog.agent} LIKE 'image%'`,
          ),
        )
        .get()?.usd ?? 0
    );
  }

  /** Price of one image of the configured image model at this quality, if known. */
  imagePrice(quality: "low" | "medium" | "high", model?: string): number | null {
    const m = model ?? this.deps.imageModel;
    if (!m) return null;
    return estimateUsd(this.deps.pricing, {
      provider: "openai",
      model: m,
      images: 1,
      imageQuality: quality,
      at: this.now(),
    });
  }

  /** Images left before the image cap, in USD. */
  imageBudgetLeft(): number {
    return Math.max(0, (this.deps.budget.imagesUsdCap ?? 5) - this.imageMonthUsd());
  }

  /** Throws when the whole budget or the image share is spent. */
  assertCanCallImage(): void {
    this.assertCanCall();
    if (this.imageBudgetLeft() <= 0)
      throw new BudgetPausedError(this.imageMonthUsd(), this.deps.budget.imagesUsdCap ?? 5);
  }

  /** Fires on every state transition (ok → warn → degrade → pause, and back at rollover). */
  onStateChange(fn: (state: BudgetState, totals: UsageTotals) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  totals(periodId?: string): UsageTotals {
    this.refreshMonth();
    const { db } = this.deps;
    const sum = (since: Date, extra?: ReturnType<typeof eq>) =>
      db
        .select({ usd: sql<number>`coalesce(sum(${usageLog.estUsd}), 0)` })
        .from(usageLog)
        .where(
          extra
            ? and(gte(usageLog.ts, since.toISOString()), extra)
            : gte(usageLog.ts, since.toISOString()),
        )
        .get()?.usd ?? 0;

    const unpriced =
      db
        .select({ n: sql<number>`count(*)` })
        .from(usageLog)
        .where(
          and(
            gte(usageLog.ts, startOfMonth(this.now()).toISOString()),
            sql`${usageLog.estUsd} IS NULL`,
          ),
        )
        .get()?.n ?? 0;

    const pid = periodId ?? context.getStore()?.periodId;
    return {
      periodUsd: pid ? sum(new Date(0), eq(usageLog.periodId, pid)) : null,
      dayUsd: sum(startOfDay(this.now())),
      monthUsd: this.monthUsd,
      capUsd: this.deps.budget.monthlyUsdCap,
      unpricedCalls: unpriced,
    };
  }

  private computeState(): BudgetState {
    const { monthlyUsdCap: cap, softWarnAt, degradeAt, onCap } = this.deps.budget;
    const frac = this.monthUsd / cap;
    if (frac >= 1) return "pause";
    if (onCap === "degrade_then_pause" && frac >= degradeAt) return "degrade";
    if (frac >= softWarnAt) return "warn";
    return "ok";
  }

  private refreshMonth(): void {
    const start = startOfMonth(this.now());
    const key = start.toISOString();
    if (key === this.monthKey) return;
    this.monthKey = key;
    this.monthUsd =
      this.deps.db
        .select({ usd: sql<number>`coalesce(sum(${usageLog.estUsd}), 0)` })
        .from(usageLog)
        .where(gte(usageLog.ts, key))
        .get()?.usd ?? 0;
  }
}

// Calendar boundaries in the server's local timezone (the user's machine).
function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
