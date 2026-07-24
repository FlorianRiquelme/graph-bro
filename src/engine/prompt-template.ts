import { getPath } from "./state.js";
import type { EngineState } from "./state.js";

const TOKEN_PATTERN = /\{\{\s*([^}]+?)\s*\}\}/g;

/**
 * Fail-loud counterpart to `StateConflictError` (R5, ADR-0006's fail-loud
 * stance): a template token whose path resolves to `undefined` in the input
 * snapshot, surfaced before the executor runs rather than silently emitted
 * as empty text.
 */
export class UnresolvedPromptTokenError extends Error {
  constructor(
    public readonly nodeId: string,
    public readonly path: string,
  ) {
    super(
      `agent node '${nodeId}': unresolved prompt token '{{ ${path} }}' — path not present in input snapshot`,
    );
    this.name = "UnresolvedPromptTokenError";
  }
}

function serialize(value: unknown, nodeId: string, path: string): string {
  if (value === undefined) throw new UnresolvedPromptTokenError(nodeId, path);
  if (typeof value === "string") return value;
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value, null, 2);
}

/**
 * Single-pass-interpolates `{{ dotted.path }}` tokens in `template` against
 * `input` (R1/R3). A template with no tokens returns unchanged (AE5). Each
 * resolved value is serialized by type (R4); an unresolvable path throws
 * `UnresolvedPromptTokenError` (R5). Substituted text is never re-scanned by
 * this pass (KTD-6).
 */
export function renderPromptTemplate(template: string, input: EngineState, nodeId: string): string {
  return template.replace(TOKEN_PATTERN, (_match, path: string) => {
    const value = getPath(input, path);
    return serialize(value, nodeId, path);
  });
}
