import { describe, expect, it } from "vitest";
import { ResettableJoinBarrier } from "../../src/engine/barrier.js";

describe("ResettableJoinBarrier", () => {
  it("fires only after all declared static sources arrive", () => {
    const barrier = new ResettableJoinBarrier("join-1", ["branchA", "branchB"], "all");
    barrier.arrive("branchA", "branchA");
    expect(barrier.isComplete()).toBe(false);
    barrier.arrive("branchB", "branchB");
    expect(barrier.isComplete()).toBe(true);
  });

  it("KTD-12: does not early-fire on the first of N dynamic instances of one node id", () => {
    const barrier = new ResettableJoinBarrier("join-fanout", ["reader"], "all");
    barrier.armSource("reader", ["reader:0", "reader:1", "reader:2"]);

    barrier.arrive("reader", "reader:0");
    expect(barrier.isComplete()).toBe(false);

    barrier.arrive("reader", "reader:1");
    expect(barrier.isComplete()).toBe(false);

    barrier.arrive("reader", "reader:2");
    expect(barrier.isComplete()).toBe(true);
  });

  it("resets and fires again on a second arm cycle", () => {
    const barrier = new ResettableJoinBarrier("join-1", ["branchA", "branchB"], "all");
    barrier.arrive("branchA", "branchA");
    barrier.arrive("branchB", "branchB");
    expect(barrier.isComplete()).toBe(true);

    barrier.reset();
    expect(barrier.isComplete()).toBe(false);

    barrier.arrive("branchA", "branchA");
    barrier.arrive("branchB", "branchB");
    expect(barrier.isComplete()).toBe(true);
  });

  it("mode 'any' fires as soon as one source reports", () => {
    const barrier = new ResettableJoinBarrier("join-any", ["branchA", "branchB"], "any");
    barrier.arrive("branchA", "branchA");
    expect(barrier.isComplete()).toBe(true);
  });

  it("reports unreported sources for a partially-arrived barrier", () => {
    const barrier = new ResettableJoinBarrier("join-1", ["branchA", "branchB"], "all");
    barrier.arrive("branchA", "branchA");
    expect(barrier.hasAnyArrival()).toBe(true);
    expect(barrier.unreportedSources()).toEqual(["branchB"]);
  });
});
