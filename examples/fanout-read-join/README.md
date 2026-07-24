# fanout-read-join

A minimal, fully generic showcase topology exercising the engine's core
mechanics: a runtime-sized fan-out over a read-only reader node, joined with
a `dedup` reducer.

## Shape

- `dispatch` (`set`): writes a runtime list, `batch.items`, into state.
- `dispatch -> reader` (fan-out edge): spawns one `reader` instance per item
  in `batch.items`.
- `reader` (`agent`, `read_only: true`, cheap model `claude-haiku-4-5`): reads
  and reports on its assigned item; never mutates anything.
- `reader -> END` (join edge, `mode: "all"`, `reducer: "dedup"`): waits for
  every fan-out branch, then collapses duplicate outputs into one `results`
  list before the run ends.

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
