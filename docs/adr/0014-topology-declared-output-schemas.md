# ADR-0014: Node output schemas are declared by the topology, never by the engine

- **Status:** Accepted
- **Date:** 2026-07-25
- **Context slice:** Engine Slice 2 — resolves R2, and with it R4 (findings reaching the fixer).

## Decision

An `agent` node may declare an **output schema**. The engine passes it to the backend as a structured-output contract (`--json-schema`), validates the response against it, and writes the **parsed value** — not the raw text — to the node's `output_key`. A response that does not conform fails the run, per ADR-0006's loud-fail stance.

graph-bro ships **no built-in verdict type, review type, or any other domain-shaped schema.** The engine knows only that a node may return structured data.

## Rationale

This milestone's headline primitive is a loop that routes on a review's judgment, and the obvious implementation is an engine-owned `VerdictSchema` — `{status, findings}` — which every review node returns and which the loop's convergence test is written against. It would be smaller, and the routing semantics would be tighter.

It is rejected on the boundary invariant. An engine with a built-in verdict type **knows that its consumers do code review**. That is the same category of leak as naming a consumer in a shipped artifact, and it fails the same test: *if an artifact knows who's calling it, it's in the wrong repo.* "Review" must stay a topology the consumer authors, not a concept the engine ships.

The generic version also composes better, which makes the boundary argument cheap rather than costly:

- `mergeWrites` assigns write keys verbatim and flat, while read paths are dotted and traverse nesting — so a parsed object sitting at a flat `output_key` is addressable by `when` rules through the existing `getPath` traversal, with no new machinery.
- The existing prompt-template primitive then carries R4 for free: a fix node's prompt reads `{{ verdict.findings }}` and the findings reach the fixer without a dedicated mechanism, exactly as the requirements assumed.
- Any node gains structured output, not only review nodes. That is worth more than a verdict type.

It also lands the zod-everywhere convention where the convention actually intends it — on the JSON-schema contracts for agents, not only at HTTP request-body edges. A node's schema is authored as zod and emitted via `z.toJSONSchema()`.

## Consequences

- **Loop semantics stay generic.** The engine never tests "did review pass"; it evaluates a `when` rule the topology wrote against a path the topology named. Convergence is a topology-level concept.
- **A malformed structured response is a run failure, not a retry.** Affordable only because of ADR-0013: every attempt is already committed, so a bad response costs a `resume`, not the run's work. The two decisions are coupled — weakening ADR-0013 would make this stance expensive again.
- **Structured output is a tool-call loop the model can fail to complete**, not a decoding constraint that cannot fail. Failures are real and must be handled, not treated as impossible.
- **A latent extension, deliberately not taken:** with a declared schema, the prompt-token root check (`lint.ts`) could statically verify *deep* paths, not just roots. Tempting and out of scope.
- **Planning must live-probe the result envelope first.** `envelope.ts` pins `result: z.string()`; if structured mode returns an object there, `parseEnvelope` throws, the catch in `claude-code.ts` swallows it, and the node fails silently with empty text. This sits on the critical path for the whole decision — settle it the way KTD-8 settled the read-only tool probe.
