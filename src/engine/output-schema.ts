// Named import, not default: ajv's CJS package has no "exports" map, and under
// this project's NodeNext module resolution the synthesized default import
// types as the whole module namespace rather than the `Ajv` class itself.
import { Ajv } from "ajv";

/**
 * KTD-8: validation lives here, next to the `output_key` write in `loop.ts`,
 * rather than behind the executor seam — "the backend already validated it"
 * is not a claim the engine can verify, and putting it behind the seam would
 * make every future backend re-implement it. The topology declares JSON
 * Schema (the contract the backend consumes); zod continues to validate the
 * topology document itself, including that a declared `output_schema` is a
 * well-formed schema (U2). ajv is the mature JSON Schema validator, per the
 * standing preference for the broad ecosystem over a hand-rolled subset.
 */
const ajv = new Ajv({ allErrors: true, strict: false });

export type JsonSchema = Record<string, unknown>;

/** Raised when an agent node's structured output does not conform to its declared `output_schema` (R2). */
export class OutputSchemaViolationError extends Error {
  constructor(
    public readonly nodeId: string,
    public readonly details: string,
  ) {
    super(`agent node '${nodeId}' returned output that violates its declared output schema: ${details}`);
    this.name = "OutputSchemaViolationError";
  }
}

/**
 * Raised when a node declared an output schema but the envelope carried no
 * structured field at all. Keyed on the field's absence rather than on a
 * result subtype string, so it holds whether the cause is the documented
 * retry-exhaustion path or anything else that omits the field (KTD-2).
 */
export class MissingStructuredOutputError extends Error {
  constructor(public readonly nodeId: string) {
    super(`agent node '${nodeId}' declared an output schema but returned no structured output`);
    this.name = "MissingStructuredOutputError";
  }
}

/** Validates `value` against `schema`; throws `OutputSchemaViolationError` naming the node and the violation on mismatch. */
export function validateOutput(nodeId: string, schema: JsonSchema, value: unknown): void {
  const validate = ajv.compile(schema);
  if (!validate(value)) {
    throw new OutputSchemaViolationError(nodeId, ajv.errorsText(validate.errors, { separator: "; " }));
  }
}
