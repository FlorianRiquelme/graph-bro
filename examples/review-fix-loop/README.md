# review-fix-loop

A minimal, fully generic showcase topology exercising engine slice 2's core
mechanics: conditional routing driven by a structured verdict, and a
self-correcting fix/review loop bounded by an attempt limit.

## Shape

- `seed` (`set`): writes an initial `findings` value into state — a
  placeholder verdict of `"fail"` with a note explaining there's no review
  yet. Without this, `fix`'s very first activation (before `review` has ever
  run) would have nothing to resolve `{{ findings.notes }}` against.
- `seed -> fix` (plain edge).
- `fix` (`agent`, write-capable — `read_only: false`): its **prompt template**
  reads `{{ findings.notes }}`, so every activation — the first draft and
  every subsequent revision — is addressing the specific feedback `review`
  last gave. It edits `notes.txt` in its run-owned workspace.
- `fix -> review` (plain edge).
- `review` (`agent`, `read_only: true`, `max_attempts: 3`): judges `notes.txt`
  and reports a **declared output schema** — `{ verdict, notes }` — so the
  **parsed object**, not raw text, lands at `findings`. `max_attempts` is
  `review`'s own **attempt bound**: the engine counts each of its
  activations, and three failed attempts halt the run rather than looping
  forever.
- `review -> fix` **when** `findings.verdict` equals `"fail"` (conditional
  routing): loops back for another revision.
- `review -> END` **when** `findings.verdict` equals `"pass"`: the run
  converges.

Each pass through `fix` and back to `review` is one **attempt** — the engine
commits whatever `fix` wrote as exactly one commit on the run's own branch,
labeled with the attempt number, regardless of how many edits `fix` made or
whether it committed anything itself.

## Running it

From a directory `graph-bro` is installed in (see the top-level README for
install/link instructions), inside a git repository:

```sh
graph-bro start ./examples/review-fix-loop/topology.json
# prints a run id and reports the resolved base ref, then returns immediately
```

Check progress and inspect the trace while the run is in flight or after it
finishes:

```sh
graph-bro status <run_id>   # { "runId": ..., "status": "running" | "completed" | "not_converged" | "failed", ... }
graph-bro tail <run_id>     # per-node events, including each routing_decision — the rule evaluated and the value read
graph-bro result <run_id>   # final status, output state, and a per-attempt token/cost breakdown once more than one attempt ran
```

A converged run hands back its work on a run-owned branch, reviewable with
ordinary git — `git log graph-bro/run-<run_id>` shows exactly one commit per
attempt `fix` made, and `git show graph-bro/run-<run_id>:notes.txt` shows the
final revision. Nothing is pushed and no PR is opened; the branch sits in
your repository's own ref store for you to inspect, merge, or discard.

If `review` never passes within its attempt bound, the run halts as
`not_converged` — distinct from `failed` — with every attempt still
committed and reachable for inspection.
