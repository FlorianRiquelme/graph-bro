/**
 * A resettable join barrier (§13.3 `NamedBarrierValue`): tracks arrivals per
 * *declared* source, keyed within each source by **per-instance identity**
 * (KTD-12) rather than the bare source name. A dynamic fan-out reuses one
 * node id for N branches, so a source's expected set is armed at runtime with
 * the N `${node}:${itemKey}` instance ids (see `armSource`) instead of
 * defaulting to the bare node id.
 */
export class ResettableJoinBarrier {
  private readonly expectedBySource = new Map<string, Set<string>>();
  private readonly arrivedBySource = new Map<string, Set<string>>();

  constructor(
    public readonly id: string,
    private readonly sources: string[],
    private readonly mode: "all" | "any",
  ) {
    for (const source of sources) {
      // Default: a static (non-fan-out) source's only expected instance is
      // its own bare node id.
      this.expectedBySource.set(source, new Set([source]));
      this.arrivedBySource.set(source, new Set());
    }
  }

  /** (Re-)arms a source with the runtime-derived instance ids for this cycle. */
  armSource(source: string, instanceIds: string[]): void {
    if (!this.expectedBySource.has(source)) {
      throw new Error(`join barrier '${this.id}': unknown source '${source}'`);
    }
    this.expectedBySource.set(source, new Set(instanceIds));
    this.arrivedBySource.set(source, new Set());
  }

  /** Records one instance's arrival for a declared source. */
  arrive(source: string, instanceId: string): void {
    const arrived = this.arrivedBySource.get(source);
    if (!arrived) {
      throw new Error(`join barrier '${this.id}': unknown source '${source}'`);
    }
    arrived.add(instanceId);
  }

  /** Whether the barrier's `mode` condition (`all`/`any`) is satisfied. */
  isComplete(): boolean {
    if (this.mode === "any") return this.hasAnyArrival();
    return this.unreportedSources().length === 0;
  }

  /** Clears arrivals so the barrier can fire again on a later cycle. Expected sets survive until re-armed. */
  reset(): void {
    for (const source of this.sources) {
      this.arrivedBySource.set(source, new Set());
    }
  }

  /** Whether any source has received at least one arrival since the last reset/arm. */
  hasAnyArrival(): boolean {
    for (const arrived of this.arrivedBySource.values()) {
      if (arrived.size > 0) return true;
    }
    return false;
  }

  /** Declared sources whose expected instance set has not fully reported. */
  unreportedSources(): string[] {
    const missing: string[] = [];
    for (const source of this.sources) {
      const expected = this.expectedBySource.get(source)!;
      const arrived = this.arrivedBySource.get(source)!;
      const complete = expected.size > 0 && [...expected].every((id) => arrived.has(id));
      if (!complete) missing.push(source);
    }
    return missing;
  }
}
