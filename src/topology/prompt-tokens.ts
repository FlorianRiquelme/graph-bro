/**
 * Capture 1 is the optional escape backslash, capture 2 the dotted path. Only
 * the *opening* delimiter is significant, so a bare `}}` needs no escape.
 * Shared with `extractTokenPaths` deliberately: the lint (graph-bro#7) and the
 * renderer must agree on what counts as a token, or the lint reports on text
 * the renderer never touches. Safe to share despite the `g` flag —
 * `String.prototype.replace` resets `lastIndex` to 0 on every call, while
 * `matchAll` only reads it, so neither call site leaves state for the next.
 * This instance must therefore never be used with `test`/`exec`, which would
 * leave `lastIndex` dirty for the next caller. Lives here, in the topology
 * layer, rather than beside the renderer, so the static lint can share it
 * without `topology/` depending on `engine/`.
 */
export const TOKEN_PATTERN = /(\\)?\{\{\s*([^}]+?)\s*\}\}/g;

/**
 * The dotted paths of every live token in `template`, in source order —
 * escaped tokens excluded, since those are literal text the renderer never
 * resolves. The static seam graph-bro#7's root-key check reads, so that the
 * lint and the renderer share one definition of the token grammar.
 */
export function extractTokenPaths(template: string): string[] {
  return [...template.matchAll(TOKEN_PATTERN)].filter((match) => !match[1]).map((match) => match[2]);
}
