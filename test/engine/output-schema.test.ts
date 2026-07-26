import { describe, expect, it } from "vitest";
import { MissingStructuredOutputError, OutputSchemaViolationError, validateOutput } from "../../src/engine/output-schema.js";

const SCHEMA = {
  type: "object",
  properties: { verdict: { type: "string", enum: ["pass", "fail"] }, findings: { type: "array" } },
  required: ["verdict"],
};

describe("engine: output-schema", () => {
  it("Covers AE2: a conforming value passes without throwing", () => {
    expect(() => validateOutput("reviewer", SCHEMA, { verdict: "pass", findings: [] })).not.toThrow();
  });

  it("Covers AE2: a non-conforming value throws OutputSchemaViolationError naming the node and the violation", () => {
    try {
      validateOutput("reviewer", SCHEMA, { verdict: "maybe" });
      expect.unreachable("expected validateOutput to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(OutputSchemaViolationError);
      const violation = err as OutputSchemaViolationError;
      expect(violation.nodeId).toBe("reviewer");
      expect(violation.message).toContain("reviewer");
      expect(violation.message).toContain("verdict");
    }
  });

  it("a value missing a required property is rejected", () => {
    expect(() => validateOutput("reviewer", SCHEMA, {})).toThrow(OutputSchemaViolationError);
  });

  it("MissingStructuredOutputError names the node", () => {
    const err = new MissingStructuredOutputError("reviewer");
    expect(err.message).toContain("reviewer");
    expect(err.nodeId).toBe("reviewer");
  });
});
