import type { ResettableJoinBarrier } from "./barrier.js";

/**
 * Raised by the runtime join watchdog (KTD-7): a join received arrivals from
 * some but not all of its declared sources, and the frontier drained without
 * ever completing it — a stalled join, named with its unreported sources
 * rather than silently burning `max_steps`.
 */
export class UnreachableJoinError extends Error {
  constructor(
    public readonly joinId: string,
    public readonly missingSources: string[],
  ) {
    super(`join '${joinId}' is unreachable: missing arrivals from [${missingSources.join(", ")}]`);
    this.name = "UnreachableJoinError";
  }
}

export interface StalledJoin {
  joinId: string;
  missingSources: string[];
}

/**
 * Scans join barriers for one that has partial arrivals (some sources
 * reported, at least one didn't) and is not complete — the signature of a
 * stalled join rather than a join simply never engaged this run.
 */
export function detectStalledJoin(
  barriers: Map<string, ResettableJoinBarrier>,
): StalledJoin | undefined {
  for (const [joinId, barrier] of barriers) {
    if (barrier.isComplete()) continue;
    if (!barrier.hasAnyArrival()) continue;
    const missingSources = barrier.unreportedSources();
    if (missingSources.length > 0) return { joinId, missingSources };
  }
  return undefined;
}
