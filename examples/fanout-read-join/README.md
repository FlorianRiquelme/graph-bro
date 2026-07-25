# fanout-read-join

A minimal, fully generic showcase topology exercising the engine's core
mechanics: a runtime-sized fan-out over a read-only reader node, joined with
a `dedup` reducer.

## Shape

- `dispatch` (`set`): writes a runtime list, `batch.items`, into state.
- `dispatch -> reader` (fan-out edge): spawns one `reader` instance per item
  in `batch.items`.
- `reader` (`agent`, `read_only: true`, cheap model `claude-haiku-4-5`): its
  `prompt` is a **prompt template** —
  `"Read the item \"{{ item }}\" and report back what you find. Do not modify
  anything."` — whose **interpolation token** `{{ item }}` resolves against
  each branch's own `as` binding. Each fan-out instance therefore runs a
  distinct **resolved prompt** naming its own item, never mutates anything,
  and reports back what it found. A prompt needing the literal delimiters as
  text escapes them: in the topology JSON you write `\\{{ not a token }}`
  (JSON has no `\{` escape, so the backslash must be doubled in the file),
  which the engine sees as `\{{ not a token }}` and renders as the literal
  `{{ not a token }}`.
- `reader -> END` (join edge, `mode: "all"`, `reducer: "dedup"`): waits for
  every fan-out branch, then collapses duplicate outputs into one `results`
  list before the run ends. Since each branch's resolved prompt differs,
  `dedup` here collapses only genuine duplicate reports, not every branch's
  output down to one.

## Running it

From a directory `graph-bro` is installed in (see the top-level README for
install/link instructions):

```sh
graph-bro start ./examples/fanout-read-join/topology.json
# prints a run id, e.g. 5e2a5e2a-...-c0ffee, and returns immediately
```

Check progress and inspect the trace while the run is in flight or after it
finishes:

```sh
graph-bro status <run_id>   # { "runId": ..., "status": "running" | "completed" | "failed", ... }
graph-bro tail <run_id>     # per-node start/complete events, in order
graph-bro result <run_id>   # final status + the run's output state
```

`result` reports the joined, deduplicated output, e.g.:

```json
{
  "runId": "5e2a5e2a-...-c0ffee",
  "status": "completed",
  "output": { "batch": { "items": ["one", "two", "three"] }, "results": ["..."] }
}
```
