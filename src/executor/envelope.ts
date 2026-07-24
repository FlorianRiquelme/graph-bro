import { z } from "zod";

const UsageSchema = z
  .object({
    input_tokens: z.number().optional(),
    output_tokens: z.number().optional(),
    cache_creation_input_tokens: z.number().optional(),
    cache_read_input_tokens: z.number().optional(),
  })
  .passthrough();

const PermissionDenialSchema = z
  .object({
    tool_name: z.string(),
    tool_use_id: z.string().optional(),
    tool_input: z.unknown().optional(),
  })
  .passthrough();

/**
 * The Claude Code terminal event (`type === "result"`), live-verified against
 * `claude` v2.1.218 `--output-format stream-json --verbose` (KTD-8 probe,
 * 2026-07-24). `total_cost_usd`/`duration_ms` are the authoritative
 * cost/latency fields — not `cost_usd` — resolving the plan's own flagged
 * naming ambiguity. `.passthrough()` tolerates fields this schema doesn't
 * name (version drift); required fields still fail loudly if missing.
 */
export const ResultEnvelopeSchema = z
  .object({
    type: z.literal("result"),
    subtype: z.string().optional(),
    is_error: z.boolean(),
    result: z.string(),
    num_turns: z.number().optional(),
    stop_reason: z.string().optional(),
    terminal_reason: z.string().optional(),
    session_id: z.string().optional(),
    duration_ms: z.number(),
    duration_api_ms: z.number().optional(),
    total_cost_usd: z.number().optional(),
    usage: UsageSchema.optional(),
    modelUsage: z.record(z.string(), z.unknown()).optional(),
    permission_denials: z.array(PermissionDenialSchema).optional(),
    api_error_status: z.union([z.string(), z.null()]).optional(),
  })
  .passthrough();
export type ResultEnvelope = z.infer<typeof ResultEnvelopeSchema>;

/** Raised when a terminal (`type === "result"`) line fails envelope validation. */
export class EnvelopeParseError extends Error {
  constructor(
    public readonly issues: z.ZodIssue[],
    public readonly raw: unknown,
  ) {
    super(
      `invalid Claude Code result envelope: ${issues
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("; ")}`,
    );
    this.name = "EnvelopeParseError";
  }
}

/** Validates a parsed terminal event against the envelope schema; throws `EnvelopeParseError` on a malformed/partial envelope. */
export function parseEnvelope(candidate: unknown): ResultEnvelope {
  const parsed = ResultEnvelopeSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new EnvelopeParseError(parsed.error.issues, candidate);
  }
  return parsed.data;
}
