import { getPath } from "./state.js";
import type { EngineState } from "./state.js";

/**
 * Capture 1 is the optional escape backslash, capture 2 the dotted path. Only
 * the *opening* delimiter is significant, so a bare `}}` needs no escape.
 * Shared with `extractTokenPaths` deliberately: the lint (graph-bro#7) and the
 * renderer must agree on what counts as a token, or the lint reports on text
 * the renderer never touches. Safe to share despite the `g` flag — `replace`
 * and `matchAll` both leave `lastIndex` untouched.
 */
const TOKEN_PATTERN = /(\\)?\{\{\s*([^}]+?)\s*\}\}/g;

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
 *
 * A token may be escaped as `\{{ path }}` to emit the literal delimiters as
 * text (graph-bro#8); the escape is stripped and the inner spacing preserved
 * verbatim. One limitation, deliberate: because the escape is not itself
 * escapable, a literal backslash cannot immediately precede a live token
 * (`\\{{ a }}` unescapes rather than substituting). No prompt needs that
 * today, and doubling the grammar to support it would buy nothing.
 */
export function renderPromptTemplate(template: string, input: EngineState, nodeId: string): string {
  return template.replace(TOKEN_PATTERN, (match: string, escape: string | undefined, path: string) => {
    if (escape) return match.slice(1);
    const value = getPath(input, path);
    return serialize(value, nodeId, path);
  });
}

/**
 * The dotted paths of every live token in `template`, in source order —
 * escaped tokens excluded, since those are literal text the renderer never
 * resolves. The static seam graph-bro#7's root-key check reads, so that the
 * lint and the renderer share one definition of the token grammar.
 */
export function extractTokenPaths(template: string): string[] {
  return [...template.matchAll(TOKEN_PATTERN)].filter((match) => !match[1]).map((match) => match[2]);
}
