import { describe, expect, it } from "vitest";
import { EnvelopeParseError, parseEnvelope } from "../../src/executor/envelope.js";

const VALID_ENVELOPE = {
  type: "result",
  subtype: "success",
  is_error: false,
  result: "pong",
  num_turns: 1,
  stop_reason: "end_turn",
  terminal_reason: "completed",
  session_id: "session-1",
  duration_ms: 6100,
  duration_api_ms: 1365,
  total_cost_usd: 0.028881,
  usage: {
    input_tokens: 10,
    cache_creation_input_tokens: 13436,
    cache_read_input_tokens: 17740,
    output_tokens: 45,
  },
  modelUsage: { "claude-haiku-4-5": { costUSD: 0.028881 } },
  permission_denials: [{ tool_name: "Write", tool_use_id: "abc", tool_input: {} }],
  api_error_status: null,
};

describe("executor: envelope", () => {
  it("parses a valid terminal envelope, preserving cost/duration/tokens", () => {
    const envelope = parseEnvelope(VALID_ENVELOPE);

    expect(envelope.is_error).toBe(false);
    expect(envelope.result).toBe("pong");
    expect(envelope.total_cost_usd).toBe(0.028881);
    expect(envelope.duration_ms).toBe(6100);
    expect(envelope.usage?.input_tokens).toBe(10);
    expect(envelope.permission_denials?.[0]?.tool_name).toBe("Write");
  });

  it("parses an error envelope (is_error true) without discarding result", () => {
    const envelope = parseEnvelope({
      type: "result",
      is_error: true,
      result: "permission denied",
      duration_ms: 12,
    });

    expect(envelope.is_error).toBe(true);
    expect(envelope.result).toBe("permission denied");
  });

  it("rejects a malformed envelope (wrong type) with a typed error", () => {
    expect(() => parseEnvelope({ type: "assistant", is_error: false, result: "x", duration_ms: 1 })).toThrow(
      EnvelopeParseError,
    );
  });

  it("rejects a partial envelope missing required fields", () => {
    expect(() => parseEnvelope({ type: "result", is_error: false })).toThrow(EnvelopeParseError);
  });

  it("rejects a non-object candidate", () => {
    expect(() => parseEnvelope("not an envelope")).toThrow(EnvelopeParseError);
  });
});
