import { describe, expect, it } from "vitest";
import { mergeWrites, StateConflictError } from "../../src/engine/reducers.js";
import type { ReducerName } from "../../src/topology/schema.js";

describe("mergeWrites", () => {
  it("append concatenates values across writes", () => {
    const state = mergeWrites(
      {},
      [
        { key: "log", value: "a" },
        { key: "log", value: "b" },
      ],
      () => "append" as ReducerName,
    );
    expect(state.log).toEqual(["a", "b"]);
  });

  it("merge spreads objects across writes", () => {
    const state = mergeWrites(
      {},
      [
        { key: "obj", value: { a: 1 } },
        { key: "obj", value: { b: 2 } },
      ],
      () => "merge" as ReducerName,
    );
    expect(state.obj).toEqual({ a: 1, b: 2 });
  });

  it("sum adds numeric values across writes", () => {
    const state = mergeWrites(
      { total: 10 },
      [
        { key: "total", value: 1 },
        { key: "total", value: 2 },
      ],
      () => "sum" as ReducerName,
    );
    expect(state.total).toBe(13);
  });

  it("dedup removes duplicates across branches", () => {
    const state = mergeWrites(
      {},
      [
        { key: "results", value: "x" },
        { key: "results", value: "y" },
        { key: "results", value: "x" },
      ],
      () => "dedup" as ReducerName,
    );
    expect(state.results).toEqual(["x", "y"]);
  });

  it("reducers fold on top of existing state across super-steps", () => {
    const first = mergeWrites({}, [{ key: "log", value: "a" }], () => "append" as ReducerName);
    const second = mergeWrites(first, [{ key: "log", value: "b" }], () => "append" as ReducerName);
    expect(second.log).toEqual(["a", "b"]);
  });

  it("raises StateConflictError when two writes to an unreduced key disagree", () => {
    expect(() =>
      mergeWrites(
        {},
        [
          { key: "answer", value: 1 },
          { key: "answer", value: 2 },
        ],
        () => undefined,
      ),
    ).toThrow(StateConflictError);
  });

  it("does not raise when two writes to an unreduced key agree", () => {
    const state = mergeWrites(
      {},
      [
        { key: "answer", value: 1 },
        { key: "answer", value: 1 },
      ],
      () => undefined,
    );
    expect(state.answer).toBe(1);
  });

  it("a single write to an unreduced key simply overwrites", () => {
    const state = mergeWrites({ answer: 1 }, [{ key: "answer", value: 2 }], () => undefined);
    expect(state.answer).toBe(2);
  });
});
