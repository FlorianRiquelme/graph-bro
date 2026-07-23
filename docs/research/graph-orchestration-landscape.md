# Graph Orchestration for Agent Workflows — Landscape & Build-From-Scratch Reference

> Research date: 2026-07-23. Scope: graph-based **workflow orchestration** for coding agents
> (nodes, conditional edges, loops, joins, parallel fan-out, human checkpoints) — explicitly NOT
> graph memory, knowledge graphs, or GraphRAG. Reference anchor:
> [athena-graphs](https://github.com/luckeyfaraday/athena-graphs).
>
> **Part I** (§1–6) is the survey: the field's convergent design decisions, lightly edited.
> **Part II** (§7–15) is the implementer's reference: exact data structures, the real control-flow
> loops, quoted source, and pseudocode — enough to hand-roll state channels, reducers, conditional
> edges, loops, parallel fan-out with joins, checkpoint/resume, and human-in-the-loop **without
> re-reading external sources**. **§16** is the dependency-ordered build plan for graph-bro.

## TL;DR

Everyone building this converges on the same ~6 primitives, whether it's LangGraph (37K lines)
or PocketFlow (100 lines):

1. **State** — a shared store / typed channels that nodes read and write
2. **Nodes** — units of work (a function, an LLM call, or a whole CLI agent run)
3. **Edges** — static transitions + conditional routing functions over state
4. **Reducers** — deterministic merge rules for parallel writes (append/sum/merge/overwrite)
5. **Checkpoints** — serialized state after every step; the recovery + human-in-the-loop point
6. **Loop guards** — condition edge on structured output + `max_steps` / recursion limit

The 2026 twist (athena-graphs' class): the node worker is a **headless CLI coding agent**
(`claude -p`, `codex exec`, `opencode run`) instead of an API call, and the graph engine is
exposed as an **MCP server + skill** so the interactive agent designs and drives the graph
conversationally.

**What the deep dives sharpened (Part II):**

- **The runtime is channels + subscribers, not "nodes + edges."** LangGraph's Pregel loop never
  looks at edges; every edge, join, loop-back, and conditional route compiles down to *some node
  writing a channel* and *some node subscribing to that channel*. You need exactly one extra
  channel type (a resettable named barrier) for joins and one reserved channel for dynamic
  fan-out. (§7)
- **A join is not a node kind.** It's a second trigger channel backed by a barrier that opens when
  every named upstream has written since the last reset. athena-graphs and LangGraph independently
  converge on "a join's durable state is just *which predecessors have reported since the last
  reset*." (§7.6, §13.3)
- **Snapshot-per-super-step beats event-sourced replay for CLI-agent nodes.** The node's work is
  an expensive, non-deterministic subprocess; re-running it on every resume (Temporal/Inngest/
  Restate/DBOS style) is exactly what you must avoid. Use LangGraph-style state snapshots as the
  base, and borrow only two ideas from replay engines: idempotency keys for engine-known side
  effects (git push, PR open) and a heartbeat for stuck long-running nodes. (§11)
- **Crash safety is per-task pending writes, not per-super-step checkpoints.** Each task's writes
  are persisted the instant it finishes, keyed by a deterministic task id; on resume, tasks that
  already have recorded writes are skipped. This gives effectively-once node execution across a
  crash mid-super-step. (§8.5)
- **Checkpoints are per-super-step, not per-node — so an interrupted/crashed node re-runs from the
  top of its function on resume.** All side effects before an `interrupt()` must be idempotent.
  This "re-run on resume" is the single most consequential caveat for a from-scratch engine. (§9.4)
- **Termination is "no eligible tasks," full stop** — a version-diff eligibility test makes
  quiescence fall out for free; no separate "all queues empty" check is needed. (§7.3)

---

# Part I — Survey

## 1. The execution model to steal: Pregel / super-steps (LangGraph's core)

LangGraph's runtime is named Pregel after Google's bulk-synchronous parallel graph algorithm.
Per super-step:

1. **Plan** — find eligible nodes (a node activates when a channel it subscribes to was updated)
2. **Execute** — run all eligible nodes in parallel, each on an **isolated copy** of state
   (no node sees another's writes mid-step → no race conditions, no locks)
3. **Reconcile** — apply all updates to shared state in deterministic order via per-key reducers
4. **Checkpoint** — serialize settled state; this is the resume point

Execution terminates when no channel changed in a way any node subscribes to (§7.3 shows this is
literally "`prepare_next_tasks` returned empty" — there is no separate quiescence check). Loops
are just an edge back to a prior node; termination is a conditional edge to `END` plus a recursion
limit.

Key LangGraph API concepts worth mirroring even in a tiny engine:
- **Reducers per state key** (`operator.add` for message lists; `Overwrite` to bypass)
- **`Send` API** — dynamic fan-out / map-reduce: orchestrator spawns N worker nodes at runtime
- **`Command`** — a node return value combining state update + goto (routing decided inside the node)
- **`RemainingSteps`** managed value for graceful degradation near the recursion limit
- Rule of thumb from their docs: per node, pick ONE routing mechanism (static edge XOR
  conditional/Command) — mixing both makes behavior unreasonable. §7.5 shows *why*: all three
  authoring surfaces lower to the same `ChannelWrite` machinery, so mixing them races writers.

Sources:
- LangGraph Graph API docs: https://docs.langchain.com/oss/python/langgraph/graph-api
- "LangGraph Transactions — Pregel, Message Passing and Super-steps" (Max Pilzys):
  https://medium.com/@maksymilian.pilzys/langgraph-transactions-pregel-message-passing-and-super-steps-0e101e620f10
- Workflow patterns catalog (prompt chaining, parallelization, routing, orchestrator-worker,
  evaluator-optimizer): https://langchain-5e9cc07a.mintlify.app/oss/python/langgraph/workflows-agents

## 2. The minimal end: PocketFlow (100 lines, zero deps)

The best "from the ground up" teaching artifact. Core abstractions:

- **Node** = `prep(shared)` → `exec(inputs)` → `post(shared, prep_res, exec_res)`;
  `post` writes results to the shared store and **returns an action string**
- **Flow** = address book mapping `(node, action) → next node`; wiring DSL:
  `decide - "search" >> search`, `search - "decide" >> decide` (loop!)
- **Shared store** = one dict everyone reads/writes
- A `Flow` is itself a `Node` → nested subgraphs for free
- Agent = a Flow with a loop and a branch. That's the whole secret.

What it deliberately lacks (checkpointing, parallel joins, reducers, cycle bounds, structured
error routing, observability) is annotated line-by-line in §13.1 — it's the cautionary baseline.

Sources:
- https://github.com/The-Pocket/PocketFlow
- "LLM Agents are simply Graph — Tutorial For Dummies":
  https://pocketflow.substack.com/p/llm-agent-internal-as-a-graph-tutorial

## 3. First-principles design essay (why graphs, why checkpoints)

"Designing an Agent Runtime from First Principles" (tianpan.co, 2026-02):
https://tianpan.co/blog/2026-02-01-designing-agent-runtime-from-first-principles

- Three problems that kill `while not done: step()`: **latency** (no parallelism),
  **reliability** (no recovery path; side effects replay), **non-determinism** (can't replay
  history — you must checkpoint state snapshots instead)
- Graph > list because it expresses exactly two things a list can't: **parallelism and cycles**
- Checkpoint loading must be **O(1)** in history length (load latest snapshot, never replay events)
- **Human-in-the-loop as a first-class primitive**: checkpoint → signal pause → *terminate the
  process*. Nothing stays alive waiting on a human. Resume from checkpoint is indistinguishable
  from crash recovery. The checkpoint schema IS the human-review interface (enables partial
  state edits, escalation)
- Super-step boundaries are the natural observability/streaming hooks

§11 confirms this essay's verdict against four production replay engines: snapshot-per-super-step
is the right base architecture for expensive non-deterministic (CLI-agent) nodes.

## 4. The new class: CLI coding agents as graph nodes

### athena-graphs (the reference; Python, MCP plugin)
https://github.com/luckeyfaraday/athena-graphs — created 2026-07-18

- Declarative **JSON topology**: node kinds `agent` / `human` / deterministic `set`;
  prompts template prior outputs via `$output_key`
- Edges: fan-out via multiple outgoing; **join** via array `from`; conditions support equality,
  existence, truthiness, containment, nested `all`/`any`/`not` (full grammar in §13.2.5)
- Review loop = `review → __end__ when approved==true`, `review → build when approved==false`
  (reviewer forced to `response: "json"`), plus `max_steps`
- Parallel state conflicts **fail loudly** unless topology declares `append`/`sum`/`merge` reducer
- **MCP control plane**: `graph_start` (detached), `graph_status`, `graph_tail` (cursor),
  `graph_resume` (merge human answers into checkpoint), `graph_result`, `graph_diagram` (Mermaid),
  `graph_validate`. An MCP request never stays open for the run's duration
- Durable runs under `~/.athena-graphs/runs`; backend adapters: `claude -p`, `codex exec`,
  `opencode run`, Grok CLI, raw Anthropic/xAI APIs, mock
- File-safety rule: coding-agent nodes sharing a working dir run **sequentially by default**;
  non-editing/API branches parallelize
- UX: a bundled SKILL.md writes the graph for the user — no DSL in normal use

Its actual runtime (`core.py`, `types.py`, `spec.py`, `checkpoint.py`, `runs.py`) is walked in
§13.2 — it is the single closest reference for graph-bro's target shape.

### agentflow (fuzzland/agentflow; Python DSL)
https://github.com/fuzzland/agentflow

- `with Graph("pipeline", concurrency=3) as g:` … `plan >> impl >> review` operator wiring
- **`fanout(node, items)`** for parallel copies; Jinja templating over results:
  `{{ nodes.plan.output }}`, `{% for r in fanouts.review.nodes %}`
- **Loops**: `success_criteria=[{kind: output_contains, value: "LGTM"}]` +
  `review.on_failure >> write` + `max_iterations=5`
- Scales to 94-node pipelines (plan → 64 workers → batch merges → reviews → synthesis);
  remote execution on SSH/EC2/ECS; ships a skill so Codex/Claude write pipelines themselves

### lindy-orchestrator (Python)
https://github.com/eddieran/lindy-orchestrator

- **Planner / Generator / Evaluator** split: planner emits a `TaskSpec` DAG; generator executes
  in isolated git worktrees; evaluator runs QA gates (ci_check, command_check, structural_check,
  agent_check with 0–100 rubric) and either passes or returns **retry feedback** (the loop)
- Orchestrator owns dependency ordering, worktree isolation, retries, checkpointing, reporting

### sloop (Rust daemon)
https://github.com/hamish-mackie/sloop

- Model: **flows = behavior, tickets = work, projects = scope**; tickets are markdown in-repo
- Stages: `agent` / `exec` / `merge`, each with a **verdict policy** — `commits` (exit 0 + at
  least one commit observed), `exit`, `{check: [cargo, test]}`, or `reported` (worker must call
  `sloop verdict pass|fail` exactly once). Judges outcomes from process exit + tests,
  **never the agent's word**
- Scheduled/background runs within configured hours; per-ticket agent/model/effort

### Maestro-Flow (TypeScript)
https://github.com/zooyoo/Maestro-Flow

- Ground-up rewrite of Claude-Code-Workflow; lesson stated in README: earlier version had
  "too many layers, too many abstractions" → rebuilt as "less ceremony, faster execution"
- Workflows as **markdown definitions**; wave-based parallel execution (independent tasks
  parallel, dependents wait); autonomous **Commander tick loop** (assess → decide → dispatch);
  web Kanban dashboard; MCP delegate tools

### Adjacent (pipeline-with-review-loop, not full graphs)
- **dangeresque** — worker → verify hook → adversarial reviewer in one worktree; human merge gate.
  Notable: containers break MCP/host-binary access + Anthropic policy restricts subscription keys
  in containers → hence **worktree isolation instead of container sandboxing**
- **cclaw** — triage → plan → build → reviewer → adversarial critic; runtime < 1 KLOC,
  behavior lives in prompt content
- **magic-cc-codex-worker** — MCP worker pool (spawn/status/resume/merge/discard), role-based
  sandboxing, worktree per implementer
- **Claude Code's built-in Workflow tool** — Anthropic's own take: deterministic JS scripts with
  `agent()`, `pipeline()`, `parallel()`, phases, budgets, resume-from-journal. Pipeline-oriented
  (no arbitrary cyclic edges), but loops via plain `while` in the script

## 5. Convergent design decisions (the build checklist)

If building one of these from scratch, the field has effectively settled on:

| Decision | Consensus |
|---|---|
| Worker unit | Headless CLI agent subprocess (`claude -p`, `codex exec`) — inherits MCP servers, host binaries, subscription auth. Containers explicitly avoided. |
| State passing | Node output stored under an `output_key`, templated into downstream prompts (`$key` / Jinja) |
| Loop termination | Conditional edge on **structured output** (`approved == true` from a JSON-forced reviewer) + hard `max_steps` guard |
| Trust model | Verify with exit codes / tests / diffs / adversarial reviewer — never the worker's self-report |
| Parallel file edits | Git worktree per node, OR serialize file-editing nodes that share a dir |
| Parallel state writes | Explicit reducers (append/sum/merge); conflict without a reducer = loud failure |
| Durability | Run state on disk, checkpoint per step, O(1) resume; controller process never blocks on the run |
| Human-in-the-loop | A `human` node kind = checkpoint + pause + terminate; resume merges answers into state |
| Control plane | MCP server (start/status/tail/resume/result/diagram/validate) driven from an interactive session |
| Authoring UX | The agent writes the graph (skill/prompt), user speaks intent — no DSL exposed |

## 6. Suggested reading/code order

1. PocketFlow source (100 lines) — internalize Node/Flow/Shared-store + action-string routing (§13.1)
2. tianpan.co essay — why checkpointing and HITL shape the whole architecture (§3)
3. LangGraph Pregel internals — channels, super-steps, versioning (§7); checkpoint model (§8)
4. athena-graphs runtime — the closest reference to graph-bro's shape (§13.2)
5. Control flow + node ops — Send/Command/interrupt (§9), retry/cache/defer/streaming (§10)
6. Durable-execution verdict (§11), pitfalls + tests (§14–15), build order (§16)

---

# Part II — Implementer's Reference

> Sourced primarily from `github.com/langchain-ai/langgraph` `main` (commit `31f90df3` for the
> Pregel runtime), fetched 2026-07-23. Line numbers drift; shapes are stable. Paths are relative
> to `libs/langgraph/langgraph/` unless noted. athena-graphs source fetched from
> `github.com/luckeyfaraday/athena-graphs` `main`. Every non-obvious claim carries its URL.

## 7. LangGraph Pregel runtime internals

### 7.0 The mental model in one paragraph

A compiled graph is not "nodes + edges" at runtime — it's **channels + subscribers**. Every
edge (static or conditional) compiles down to *some node writing to a channel* and *some other
node's `triggers` list containing that channel's name*. The Pregel loop never looks at "edges" at
all; it only asks each super-step "which channels changed version since a node last saw them, and
which nodes are subscribed?" Loops, fan-out, joins, and conditional routing are all expressible
with only that one mechanism plus one extra channel type (`NamedBarrierValue`) for joins and one
extra task kind (`PUSH`, via the reserved `Topic[Send]` channel `__pregel_tasks`) for dynamic
fan-out.

### 7.1 The channels model

All channels implement `BaseChannel` (`channels/base.py:19`). Four methods:

```python
class BaseChannel(Generic[Value, Update, Checkpoint], ABC):
    def get(self) -> Value: ...                        # raises EmptyChannelError if never written
    def update(self, values: Sequence[Update]) -> bool  # called once/step with ALL this step's writes; returns "did it change"
    def from_checkpoint(self, checkpoint) -> Self        # rehydrate from serialized blob
    def consume(self) -> bool: return False   # called when a subscribed task actually ran this step
    def finish(self) -> bool: return False    # called when the run is (tentatively) ending
```

Key invariant on `update()`: *"The order of the updates in the sequence is arbitrary."* Every
channel's `update()` must be **order-independent for a given step** (or explicitly reject >1 write,
like `LastValue`). This is what makes parallel fan-in safe without locks: N node writes to one
channel in one step get collected into a list and handed to `update()` as one batch — the reducer
decides how to fold them, not the executor.

**The eight channel types and their `update()` semantics:**

- **`LastValue`** (`last_value.py:20`) — default for a plain state key (no `Annotated` reducer).
  Stores one value; **raises on >1 concurrent writer**:
  ```python
  def update(self, values):
      if len(values) == 0: return False
      if len(values) != 1:
          raise InvalidUpdateError(  # ErrorCode.INVALID_CONCURRENT_GRAPH_UPDATE
              f"At key '{self.key}': Can receive only one value per step. "
              "Use an Annotated key to handle multiple values.")
      self.value = values[-1]; return True
  ```
  This is the mechanism behind the famous "two parallel nodes wrote to the same key" error — it's
  just `len(values) != 1`. **`LastValueAfterFinish`** (`:81`) is identical but `get()` raises until
  `finish()` fires and `consume()` clears it — used for `defer=True` nodes (§10.3).
- **`EphemeralValue`** (`ephemeral_value.py:15`) — holds a value **for exactly one step**, then
  evaporates. `guard=True` (default) raises on concurrent writers; `guard=False` silently accepts
  any one of several concurrent writes (last-write-wins, no error). This is the channel the
  compiler picks for **every regular node's own trigger channel** (`branch:to:{node}`). An empty
  `update([])` call actively clears the stored value (the "evaporate").
- **`AnyValue`** (`any_value.py:15`) — like `EphemeralValue(guard=False)` but does **not** clear on
  an empty update; stays available across steps. Docstring: *"assumes that if multiple values are
  received, they are all equal"* — for broadcasting a constant from parallel branches.
- **`Topic`** (`topic.py:23`) — pub/sub list, optionally accumulating:
  ```python
  def update(self, values):
      updated = False
      if not self.accumulate:
          updated = bool(self.values); self.values = []   # reset each step unless accumulate=True
      if flat := tuple(_flatten(values)):
          updated = True; self.values.extend(flat)
      return updated
  ```
  `accumulate=False` = scatter channel; `accumulate=True` = pile up across the run
  (`messages`-style logs). The reserved `TASKS` channel is a `Topic[Send]`.
- **`BinaryOperatorAggregate`** (`binop.py:65`) — backs every `Annotated[T, reducer]` key. Seeds
  with `typ()` (`list()`, `0`, `set()`), then folds:
  ```python
  def update(self, values):
      if not values: return False
      if self.value is MISSING: self.value, values = values[0], values[1:]
      for value in values:
          is_overwrite, ov = _get_overwrite(value)
          if is_overwrite: self.value = ov          # bypass the reducer entirely
          else: self.value = self.operator(self.value, value)
      return True
  ```
  Order of `values` = **task dispatch order** (§7.4), not user-controlled — reducers must be
  commutative/associative in practice. `Overwrite(value=...)` (`types.py:938`) lets one writer
  replace the aggregate outright; only one `Overwrite` per channel per step (else `InvalidUpdateError`).
- **`NamedBarrierValue`** (`named_barrier_value.py:13`) — the fan-in join primitive; full source
  in §13.3. Each upstream writes **its own name**; the channel becomes available only once
  `seen == names`; `consume()` resets `seen = set()` so the barrier **re-arms for the next loop
  iteration**. `NamedBarrierValueAfterFinish` gates additionally behind `finish()`.
- **`DeltaChannel`** (`delta.py:25`, beta) — a reducer channel that avoids storing the full folded
  value in every checkpoint. The reducer receives `(state, list_of_writes)`; checkpoints store a
  periodic `_DeltaSnapshot` (every `snapshot_frequency`, default 1000) plus replay
  `checkpoint_writes`. Constraint: the reducer must be **batching-invariant**
  (`reducer(reducer(s, xs), ys) == reducer(s, xs+ys)`). Not load-bearing for a minimal engine, but
  the O(n²)→O(n) storage trick behind it matters for long loops (§14.4).

**Which channel does `compile()` pick?**

| Situation | Channel type |
|---|---|
| Plain state key, no `Annotated` reducer | `LastValue` (one writer/step; error if violated) |
| `Annotated[T, binary_fn]` state key | `BinaryOperatorAggregate` |
| Every regular node's own trigger (`branch:to:{node}`) | `EphemeralValue(Any, guard=False)` (or `LastValueAfterFinish` if `node.defer=True`) |
| Fan-in join (`add_edge([a,b], c)`) | `NamedBarrierValue(str, set(starts))` (or `...AfterFinish` if `c.defer`) |
| `START` pseudo-node's trigger | `START` is a `PregelNode` with `triggers=[START]`; loop seeds it from graph input |
| Dynamic fan-out targets (`Send`) | reserved `TASKS` channel (`Topic[Send]`) |

`guard=False` on the node inbox matters: two conditional branches, or a static edge plus a `goto`,
can legitimately target the same node in one step — a `guard=True` channel would erroneously error.

### 7.2 Channel versioning & `versions_seen` — how "eligible to run" is decided

Every checkpoint carries three parallel maps (`checkpoint/base/__init__.py:92`):

```python
class Checkpoint(TypedDict):
    channel_values: dict[str, Any]              # current value per channel
    channel_versions: ChannelVersions           # channel_name -> monotonic version token
    versions_seen: dict[str, ChannelVersions]    # node_name -> {channel_name -> version last seen}
    # ... (v, id, ts, updated_channels — see §8.2)
```

Version tokens are opaque, monotonically increasing (default an incrementing `int`; checkpointers
may substitute `(major, ts)`). Crucially there is **one shared "current max version" per checkpoint
step** — every channel that changed in a step gets bumped to the *same* `next_version`.

**Eligibility test** (`_algo.py:_triggers`, `:1260`):

```python
def _triggers(channels, versions, seen, null_version, proc) -> bool:
    if seen is None:                       # node has never run — first time
        return any(channels[c].is_available() for c in proc.triggers)
    return any(
        channels[c].is_available()
        and versions.get(c, null_version) > seen.get(c, null_version)
        for c in proc.triggers)
```

A node is eligible next super-step iff **at least one trigger channel is available AND its
`channel_versions` entry is strictly greater than what this node recorded in `versions_seen`**.

**`versions_seen` is stamped BEFORE new writes land**, in `apply_writes` (`_algo.py:262`), for
every task that *ran*, with the versions its triggers had *at read time*:

```python
for task in tasks:
    checkpoint["versions_seen"].setdefault(task.name, {}).update({
        c: checkpoint["channel_versions"][c]
        for c in task.triggers if c in checkpoint["channel_versions"]})
```

Stamping "the version I was triggered by" (not "the version after I ran") is what prevents a node
that reads *and* writes the same channel from infinitely self-triggering. Get this ordering wrong
and harmless loops livelock.

**Fast path** (`prepare_next_tasks`, `_algo.py:475`): instead of scanning every node each step, a
compile-time `trigger_to_nodes: {channel -> [node,...]}` reverse index (`main.py:4175`) plus a
per-loop `updated_channels: set[str]` (the previous step's `apply_writes` return) give candidate
nodes = `∪ trigger_to_nodes[ch] for ch in updated_channels`. Falls back to a full scan only on the
first step or during replay.

### 7.3 The full super-step loop (plan → execute → reconcile → checkpoint)

The sync driver (`main.py:2964`; async twin at `:3437` is structurally identical):

```python
while loop.tick():                                     # PLAN
    for task in loop.match_cached_writes():
        loop.output_writes(task.id, task.writes, cached=True)
    for _ in runner.tick(                               # EXECUTE
        [t for t in loop.tasks.values() if not t.writes],
        timeout=self.step_timeout, get_waiter=get_waiter, schedule_task=loop.accept_push):
        yield from _output(...)                          # stream partial results as tasks finish
    loop.after_tick()                                   # RECONCILE + CHECKPOINT
    emit_graph_lifecycle_events(loop)
    if durability_ == "sync":
        loop._put_checkpoint_fut.result()                # block for durable checkpoint write
```

**PLAN — `PregelLoop.tick()`** (`_loop.py:599`):
```python
def tick(self) -> bool:
    if self.step > self.stop:
        self.status = "out_of_steps"; return False
    self.tasks = prepare_next_tasks(self.checkpoint, self.checkpoint_pending_writes, self.nodes,
        self.channels, self.managed, self.config, self.step, self.stop, for_execution=True,
        trigger_to_nodes=self.trigger_to_nodes, updated_channels=self.updated_channels, ...)
    if not self.tasks:
        self.status = "done"; return False               # <-- TERMINATION CONDITION
    if not self.is_replaying and self.checkpoint_pending_writes:
        self._reapply_writes_to_succeeded_nodes(self.tasks)   # crash-recovery replay (§8.5)
    if self.interrupt_before and should_interrupt(self.checkpoint, self.interrupt_before, self.tasks.values()):
        self.status = "interrupt_before"; raise GraphInterrupt()
    return True
```

**The run terminates exactly when `prepare_next_tasks` returns empty** — no channel changed version
in a way any node subscribes to. There is **no separate "all nodes inactive AND no messages in
flight" check** to implement: a super-step with zero writes produces zero version bumps, so the
§7.2 walk finds nothing next step, for free.

**EXECUTE — `PregelRunner.tick()`** (`_runner.py:176`): submits every ready task to a thread-pool
executor. Each task reads from the **same frozen pre-step channel snapshot** but writes only into
its own private `deque` (injected as `CONFIG_KEY_SEND: writes.extend`). Tasks never see each
other's writes mid-step. The loop is `concurrent.futures.wait(..., return_when=FIRST_COMPLETED)` so
results stream as tasks finish; `_should_stop_others` cancels remaining futures on an unhandled
exception (fail-fast unless a per-node error handler is registered).

**RECONCILE — `PregelLoop.after_tick()`** (`_loop.py:683`):
```python
def after_tick(self):
    writes = [w for t in self.tasks.values() for w in t.writes]
    self.updated_channels = apply_writes(self.checkpoint, self.channels, self.tasks.values(),
        self.checkpointer_get_next_version, self.trigger_to_nodes)
    if not self.updated_channels.isdisjoint(self.output_keys):
        self._emit("values", map_output_values, ...)
    self.checkpoint_pending_writes.clear()
    self._put_checkpoint({"source": "loop"})             # <-- CHECKPOINT HAPPENS HERE
    if self.interrupt_after and should_interrupt(...):
        raise GraphInterrupt()
```

**CHECKPOINT — `_put_checkpoint`** (`_loop.py:1081`): builds a fresh `Checkpoint`, submits the
write to the checkpointer asynchronously (chained on the previous checkpoint future so writes land
in order), then increments `self.step`. `durability` (`"sync"|"async"|"exit"`) controls whether the
driver blocks on that future (§10.8). **Checkpointing is once per super-step, after reconcile,
before the next plan** — never per-node, never per-message. Each checkpoint is a complete,
self-sufficient snapshot; resume loads exactly one row and re-enters `tick()` — O(1) in history.

### 7.4 Deterministic write-application order (`apply_writes`, `_algo.py:232`)

This is where determinism is enforced despite genuinely parallel thread-pool execution:

```python
def apply_writes(checkpoint, channels, tasks, get_next_version, trigger_to_nodes) -> set[str]:
    tasks = sorted(tasks, key=lambda t: task_path_str(t.path[:3]))   # 1. deterministic order
    bump_step = any(t.triggers for t in tasks)

    for task in tasks:                                                # 2. stamp versions_seen (§7.2)
        checkpoint["versions_seen"].setdefault(task.name, {}).update({...})

    next_version = get_next_version(max(checkpoint["channel_versions"].values(), default=None), None)  # 3. ONE shared version

    for chan in {c for t in tasks for c in t.triggers if c in channels}:  # 4. consume() read channels
        if channels[chan].consume() and next_version is not None:
            checkpoint["channel_versions"][chan] = next_version

    pending = defaultdict(list)                                       # 5. group writes BY CHANNEL
    for task in tasks:
        for chan, val in task.writes:
            if chan in channels: pending[chan].append(val)

    updated = set()
    for chan, vals in pending.items():                               # 6. ONE update() per channel
        if channels[chan].update(vals) and next_version is not None:
            checkpoint["channel_versions"][chan] = next_version
            if channels[chan].is_available(): updated.add(chan)

    if bump_step:                                                    # 7. empty-update broadcast
        for chan in channels:
            if channels[chan].is_available() and chan not in updated:
                if channels[chan].update(EMPTY_SEQ) and next_version is not None:
                    checkpoint["channel_versions"][chan] = next_version
                    if channels[chan].is_available(): updated.add(chan)

    if bump_step and updated.isdisjoint(trigger_to_nodes):           # 8. finish() if this was the last step
        for chan in channels:
            if channels[chan].finish() and next_version is not None:
                checkpoint["channel_versions"][chan] = next_version
                if channels[chan].is_available(): updated.add(chan)
    return updated
```

Two subtleties to steal directly:
- **Sort key is `t.path[:3]`** (encodes `(PUSH|PULL, name-or-idx, ...)` from the *plan* phase),
  not task id or arrival order. Re-running the identical plan against identical inputs always
  reconciles writes in identical order, even though N threads finished in unpredictable wall-clock
  order. **This, not thread scheduling, is what makes replay reproducible.**
- **Step 7's empty-update broadcast** is how `EphemeralValue` channels know to clear and how
  finished-but-idle channels stop re-triggering. Every channel gets an `update([])` once a step has
  real work; each type decides for itself (persist vs reset).

### 7.5 PUSH vs PULL tasks — how `Send` compiles to dynamic fan-out

`prepare_next_tasks` builds **two disjoint task families** every step:

1. **PUSH tasks** — one per pending entry in the reserved `TASKS` channel (`__pregel_tasks`, a
   non-accumulating `Topic[Send]`). Any writer enqueues a `Send(node, arg)`. Pending sends are
   drained by **index**, so `Send`s written in step N execute as PUSH tasks in **step N+1** — one
   super-step of latency by design (it lets the sender's own writes settle first).
2. **PULL tasks** — one per candidate node (via `trigger_to_nodes`) that passes `_triggers(...)`.

Each `Send` gets a deterministic task id from `(checkpoint_id, node_name, step, PUSH, idx)`
(`_algo.py:938`), so N parallel `Send("worker", item)` produce N independent tasks, each with its
own write-`deque`. Fan-out = "one node emits many `Send`s"; the join back is either the implicit
super-step barrier (all PUSH tasks finish before next step's PULL tasks) or an explicit
`NamedBarrierValue`.

**`Command(goto=...)` compiles to writes on a control channel.** `attach_node` appends a second
writer entry `ChannelWriteTupleEntry(mapper=_control_branch, ...)` (`state.py:1486`) that turns a
returned `Command.goto` into the same `branch:to:{dest}` (or `TASKS`) writes a static edge or
conditional branch would produce. **This is why "pick ONE routing mechanism per node" is
mechanical, not stylistic:** static edges, conditional branches, and `Command.goto` are three
authoring surfaces that all lower to the same `ChannelWrite` machinery — mixing them just fires
multiple writers in one step, racing to write conflicting destinations.

### 7.6 Compile-down: StateGraph → Pregel channels & triggers

`graph/state.py`'s `CompiledStateGraph` has exactly three attach methods — the entire compiler.

**`attach_node` (`:1431`)** — one node ⇒ one trigger channel + one writer:
```python
branch_channel = _CHANNEL_BRANCH_TO.format(key)          # "branch:to:{node_name}"
self.channels[branch_channel] = (
    LastValueAfterFinish(Any) if node.defer else EphemeralValue(Any, guard=False))
self.nodes[key] = PregelNode(
    triggers=[branch_channel],                             # subscribes to its OWN inbox channel
    channels=("__root__" if is_single_input else input_channels),  # what state keys it READS
    mapper=mapper, writers=[ChannelWrite(write_entries)], ...)
```
Every node, regardless of how many edges point at it, has **exactly one** inbound trigger channel.
Fan-in is handled by having all sources write to that same `EphemeralValue(guard=False)`.

**`attach_edge` (`:1537`)** — static edges, and the fan-in join channel:
```python
def attach_edge(self, starts, end):
    if isinstance(starts, str):                            # simple 1:1 edge
        if end != END:
            self.nodes[starts].writers.append(
                ChannelWrite((ChannelWriteEntry(_CHANNEL_BRANCH_TO.format(end), None),)))
    elif end != END:                                       # add_edge([a,b,c], end) == fan-in JOIN
        channel_name = f"join:{'+'.join(starts)}:{end}"
        self.channels[channel_name] = (
            NamedBarrierValueAfterFinish(str, set(starts)) if self.builder.nodes[end].defer
            else NamedBarrierValue(str, set(starts)))
        self.nodes[end].triggers.append(channel_name)      # end ADDITIONALLY waits on the barrier
        for start in starts:
            self.nodes[start].writers.append(
                ChannelWrite((ChannelWriteEntry(channel_name, start),)))  # each writes ITS OWN NAME
```
**A join is not a node type — it's a second trigger channel added to the joined node's `triggers`,
fed by every upstream writing its own name into a `NamedBarrierValue`.**

**`attach_branch` (`:1563`)** — conditional edges become a runtime writer, not a compile-time
shape:
```python
def attach_branch(self, start, name, branch, *, with_reader=True):
    def get_writes(packets, static=False):
        return [ChannelWriteEntry(p if p == END else _CHANNEL_BRANCH_TO.format(p), None)
                if not isinstance(p, Send) else p
                for p in packets if (True if static else p != END)]
    reader = partial(ChannelRead.do_read, select=channels, fresh=True, mapper=mapper) if with_reader else None
    self.nodes[start].writers.append(branch.run(get_writes, reader))
```
`branch.run(...)` wraps the user's `path(state) -> Hashable | Send | list` function and **appends
it to the source node's `writers` list** — a conditional edge is one more writer that runs after
the node body, resolves each result through `path_map`, and calls `ChannelWrite.do_write(...)`.
**Conditional routing has zero footprint on `channel_versions`/`triggers` at compile time — the
destination is only known, and only written, at run time, per step.**

### 7.7 Input/output & interrupt mechanics

- **Graph input** enters as writes from a synthetic `NULL_TASK_ID` task (`_loop.py:_first`, `:848`)
  applied via the same `apply_writes`. It writes the `START` channel; `START` is a `PregelNode`
  fanning the input dict to each top-level state key. So the first super-step's PULL-eligible set
  is just whatever nodes `add_edge(START, ...)` wired.
- **Output channels** default to every non-managed key in `output_schema` (or bare `"__root__"`).
  `stream_channels` (for `stream_mode="values"`) spans ALL channels, which is why streaming can
  surface intermediate keys the declared `OutputT` doesn't. Output emit is a version check, not a
  value diff: `after_tick` emits only if `updated_channels ∩ output_keys` (`_loop.py:700`).
- **`should_interrupt`** (`_algo.py:155`) reuses the §7.2 version machinery under a fake node named
  `__interrupt__`, so `interrupt_before`/`after` don't fire twice on the same settled state:
  ```python
  def should_interrupt(checkpoint, interrupt_nodes, tasks):
      seen = checkpoint["versions_seen"].get(INTERRUPT, {})
      any_changed = any(v > seen.get(c, null_version) for c, v in checkpoint["channel_versions"].items())
      return [t for t in tasks if (...matches interrupt_nodes...)] if any_changed else []
  ```
  `GraphInterrupt` is *raised* from inside `tick()`/`after_tick()`; the process unwinds via
  exception. Because the checkpoint was already durably written, **resuming is "load that
  checkpoint, call `tick()` again" — structurally identical to crash recovery.**

### 7.8 Gotchas for a hand-rolled implementer

1. **A node's own trigger channel must be `guard=False`** — else two conditional branches (or a
   static edge + a `goto`) targeting one node in one step break it. Default the per-node inbox to
   silently accept N writers, keep last/first.
2. **Reducers see writes in "task sort order," not completion order.** Buffer writes per-task and
   apply them in a deterministic order derived from the *plan*, or replay diverges.
3. **`versions_seen` is stamped at TRIGGER time, before the step's writes land** — else a
   read+write-same-channel node self-triggers forever.
4. **Termination is "no eligible tasks," full stop — no separate quiescence check.**
5. **`Send`/dynamic fan-out executes one super-step later** than the write that created it. If you
   execute `Send` synchronously inline instead, call it out as a semantics deviation.
6. **A join is "one more trigger channel + a barrier channel type,"** not a distinct node kind.
7. **Mixing static/conditional/`Command.goto` on one node all lower to independent writers** on the
   same node's `writers` list — a footgun baked into compile-down (the "pick one" rule).
8. **Checkpointing is per-super-step, not per-node.** For cheaper durability use
   `durability="async"|"exit"`, not a per-node checkpoint call.

**Primary source index** (commit `31f90df3`): `BaseChannel` `channels/base.py:19`; `LastValue`
`channels/last_value.py:20,:81`; `EphemeralValue` `channels/ephemeral_value.py:15`; `AnyValue`
`channels/any_value.py:15`; `Topic` `channels/topic.py:23`; `BinaryOperatorAggregate`
`channels/binop.py:65`; `NamedBarrierValue` `channels/named_barrier_value.py:13,:84`; `DeltaChannel`
`channels/delta.py:25`; `apply_writes` `pregel/_algo.py:232`; `prepare_next_tasks/prepare_single_task`
`pregel/_algo.py:392,:524`; `_triggers` `pregel/_algo.py:1260`; `should_interrupt` `pregel/_algo.py:155`;
`PregelLoop.tick/after_tick` `pregel/_loop.py:599,:683`; `_put_checkpoint` `pregel/_loop.py:1081`;
`_first` `pregel/_loop.py:848`; `PregelRunner.tick` `pregel/_runner.py:176`; `ChannelWrite`
`pregel/_write.py:26,:46`; `BranchSpec` `graph/_branch.py:83`; `attach_node/edge/branch`
`graph/state.py:1431,:1537,:1563`; `_trigger_to_nodes` `pregel/main.py:4175`; main driver
`pregel/main.py:2964`.

## 8. Checkpoint & persistence data model

Sourced from `libs/checkpoint/…` and `libs/checkpoint-{sqlite,postgres}/…` on `main`.

### 8.1 `BaseCheckpointSaver` — the interface to implement

Source: `libs/checkpoint/langgraph/checkpoint/base/__init__.py`. Five methods form the contract
(each with an `a`-prefixed async twin):

```python
class BaseCheckpointSaver(Generic[V]):
    serde: SerializerProtocol = JsonPlusSerializer()
    def get_tuple(self, config) -> CheckpointTuple | None: ...
    def list(self, config, *, filter=None, before=None, limit=None) -> Iterator[CheckpointTuple]: ...
    def put(self, config, checkpoint, metadata, new_versions) -> RunnableConfig: ...
    def put_writes(self, config, writes: Sequence[tuple[str, Any]], task_id: str, task_path: str = "") -> None: ...
    def get_next_version(self, current: V | None, channel: None) -> V: ...  # default: int + 1
```

- **`config` is the addressing key, not a parameter bag.** Its `configurable` dict carries
  `thread_id` (required), `checkpoint_ns` (default `""`), optionally `checkpoint_id` (omit →
  "latest"). `put()`/`put_writes()` return/imply an updated config so callers chain without
  re-deriving the address.
- `get_next_version` must be monotonically increasing `str|int|float`. `SqliteSaver` overrides to
  `"{int:032}.{random_float:016}"` — padded int gives lexical=numeric ordering, the random suffix
  gives lock-free concurrent-writer tie-breaking.
- `list()` powers both thread-history browsing *and* (via `before` config) the parent-chain walk.
- Housekeeping methods (`delete_thread`, `copy_thread`, `prune`) default to `NotImplementedError`.
  Gotcha: naive `prune(keep_latest)` can silently reconstruct a `DeltaChannel` as **empty** if it
  deletes the ancestor holding the last full snapshot — with no error. Snapshot lineage must
  survive pruning.

Source: https://github.com/langchain-ai/langgraph/blob/main/libs/checkpoint/langgraph/checkpoint/base/__init__.py

### 8.2 The `Checkpoint` TypedDict

```python
ChannelVersions = dict[str, str | int | float]
PendingWrite = tuple[str, str, Any]   # (task_id, channel, value)

class Checkpoint(TypedDict):
    v: int                                    # format version (see §8.7 gotcha)
    id: str                                    # UUID6 — monotonically increasing, sortable
    ts: str                                    # ISO 8601
    channel_values: dict[str, Any]              # channel -> deserialized snapshot value = the "shared store"
    channel_versions: ChannelVersions            # channel -> monotonic version
    versions_seen: dict[str, ChannelVersions]     # node -> {channel: version last consumed}
    updated_channels: list[str] | None
```

- `channel_values` + `channel_versions` + `versions_seen` together *are* the Pregel activation
  state — no scheduler graph search needed on resume (§7.2).
- **There is no `pending_sends` field anymore** — it was folded into the reserved `TASKS` channel
  inside `channel_values`. `copy/empty/create_checkpoint()` still read `checkpoint.get("pending_sends", [])`
  for old blobs; the Postgres saver has a migration path (§8.7).
- `id` is a **UUID6** (time-ordered), so `ORDER BY checkpoint_id DESC` == `ORDER BY ts DESC` with no
  extra index. A monotonic-clock guard forces strictly increasing timestamps
  (`checkpoint/base/id.py`) — steal this for sortable-by-creation IDs without a DB auto-increment.

### 8.3 `CheckpointMetadata` and `CheckpointTuple`

```python
class CheckpointMetadata(TypedDict, total=False):
    source: Literal["input", "loop", "update", "fork"]
    step: int          # -1 initial input, 0 first loop, then n
    parents: dict[str, str]   # checkpoint_ns -> checkpoint_id, for ancestor namespaces
    run_id: str

class CheckpointTuple(NamedTuple):
    config: RunnableConfig
    checkpoint: Checkpoint
    metadata: CheckpointMetadata
    parent_config: RunnableConfig | None = None
    pending_writes: list[PendingWrite] | None = None   # writes belonging to the NEXT super-step (§8.5)
```

`source` is a verbatim-copyable audit field: `"input"` (initial invoke, step -1), `"loop"` (normal
super-step), `"update"` (manual `update_state`), `"fork"` (pure copy = time-travel branch point).
`parent_config` makes the history a **tree, not a list** — replaying from an old checkpoint forks a
sibling timeline, never destroying the original.

### 8.4 Addressing & subgraph namespace nesting

Three `configurable` keys form the full address: `thread_id` (partition key), `checkpoint_ns` (`""`
for root), `checkpoint_id` (omit → latest). Subgraph namespaces nest with two reserved separators:

```python
NS_SEP = sys.intern("|")   # levels: graph|subgraph|subsubgraph
NS_END = sys.intern(":")   # separates namespace from a trailing task_id
```

Construction (`_algo.py`, repeated for PULL/PUSH/error-handler tasks):
```python
checkpoint_ns = f"{parent_ns}{NS_SEP}{name}" if parent_ns else name
task_id = task_id_func(checkpoint_id_bytes, checkpoint_ns, str(step), name, PULL, *triggers)
task_checkpoint_ns = f"{checkpoint_ns}{NS_END}{task_id}"
```

The parent config carries `CONFIG_KEY_CHECKPOINT_MAP = {namespace: checkpoint_id}` accumulated as
you descend; it becomes `CheckpointMetadata["parents"]` when the child namespace's checkpoint is
written. **This is the whole subgraph-nesting trick:** a subgraph checkpoint records exactly which
checkpoint of each ancestor namespace was active — a coherent cross-namespace snapshot without a
global lock-step counter.

**Task IDs are deterministic `xxh3_128` hashes** of
`(checkpoint_id, checkpoint_ns, step, node_name, PULL|PUSH, *triggers)` — same inputs → same
`task_id` on every replay. This determinism underlies three features: crash-safe exactly-once
execution (§8.5), `update_state` attribution (§8.6), and writes-based history reconstruction.

### 8.5 Pending writes & crash semantics — the load-bearing design

A super-step runs N tasks in parallel; if the process dies after 3 of 5 finish, you must not lose
the 3 or double-apply their side effects. LangGraph's answer: **persist each task's writes the
instant that task finishes — individually, keyed by the PRECEDING checkpoint id — well before the
other tasks finish or the new merged checkpoint is written.**

`PregelRunner.commit()` (`_runner.py`), called once per finished task:
```python
def commit(self, task, exception):
    if isinstance(exception, asyncio.CancelledError):
        task.writes.append((ERROR, exception)); self.put_writes()(task.id, task.writes)
    elif exception:
        if isinstance(exception, GraphInterrupt): ...; self.put_writes()(task.id, writes)
        elif isinstance(exception, GraphBubbleUp): pass          # re-raised elsewhere
        else: task.writes.append((ERROR, exception)); self.put_writes()(task.id, task.writes)
    else:
        if not task.writes: task.writes.append((NO_WRITES, None))
        self.put_writes()(task.id, task.writes)                   # success path
```

`put_writes` (`_loop.py:415`) anchors the write to the still-current (pre-super-step) checkpoint id
and hands off to `checkpointer.put_writes()` **asynchronously**, without blocking the runner.

On the next `tick()` (fresh process after a crash, or just the next call), the loop reads back
pending writes and **short-circuits re-execution** for tasks that already have recorded writes:
```python
def _reapply_writes_to_succeeded_nodes(self, tasks):
    for tid, k, v in self.checkpoint_pending_writes:
        if k in (ERROR, ERROR_SOURCE_NODE, INTERRUPT, RESUME): continue   # failed/interrupted → re-run
        if task := tasks.get(tid): task.writes.append((k, v))
```
The runner only invokes a node's function where `not task.writes` — so a task whose id already has
rows comes back non-empty and is treated as done. **This is effectively-once semantics for node
side effects across crash-restart**, built entirely from durable per-task write rows keyed by a
deterministic task id.

Sequencing: **pending writes (durable, per-task, fine) → reconcile via reducers → new Checkpoint
(durable, per-super-step, coarse) → clear pending writes.** A crash before the final
`_put_checkpoint` loses at most in-flight tasks, which just re-run.

`WRITES_IDX_MAP = {ERROR: -1, SCHEDULED: -2, INTERRUPT: -3, RESUME: -4}` gives control-signal writes
negative indices so they can't collide with real channel writes in the `(task_id, idx)` primary
key. Both savers upsert (`INSERT OR REPLACE`) when all writes are control types, else
`INSERT OR IGNORE` for regular channel writes (first write for a `(task_id, idx)` wins — idempotent
re-delivery).

**`durability` gates only the coarse checkpoint**, never pending writes (always durable — they're
cheap and are the actual crash-safety net). Even in async mode, same-thread checkpoints chain off
`self._put_checkpoint_fut` so they land in order.

### 8.6 Time travel: `update_state`, `get_state_history`, forking

- `get_state_history()` = `checkpointer.list(config, before=..., limit=...)` wrapped into
  `StateSnapshot`s — **no replay**, just listing full snapshots newest-first (O(1) each).
- `get_state(config, checkpoint_id=X)` loads exactly checkpoint X; re-invoking from it proceeds
  forward **as a new branch** (`parent_config` points at the old node), forking a sibling timeline.
- `update_state(config, values, as_node=None)` → `bulk_update_state.perform_superstep`:
  1. Load + `copy_checkpoint()` the target.
  2. Resolve `as_node` if omitted ("last node that updated state, if unambiguous" via `versions_seen`;
     `InvalidUpdateError` if ambiguous).
  3. **Actually invoke that node's writer/reducer chain** with `values` — updates go through the
     same reducers a real write would, not a raw dict merge.
  4. Reuse the **deterministic task_id** the node would have gotten.
  5. `put_writes(...)` against the old checkpoint (like a real `commit()`).
  6. `apply_writes(...)`, then `put(...)` a new checkpoint with `{"source": "update", "step": step+1}`.
- A **pure fork** (`as_node == "__copy__"`) skips step 3 and just `put()`s an unmodified copy,
  `parent_config`-linked, `"source": "fork"`. This is the literal "branch the timeline" primitive.

### 8.7 The serializer: `JsonPlusSerializer`

Source: `.../checkpoint/serde/jsonplus.py`. Stores `(type_tag, bytes)` pairs:
```python
def dumps_typed(self, obj):
    if obj is None: return "null", b""
    elif isinstance(obj, bytes): return "bytes", obj
    elif isinstance(obj, bytearray): return "bytearray", obj
    else:
        try: return "msgpack", _msgpack_enc(obj)   # ormsgpack.packb(obj, default=_msgpack_default)
        except ormsgpack.MsgpackEncodeError:
            if self.pickle_fallback: return "pickle", pickle.dumps(obj)
            raise
```

msgpack extension type codes (payload is itself recursively msgpack-encoded → extensions nest):

| Code | Meaning | Types |
|---|---|---|
| 0 | `cls(single_arg)` | UUID, Decimal, set/frozenset/deque, IP types, ZoneInfo, Enum, SecretStr |
| 1 | `cls(*args)` | Path, re.Pattern, timedelta/date, timezone, **Send** |
| 2 | `cls(**kwargs)` | namedtuples, dataclasses, time, store `Item` |
| 3 | `cls.method(arg)` | datetime → `fromisoformat` |
| 4 | pydantic v1 | `.dict()` w/ `.construct()` fallback |
| 5 | pydantic v2 | `.model_dump()` w/ `.model_construct()` fallback |
| 6 | numpy array | `np.frombuffer(...).reshape(...)`, memoryview avoids a copy |
| 7 | `_DeltaSnapshot` | beta delta-channel marker |

Duck-typing (`is_dataclass`, `hasattr(obj, "model_dump")`, `hasattr(obj, "_asdict")`) is checked
before the `TypeError` catch-all, so custom types round-trip free. Exceptions serialize as
`repr(obj)` (for observability, not faithful reconstruction).

**Security model — copy this verbatim into any hand-rolled serializer.** Deserializing an extension
does `importlib.import_module(module)` + `getattr` + call — **arbitrary import + constructor-call
driven by attacker strings** unless gated:
- `LANGGRAPH_STRICT_MSGPACK=true` (or `allowed_msgpack_modules=[...]`) restricts to a fixed
  `SAFE_MSGPACK_TYPES` allowlist; anything else returns raw payload + a one-time warning.
- Default (permissive) allows anything with a deprecation warning (migrating toward strict-by-default).
- Method-call dispatch is additionally restricted to `SAFE_MSGPACK_METHODS` after CVE `GHSA-fjqc-hq36-qh5p`.
- **Lesson: ship a closed allowlist by default; make "allow everything" an explicit opt-in.**

### 8.8 Storage DDL: SQLite (2 tables) vs Postgres (4 tables)

**SQLite** — checkpoint stored as one opaque blob:
```sql
PRAGMA journal_mode=WAL;
CREATE TABLE checkpoints (
  thread_id TEXT NOT NULL, checkpoint_ns TEXT NOT NULL DEFAULT '', checkpoint_id TEXT NOT NULL,
  parent_checkpoint_id TEXT, type TEXT, checkpoint BLOB, metadata BLOB,
  PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id));
CREATE TABLE writes (
  thread_id TEXT NOT NULL, checkpoint_ns TEXT NOT NULL DEFAULT '', checkpoint_id TEXT NOT NULL,
  task_id TEXT NOT NULL, idx INTEGER NOT NULL, channel TEXT NOT NULL, type TEXT, value BLOB,
  PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx));
```
Whole `Checkpoint` (all `channel_values`) is one blob per row — simple, but every `put()`
re-serializes the entire state. `SqliteSaver` is sync-only, not thread-scalable (demos);
`AsyncSqliteSaver` is the real one.

**Postgres** — metadata as JSONB, big values externalized:
```sql
CREATE TABLE checkpoint_migrations (v INTEGER PRIMARY KEY);
CREATE TABLE checkpoints (
  thread_id TEXT NOT NULL, checkpoint_ns TEXT NOT NULL DEFAULT '', checkpoint_id TEXT NOT NULL,
  parent_checkpoint_id TEXT, type TEXT, checkpoint JSONB NOT NULL, metadata JSONB NOT NULL DEFAULT '{}',
  PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id));
CREATE TABLE checkpoint_blobs (
  thread_id TEXT NOT NULL, checkpoint_ns TEXT NOT NULL DEFAULT '', channel TEXT NOT NULL,
  version TEXT NOT NULL, type TEXT NOT NULL, blob BYTEA,
  PRIMARY KEY (thread_id, checkpoint_ns, channel, version));
CREATE TABLE checkpoint_writes (
  thread_id TEXT NOT NULL, checkpoint_ns TEXT NOT NULL DEFAULT '', checkpoint_id TEXT NOT NULL,
  task_id TEXT NOT NULL, idx INTEGER NOT NULL, channel TEXT NOT NULL, type TEXT, blob BYTEA NOT NULL,
  task_path TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx));
```

Minimal migration runner (`MIGRATIONS` = ordered DDL list; apply only the tail):
```python
row = cur.execute("SELECT v FROM checkpoint_migrations ORDER BY v DESC LIMIT 1").fetchone()
version = row["v"] if row else -1
for v, migration in zip(range(version+1, len(MIGRATIONS)), MIGRATIONS[version+1:]):
    cur.execute(migration); cur.execute("INSERT INTO checkpoint_migrations (v) VALUES (%s)", (v,))
```

**Key trick: inline-vs-blob split.** On `put()`, primitive channel values (`None/str/int/float/bool`)
stay inlined in the `checkpoints.checkpoint` JSONB; everything else is popped into `checkpoint_blobs`
keyed by `(thread_id, checkpoint_ns, channel, version)` — **content-addressed by channel version, so
unchanged channels across successive checkpoints share the same blob row** (no rewrite). A 1000-step
run where one small channel changes each step does not rewrite the other channels' bytes every step.
Steal this even without JSONB: keep scalars inline, store larger values under a `(channel, version)`
content-address that's naturally append-only.

### 8.9 `BaseStore` — cross-thread memory (a separate abstraction)

Checkpoints are scoped to `thread_id`. `BaseStore` is the *other* half: persistent,
hierarchically-namespaced KV memory shared across threads (long-term memory), semantically distinct
from "this run's replay log." Everything is one batched op:
```python
class BaseStore(ABC):
    supports_ttl: bool = False
    @abstractmethod
    def batch(self, ops: Iterable[Op]) -> list[Result]: ...
    def get(self, ns, key, *, refresh_ttl=None): return self.batch([GetOp(ns, str(key), ...)])[0]
    def put(self, ns, key, value, index=None, *, ttl=NOT_PROVIDED): self.batch([PutOp(ns, str(key), value, ...)])
    def delete(self, ns, key): self.batch([PutOp(ns, str(key), None, ttl=None)])   # value=None IS the delete
    def search(self, ns_prefix, /, *, query=None, filter=None, limit=10, ...): ...
    def list_namespaces(self, *, prefix=None, suffix=None, max_depth=None, ...): ...
```
Four `Op` types (`GetOp`, `SearchOp`, `PutOp`, `ListNamespacesOp`); **delete is `PutOp` with
`value=None`**. `namespace` is always `tuple[str, ...]`. Semantic search / TTL are opt-in and *not*
required by the base contract. **Steal the `batch()`-only pattern**: get/put/search/delete fall out
as 1-op batches, and a store backed by one DB round-trip, a Redis pipeline, or an in-memory dict all
implement exactly one method.

Source: https://github.com/langchain-ai/langgraph/blob/main/libs/checkpoint/langgraph/store/base/__init__.py

### 8.7-gotchas Cross-cutting lessons

1. **Stamp a schema version on every checkpoint row**, not just a global counter, and write per-row
   migration logic. Postgres branches on `checkpoint["v"] < 4` to run `_migrate_pending_sends`
   (reconstructing the old `pending_sends` field from `TASKS`-channel write rows). You *will* change
   your checkpoint shape at least once; old rows must keep deserializing.
2. **Deterministic task IDs underlie three features** (§8.5 crash-safety, §8.6 update attribution,
   delta history reconstruction) — get the hash right early.
3. **Don't conflate two history walks:** `list(before=)` = all checkpoints newest-first (browsing,
   audit, forks included); the **parent chain** (`parent_config` one hop at a time) = only the
   lineage leading to a specific checkpoint (replay/fork). A prune strategy reasoning only about
   `list()` order can break parent-chain reconstruction for a live thread.
4. **Coarse checkpoints and fine pending writes have different durability knobs on purpose** (§8.5).

Full citations: base `.../checkpoint/base/__init__.py`; ids `.../base/id.py`; serializer
`.../serde/jsonplus.py`; reserved names `.../serde/types.py`; SQLite `.../checkpoint-sqlite/…`;
Postgres `.../checkpoint-postgres/…/base.py`; store `.../store/base/__init__.py`; constants
`.../_internal/_constants.py`; scheduling `pregel/_algo.py`; loop lifecycle `pregel/_loop.py`;
per-task commit `pregel/_runner.py`; time-travel `pregel/main.py`.

## 9. Control flow: Send / Command / interrupt / subgraphs / recursion

Sourced from `types.py`, `errors.py`, `pregel/_algo.py`, `pregel/_loop.py`, `_internal/_constants.py`.

### 9.1 Sentinels

```python
START = sys.intern("__start__")   # virtual first node — add_edge(START,"n") ⇒ n eligible on step 0
END   = sys.intern("__end__")     # add_edge("n",END) ⇒ writes a terminating channel
INPUT = "__input__"; INTERRUPT = "__interrupt__"; RESUME = "__resume__"
PUSH = "__pregel_push"   # task from a Send;  PULL = "__pregel_pull"   # task from an edge
NS_SEP = "|"; NS_END = ":"
```
`START`/`END` are just interned strings used as node names — no special object identity. Every task
is `(kind, path)` with `kind ∈ {PUSH, PULL}`.

Sources: https://github.com/langchain-ai/langgraph/blob/main/libs/langgraph/langgraph/constants.py ,
`.../_internal/_constants.py`

### 9.2 Conditional edges vs `Command`

**Conditional edges** (declarative, compiled into a writer per §7.6):
```python
graph.add_conditional_edges("node_a", route_fn, ["node_b", "node_c"])
# route_fn(state) -> str | list[str] | Send | list[Send]
```
Routing is data: topology is static, but which channel gets written is decided at runtime.

**`Command`** (imperative, from inside the node body):
```python
@dataclass(**_DC_KWARGS)
class Command(Generic[N], ToolOutputMixin):
    graph: str | None = None
    update: Any | None = None
    resume: dict[str, Any] | Any | None = None
    goto: Send | Sequence[Send | N] | N = ()
    PARENT: ClassVar[Literal["__parent__"]] = "__parent__"
```
Returning `Command(update=..., goto=...)` does in one step what node + conditional edge does in two:
`update` goes through the normal reducer path (`_update_as_tuples()` turns a dict / list of
`(key,value)` / `Annotated`-keyed object into channel writes, `__root__` if unrecognized); `goto`
becomes `Send`/PULL writes.

**`graph=Command.PARENT`** (inside a subgraph node) redirects the `goto` write into the *parent*
graph's namespace ("navigate to the closest parent graph relative to the subgraph"). Corollary:
because the write crosses a checkpoint-namespace boundary, the **parent** state key must define its
own reducer if you want the value merged rather than clobbered — the write goes through the parent
channel's reducer, not the subgraph's.

Rule of thumb, verbatim from the docs: pick **one** routing mechanism per node — static edge XOR
conditional/`Command`. The docs' `Command` examples never mix them ("NOTE: there are no edges
between nodes A, B and C!"). §7.5 shows the mechanical reason.

Source: https://github.com/langchain-ai/langgraph/blob/main/libs/langgraph/langgraph/types.py ,
https://docs.langchain.com/oss/python/langgraph/use-graph-api

### 9.3 The `Send` API — precise mechanics

```python
class Send:
    __slots__ = ("node", "arg", "timeout")
    def __init__(self, /, node, arg, *, timeout: float|timedelta|TimeoutPolicy|None = None):
        self.node = node; self.arg = arg; self.timeout = TimeoutPolicy.coerce(timeout)
```

- **`Send.arg` is the ENTIRE input the spawned node sees** — it completely *replaces* (is not merged
  with) the parent's state for that invocation. This is what makes map-reduce work: each spawned task
  carries a small distinct slice (`{"subject": s}`), not the full state.
- All pending `Send`s accumulate in the reserved `TASKS` channel (a `Topic[Send]`), which **is
  checkpointed** — pending sends survive a crash. On the next super-step, `prepare_next_tasks` drains
  `TASKS` by index to build PUSH tasks:
  ```python
  tasks_channel = channels.get(TASKS)
  if tasks_channel and tasks_channel.is_available():
      for idx, _ in enumerate(tasks_channel.get()):
          if task := prepare_single_task((PUSH, idx), None, checkpoint=checkpoint, ...): tasks.append(task)
  ```
- `prepare_push_task_send` resolves each: `packet = sends[idx]`; task_id from
  `(checkpoint_id, checkpoint_ns, step, packet.node, PUSH, idx)`; the executable task carries
  `packet.arg` as input and `packet.timeout` (per-Send override of the node's default). A `Send`
  naming an unknown node, or a non-`Send` in `TASKS`, is logged and **skipped**, not crashed —
  defensive against partially-corrupted checkpoints.

**Map → reduce** (the classic shape):
```python
class OverallState(TypedDict):
    subjects: list[str]
    jokes: Annotated[list[str], operator.add]     # reducer: all workers append here

def generate_joke(state): return {"jokes": [joke_map[state["subject"]]]}
def continue_to_jokes(state): return [Send("generate_joke", {"subject": s}) for s in state["subjects"]]
builder.add_conditional_edges("generate_topics", continue_to_jokes, ["generate_joke"])
builder.add_edge("generate_joke", "best_joke")
```
All N `generate_joke` PUSH tasks run in the **same super-step**, each writes independently to
`jokes`; reconcile concatenates them deterministically (sorted by task id). **Without a reducer,
N parallel writes to one key raise `InvalidUpdateError`.**

Source: https://docs.langchain.com/oss/python/langgraph/use-graph-api ,
https://github.com/langchain-ai/langgraph/blob/main/libs/langgraph/langgraph/pregel/_algo.py

### 9.4 `interrupt()` — full mechanics and THE re-run caveat

```python
def interrupt(value: Any) -> Any:
    conf = get_config()["configurable"]
    scratchpad = conf[CONFIG_KEY_SCRATCHPAD]
    idx = scratchpad.interrupt_counter()          # 0,1,2,... per call within THIS task
    if scratchpad.resume:
        if idx < len(scratchpad.resume):
            conf[CONFIG_KEY_SEND]([(RESUME, scratchpad.resume)])
            return scratchpad.resume[idx]          # already-answered: return immediately
    v = scratchpad.get_null_resume(True)
    if v is not None:
        assert len(scratchpad.resume) == idx
        scratchpad.resume.append(v); conf[CONFIG_KEY_SEND]([(RESUME, scratchpad.resume)]); return v
    raise GraphInterrupt((Interrupt.from_ns(value=value, ns=conf[CONFIG_KEY_CHECKPOINT_NS]),))
```
```python
@dataclass(init=False, slots=True)
class Interrupt:
    value: Any; id: str
    @classmethod
    def from_ns(cls, value, ns): return cls(value=value, id=xxh3_128_hexdigest(ns.encode()))
```
`Interrupt.id` is a deterministic hash of the **checkpoint namespace** (where in the graph the
interrupt fired), used for external addressing; the per-task `scratchpad.resume` list index (`idx`)
distinguishes multiple `interrupt()` calls inside one node.

`GraphInterrupt` is a `GraphBubbleUp` — a control signal, not a failure. It's suppressed **only at
the root Pregel loop** (`_suppress_interrupt`, `not self.is_nested`); inside a subgraph it's let
through as an ordinary exception so it propagates to the parent's task executor and up to the root.
So "interrupts propagate out of subgraphs" is just normal Python exception propagation through
nested `invoke()` calls, caught once at the top. Each nested loop level still flushes its own
checkpoint/pending-writes before re-raising.

**THE critical caveat (quoted):** *"LangGraph saves checkpoints at super-step boundaries rather than
within individual nodes. If a graph execution is interrupted and later resumed, the affected node
will re-execute from the beginning of its function."* *"Side effects called before an interrupt
should be idempotent because interrupts re-run the nodes they were called from."*
```python
def node(state):
    some_code()           # <-- reruns on every resume; must be idempotent (upsert, not insert)
    answer = interrupt("what is your age?")
    return {"human_value": answer}
```
First run: `some_code()`, then `interrupt` raises `GraphInterrupt`, halts. `Command(resume=answer)`
re-invokes the **entire task from the top**: `some_code()` runs again (for real, no memoization),
`interrupt()` finds `scratchpad.resume` populated and returns `answer` instead of raising.

**Multiple interrupts in one node** resume by strict **call-order index** — never reorder or
conditionally skip them, or index-matching desyncs and returns the wrong answer to the wrong prompt.

**`Command(resume=...)`** two shapes:
1. **Single value** — legal only if exactly one interrupt is pending; written as `(RESUME, value)`.
2. **Map by interrupt id** — `Command(resume={interrupt.id: value})`, required when >1 interrupt is
   pending (detected because every key is a valid xxh3-128 hex digest). Stored in
   `CONFIG_KEY_RESUME_MAP`.

**Static `interrupt_before`/`interrupt_after`** (compile-time or per-invocation node-name lists)
pause at a **natural super-step boundary** — before a node's task runs, or after it fully completed
and was checkpointed. So there is **no re-run problem** for static breakpoints (trivial resume),
unlike dynamic `interrupt()`. A minimal engine can implement static breakpoints cheaply (a
name-check in the scheduler) while dynamic mid-node interrupts need the full scratchpad/index design.

Source: https://github.com/langchain-ai/langgraph/blob/main/libs/langgraph/langgraph/types.py ,
https://docs.langchain.com/oss/python/langgraph/interrupts ,
https://docs.langchain.com/oss/python/langgraph/graph-api

### 9.5 `RemainingSteps` / `recursion_limit`

`recursion_limit` is a top-level `config` key (not under `configurable`), default 25, **counting
super-steps** (not tool calls). Exceeding it raises `GraphRecursionError(RecursionError)`.

`RemainingSteps` is a **managed value** — a computed pseudo-channel decremented each super-step so a
node can react *before* the hard error:
```python
class State(TypedDict):
    messages: Annotated[list, lambda x, y: x + y]
    remaining_steps: RemainingSteps
def route_decision(state) -> Literal["agent", END]:
    return END if state["remaining_steps"] <= 2 else "agent"
```
Two-tier pattern: a conditional edge that routes to `END`/fallback before the limit (graceful, graph
completes normally) vs `try/except GraphRecursionError` as a last-resort catch (reactive; the final
over-limit step's state is lost). For a hand-rolled engine: track a step counter, expose
`recursion_limit - step` as a readable field, and raise a distinguished exception at
`step >= recursion_limit` the driver can catch for a clean "did not converge" result.

### 9.6 Subgraphs

- **Shared vs private state keys:** a subgraph is another compiled graph added as a node. Keys shared
  by name with the parent schema pass through automatically; keys private to the subgraph never leak.
  If parent and subgraph share **no** keys, you can't mount the compiled subgraph directly — wrap it
  in a translator node.
- **Checkpoint namespacing:** every subgraph invocation runs in a nested `checkpoint_ns`
  (`parent_ns|node_name`), one row per level (§8.4). Consequence: *"When a subgraph updates its
  state, the parent graph may not immediately see these changes because each subgraph manages its own
  checkpoint namespace... use shared state via a Store, or configure the subgraph to write directly
  to the parent checkpoint."* For subgraph interrupts/state-inspection to work, the **parent** must
  be compiled with a checkpointer; the subgraph inherits it via `CONFIG_KEY_CHECKPOINTER`.
- **`Command.PARENT`** (§9.2) is the one first-class way for a subgraph node to route/write directly
  into the parent's namespace.
- **Interrupts propagate as ordinary exceptions** through nested invoke frames (§9.4); both the
  parent node's pre-subgraph code *and* the subgraph node's pre-interrupt code re-run on resume —
  idempotency must hold at every nesting level on the path to the interrupt.
- Subgraph resume via `Send` is signaled with a `CONFIG_KEY_RESUMING` config flag (internal
  plumbing), not a `Command(resume=...)` wrapper.

Sources: https://docs.langchain.com/oss/python/langgraph/use-subgraphs ,
https://docs.langchain.com/oss/python/langgraph/persistence

### 9.7 Minimal engine pseudocode

```
run(graph, input, config):
    ckpt = checkpointer.load(config.thread_id) or fresh_checkpoint(graph, input)
    step = ckpt.step
    while True:
        if step >= config.recursion_limit: raise GraphRecursionError
        tasks = prepare_next_tasks(ckpt)   # PUSH from pending Sends + PULL from edges
        if not tasks: break                # converged
        for task in tasks:                 # conceptually parallel; isolated state view each
            try:
                out = task.node_fn(task.input)   # Send.arg for PUSH, merged state for PULL
                if isinstance(out, Command):
                    apply_update(ckpt, out.update, target_ns=out.graph)   # PARENT crosses namespace
                    if out.goto: enqueue_sends(ckpt, to_sends(out.goto))
                else: apply_update(ckpt, out)     # dict update through per-key reducers
            except GraphInterrupt as gi:
                pending_writes.record(task.id, gi.args[0])
                if not is_nested: checkpoint_and_persist(ckpt); return {"__interrupt__": gi.args[0]}
                raise                              # bubble to parent
        checkpoint_and_persist(ckpt)               # O(1) resume point: whole channel state
        step += 1
    return read_output(ckpt)
# resume: run(graph, Command(resume=answer_or_map), config)
```

Ranked gotchas (hardest to get right first): (1) interrupt resume re-runs the whole node function,
no continuation saved — track which interrupt calls already have resume values, match by call order.
(2) Checkpoint at super-step granularity, not per-node. (3) `Send.arg` fully replaces node input.
(4) Reducers mandatory for concurrent same-step writes; unannotated = hard error. (5) Subgraph ns =
`parent_ns + sep + node`; interrupts propagate as ordinary exceptions. (6) Multiple simultaneous
interrupts need id-keyed resume — decide early whether you allow >1 paused branch.

## 10. Node operations: retry / cache / defer / streaming / durability / functional / schemas

### 10.1 RetryPolicy

```python
class RetryPolicy(NamedTuple):
    initial_interval: float = 0.5      # seconds before first retry
    backoff_factor: float = 2.0
    max_interval: float = 128.0
    max_attempts: int = 3              # total tries INCLUDING the first
    jitter: bool = True                # add random.uniform(0,1)
    retry_on: type[Exception] | Sequence[...] | Callable[[Exception], bool] = default_retry_on
```
`add_node(..., retry_policy=Sequence[RetryPolicy])` — first policy whose predicate matches wins.

`default_retry_on` is an **exclusion list** ("probably a bug, don't retry"), not an inclusion list:
```python
def default_retry_on(exc):
    if isinstance(exc, ConnectionError): return True
    if isinstance(exc, httpx.HTTPStatusError): return 500 <= exc.response.status_code < 600
    if isinstance(exc, requests.HTTPError): return 500 <= exc.response.status_code < 600 if exc.response else True
    if isinstance(exc, (ValueError, TypeError, ArithmeticError, ImportError, LookupError,
                        NameError, SyntaxError, RuntimeError, ReferenceError,
                        StopIteration, StopAsyncIteration, OSError)): return False
    return True                         # everything else defaults to retryable
```
Extend, don't replace: `retry_on=lambda e: isinstance(e, MyError) or default_retry_on(e)`.

The backoff loop (`run_with_retry`):
```python
attempts = 0
while True:
    try:
        task.writes.clear()          # discard partial writes from a failed prior attempt
        return task.proc.invoke(task.input, config)
    except ParentCommand: ...        # Command(graph=...) routing — not a retry
    except GraphBubbleUp: raise      # interrupt() bubbling — never retried
    except asyncio.CancelledError as exc: raise NodeCancelledError(task.name) from exc
    except Exception as exc:
        if not retry_policy: raise
        policy = next((p for p in retry_policy if _should_retry_on(p, exc)), None)
        if not policy: raise
        attempts += 1                                    # counts FAILURES
        if attempts >= policy.max_attempts: raise
        interval = min(policy.max_interval, policy.initial_interval * policy.backoff_factor**(attempts-1))
        time.sleep(interval + random.uniform(0,1) if policy.jitter else interval)
        config = patch_configurable(config, {CONFIG_KEY_RESUMING: True})  # subgraph resumes cleanly
```
- **Writes cleared per attempt** — a partial write never leaks into the retry; only the successful
  attempt's writes reconcile.
- `max_attempts=3` = try (fail→1, sleep), try (fail→2, sleep), try (fail→3==max, raise).
- `GraphBubbleUp` (interrupt) and real `CancelledError` are **never retried**; a node-raised
  `CancelledError` becomes `NodeCancelledError` (a real error — nodes can't fake shutdown).
- `error_handler` (`add_node(node, error_handler=fn)`) auto-generates `__error_handler__{node}` that
  runs when retries are exhausted — the "retry gives up → route to compensation" pattern. An error
  handler cannot have its own error handler (no infinite recursion).
- `set_node_defaults(retry_policy=..., error_handler=...)` — graph-wide defaults resolved at compile,
  per-node override wins, **not inherited by subgraphs**.

Sources: https://docs.langchain.com/oss/python/langgraph/fault-tolerance ;
`_internal/_retry.py` (`default_retry_on`); `pregel/_retry.py` (`run_with_retry`).

### 10.2 CachePolicy

```python
@dataclass(kw_only=True, slots=True, frozen=True)
class CachePolicy(Generic[KeyFuncT]):
    key_func: KeyFuncT = default_cache_key
    ttl: int | None = None
class CacheKey(NamedTuple):
    ns: tuple[str, ...]; key: str; ttl: int | None

def default_cache_key(*args, **kwargs) -> str | bytes:
    return pickle.dumps((_freeze(args), _freeze(kwargs)), protocol=5, fix_imports=False)
```
`_freeze` canonicalizes unhashable containers so keys are stable regardless of dict insertion order.
The cache key is a **pure function of the node's resolved input** (post input_schema projection);
nothing about which edge routed here or prior history unless `key_func` includes it.

**Cache store lives on the graph, policy lives on the node** — a silent footgun:
```python
builder.add_node("expensive", fn, cache_policy=CachePolicy(ttl=3))
graph = builder.compile(cache=InMemoryCache())    # cache instance supplied at compile
graph.invoke({"x": 5}, stream_mode="updates")     # [{'expensive': {'result': 10}}]
graph.invoke({"x": 5}, stream_mode="updates")     # [{'expensive': {'result': 10}}, {'__metadata__': {'cached': True}}]
```
A cache hit surfaces as a sibling `{"__metadata__": {"cached": True}}` entry; the node's observable
output is identical. **A cache policy with no `cache=` at compile is a silent no-op** — replicate
deliberately (loud warning) or avoid. Cache scope is cross-run (by key + TTL) — distinct from
task-level checkpointing (§10.5), which is about resuming one crashed run.

### 10.3 `defer=True` — NOT a DAG join barrier

At compile, a deferred node's trigger channel is `LastValueAfterFinish` instead of
`EphemeralValue(guard=False)`. Maintainer's authoritative clarification (issue #6005, condensed):

> LangGraph is a reactive state machine, not a DAG scheduler. Edges are possible next hops, not
> dependency constraints. `defer=True` only delays a node until no more non-deferred work can run —
> it does NOT mean "run after all ancestors." A deferred node can execute many super-steps later, and
> can **fire multiple times**.

Given `node1 → {node2→node3, node4(defer), node5(defer)}` and `node4→node5`: `node4` and `node5` both
trigger in the same super-step once non-deferred work is done; then `node5` **re-executes** because
`node4→node5` is also a real edge. `defer` is a "sledgehammer" (wait for global quiescence), not a
join.

**For a real join, don't clone `defer`** — use an explicit reducer over a multi-`from` join edge
(§7.6, §13.2.3), or a gating conditional edge:
```python
def gate_to_5(state) -> list[str]: return ["node5"] if state.get("n4_ready") else []
graph.add_conditional_edges("node1", gate_to_5)
```

Source: https://github.com/langchain-ai/langgraph/issues/6005 , `graph/state.py`.

### 10.4 Streaming

| Mode | Payload | Requires |
|---|---|---|
| `values` | full state snapshot after each step | — |
| `updates` | `{node: partial_state}` per node (separate if multiple ran) | — |
| `messages` | `(chunk, metadata)` token-by-token from any LLM inside a node/tool/subgraph | — |
| `custom` | arbitrary payload via `get_stream_writer()` / `StreamWriter` | — |
| `checkpoints` | checkpoint-created events (shape of `get_state()`) | a checkpointer |
| `tasks` | task start/finish incl. results & errors | a checkpointer |
| `debug` | `checkpoints` + `tasks` unified with `step`/`timestamp`/`type` | a checkpointer |

v1 wire format shape-shifts (single mode → raw; multi → `(mode, data)`; `subgraphs=True` →
`(ns, ...)`). **v2** (`version="v2"`, ≥1.1) unifies everything into one envelope — worth copying:
```python
{"type": "values"|"updates"|..., "ns": (), "data": ...}   # ns populated only for subgraph events
```

Streaming rides the loop as a **synchronous inline callback**, not a separate log tailer
(`PregelLoop._emit`):
```python
def _emit(self, mode, values, *args, **kwargs):
    if self.stream is None: return
    debug_remap = mode in ("checkpoints","tasks") and "debug" in self.stream.modes
    if mode not in self.stream.modes and not debug_remap: return
    for v in values(*args, **kwargs):
        if mode in self.stream.modes: self.stream((self.checkpoint_ns, mode, v))
        if debug_remap:
            self.stream((self.checkpoint_ns, "debug", {
                "step": self.step-1 if mode=="checkpoints" else self.step,
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "type": "checkpoint" if mode=="checkpoints" else ("task_result" if "result" in v else "task"),
                "payload": v}))
```
`self.stream` is a `StreamProtocol` (callback + subscribed `modes` set), fired inline at super-step
boundaries. `DuplexStream(*streams)` fans one emission to N consumers filtered by modes. `debug` is a
free repackaging of `checkpoints`+`tasks`. `StreamWriter`/`get_stream_writer()` is the in-node escape
hatch for custom streaming (ambient contextvar lookup on Python ≥3.11; injected `writer: StreamWriter`
parameter on async <3.11).

Source: https://docs.langchain.com/oss/python/langgraph/streaming , `pregel/_loop.py`.

### 10.5 Functional API vs Graph API — the checkpointing fork

> Both use checkpoints, but generation differs: **the Graph API creates a new checkpoint after every
> super-step** (state is the unit of persistence); **the Functional API's `@entrypoint` compiles to a
> single node that REPLAYS ITS ENTIRE BODY from the top on resume**, using memoized `@task` results
> to skip already-done work (the call graph, not state, is the unit of persistence).

```python
@entrypoint(checkpointer=checkpointer, store=store)
def my_workflow(some_input: dict, *, previous=None, store=None, writer=None, config=None): ...

@task(retry_policy=..., cache_policy=..., timeout=...)
def slow(x): return x*2
# futures = [slow(i) for i in xs]; [f.result() for f in futures]  — parallel fan-out
```
`previous` = value from the prior checkpoint for this thread (explicit short-term memory).
`entrypoint.final(value=X, save=Y)` decouples the returned value from the checkpointed value.

**Determinism requirement:** because the body re-executes from the top on resume, wrap
`time.time()`/`random`/IO in a `@task` so the *recorded* result (not a fresh computation) is what the
replayed body sees. This is LangGraph's concrete instance of *event-sourcing over side effects*
(vs the Graph API's *state-snapshotting*) — a real architectural fork if a from-scratch engine picks
one. graph-bro's node shape (expensive non-deterministic subprocess) favors state-snapshotting (§11).

**`@task` inside a Graph API node** gives finer-grained checkpointing without adopting full replay:
the node still checkpoints once per super-step, but each `@task` call is independently recorded, so a
node crashing partway through a URL-fetch fan-out resumes skipping already-recorded fetches.

### 10.6 Schemas as projections

`StateGraph(OverallState, input_schema=InputState, output_schema=OutputState)` — three views over
one channel set. `input_schema` filters/validates external input; `output_schema` filters what
`.invoke()` returns; `OverallState` is what nodes read/write internally. Per-node
`add_node(..., input_schema=NodeInput)` hands the node only the matching subset — a
dependency-declaration/privacy filter **for free** on top of the channel model, no separate
access-control system. Private state = a schema (`PrivateState`) never in input/output — internal
scratch channels invisible at both boundaries.

### 10.7 Runtime context injection

```python
graph = StateGraph(State, context_schema=ContextSchema)
def node(state, runtime: Runtime[ContextSchema]):
    runtime.context.llm_provider          # typed per-invocation DI (DB conns, provider config)
    runtime.execution_info.thread_id       # execution metadata (thread_id, node_attempt)
```
`context` is supplied at `.invoke(..., context=...)`, read-only, **never checkpointed** — it must be
re-supplied identically on resume (distinct from state). Signature-based injection (same pattern as
`writer: StreamWriter`). `Runtime.execution_info` is patched per-attempt with `node_attempt`, so a
node can degrade to a cheaper model on retry N.

### 10.8 Durability modes

| Mode | Behavior | Trade-off |
|---|---|---|
| `"exit"` | checkpoint only on graph exit | best perf; no mid-run recovery |
| `"async"` (default) | checkpoint write dispatched in background; loop continues | good perf + durability; small window loses one checkpoint on crash |
| `"sync"` | checkpoint confirmed before the next super-step | highest durability; each step pays write latency |

Docs note directly: *"By default LangGraph writes checkpoints in the background using 'async'
durability... allowing the graph to continue without waiting."* This is **why fine-grained node
decomposition is cheap in LangGraph** — checkpoint I/O is off the hot path. A from-scratch engine
that checkpoints synchronously after every node pays a real latency tax for the same style.
`durability` gates only the coarse full-state checkpoint; per-task pending writes are always durable
(§8.5).

### 10.9 Cross-cutting gotchas

1. Retry (clears `task.writes` per attempt) and cache (stores/replays the same `writes` deque keyed
   by `CacheKey`) both operate at the **task-write level, below the reconciled-state abstraction** —
   bolt both on without touching reducer/channel logic, as long as "the ordered set of writes a
   node attempt produced" is a serializable, replayable unit.
2. `defer` is a scheduling hint, not a join — use reducers over multi-`from` joins for real barriers.
3. A cache policy without a compile-time `cache=` store is a silent no-op — decide deliberately.
4. `context_schema`/Runtime and checkpointed state are separate persistence domains.
5. Functional-API replay-with-memoized-calls vs Graph-API snapshot-per-superstep is a genuine fork.
6. Streaming is a synchronous inline callback fan-out, not a log tailer — cheapest possible design.
7. `debug` mode is free once `checkpoints`+`tasks` exist.

Sources: fault-tolerance, node-caching, streaming, functional-api, checkpointers,
thinking-in-langgraph docs at docs.langchain.com/oss/python/langgraph/* ; `types.py`,
`_internal/_retry.py`, `_internal/_cache.py`, `pregel/_retry.py`, `pregel/_loop.py`, `graph/state.py`;
issue #6005.

## 11. Durable execution: replay vs snapshot — and the verdict for CLI-agent nodes

Two architectural families:

**Family A — Event-sourced replay (Temporal, Inngest, Restate, DBOS).** Program state is never
serialized. What's persisted is a **log of side-effect results**. Recovery = re-execute the
orchestrating function **from statement 1**, but every non-deterministic operation is intercepted: if
the log has a recorded result for "the Nth side-effecting call," return it without doing the work;
else do it and append. Local variables, loop counters, call stack are reconstructed **by re-running
the code**.

**Family B — State snapshot (LangGraph/Pregel, tianpan.co essay).** The orchestrator's state (typed
channels) is serialized **after each super-step**. Recovery = deserialize the last checkpoint and
resume the scheduler at the recorded position. Completed node code is never re-run.

### 11.1 The four Family-A systems, compressed

- **Temporal** — an append-only **Event History**; workflow emits **Commands**, the service turns
  accepted Commands into Events. Replay matches Command↔Event by **type + sequence position**; a
  mismatch is a transient `WorkflowTaskFailure` (auto-retries, can wedge). Sticky workers cache the
  live coroutine so full replay is the cold-start/crash path, not steady state. **Activities** are
  the escape hatch for non-determinism (LLM calls, DB, HTTP) — not replayed, at-least-once, need
  caller-supplied idempotency keys. Default activity retry: exponential, 1s initial, 2.0 coef, 100s
  cap, unlimited attempts. **Heartbeats** persist fine-grained activity progress ("line 4500 of
  10000") for sub-activity resume. Workflows have **no** default retry (a workflow failure is a
  design problem).
- **Inngest** — each `step.run(id, fn)` is memoized by hashed **string ID**; the function body
  re-runs from the top on every step (default: one HTTP round-trip per step, ~50–100ms). Changing a
  step's ID between deploys just re-runs it (soft fail). Parallel steps have a documented,
  bug-confirmed (`inngest-js#1248`) ordering hazard. v4 `checkpointing` bolts eager client-side
  execution on top to cut per-step latency.
- **Restate** — journals side effects as a **binary wire protocol** with `Replaying`/`Processing`
  stream states and a `SuspensionMessage` naming pending entry indices. Hard rule: **`ctx.run`
  cannot nest other context calls** and must be immediately awaited. Determinism helpers (`ctx.rand`,
  UUID, millis) seeded from the invocation ID. Default auto-suspend after **1 minute** inactivity.
- **DBOS** — checkpoints inputs/step-outputs directly into **Postgres rows**, no separate service.
  Three guarantees: (1) workflows always run to completion; (2) steps tried at least once, **never
  re-executed after completion**; (3) transactions commit exactly once. The **workflow ID is the
  idempotency key** (`with SetWorkflowID(f"event-{event_id}"):`) — dedup an at-least-once trigger.
  A workflow function that itself throws is non-recoverable by design (only its steps auto-retry).

**Shared constraint:** the orchestrator code must be **cheap, pure, and safe to re-execute wholesale**
on every retry, because replay literally means "call this function from line 1," gated by a
side-effect-result lookup. Fine when the function is thin glue around RPC/DB calls; expensive and
fragile as the orchestrator body grows or its control flow becomes hard to reproduce byte-for-byte.

### 11.2 Why replay is wrong for CLI-coding-agent nodes

A node's work is `claude -p <prompt>` / `codex exec <task>` — a multi-minute, billed, non-deterministic
subprocess with non-idempotent worktree side effects (re-running the same prompt doesn't reproduce
the same diff; re-applying a diff isn't a no-op).

1. **"Wrap it as one opaque step" is what you'd do anyway** — the node-run *is* the side-effecting
   call Family A tells you to isolate. So the "orchestrator body" (routing, reducers, `Send` fan-out,
   loop guards) that Family A demands be cheap-and-deterministic is, here, the *entire graph engine*
   — not thin glue.
2. **Determinism is hard to guarantee** because the data flowing through conditional edges *is* LLM
   output. Every templated-prompt construction, reducer merge, loop-counter increment must never
   touch a clock/random/unwrapped IO — heavy, easy-to-violate discipline with no compiler-enforced
   orchestrator/activity boundary in a hand-rolled engine.
3. **Mid-subprocess crash recovery is worse under Family A**: the "re-run the whole wrapped block"
   default means paying for and waiting out an entire multi-minute agent session again,
   non-deterministically producing a *different* result — exactly what Temporal's heartbeat mechanism
   exists to avoid, and heartbeats are manual/per-activity.
4. **A snapshot is trivially sufficient**: the unit of work is already coarse (one subprocess per
   super-step), so the natural checkpoint boundary is "the graph's typed state after the node
   finishes" — a plain serializable dict, no journal, no forbidden-API list.

### 11.3 Verdict

Adopt **Family B (state-snapshot-per-superstep)** as the base, and borrow exactly two Family-A ideas
as targeted patches:

- **Idempotency keys from run/node identity** (DBOS `SetWorkflowID`, Temporal activity-id key). Give
  every node execution a stable key so a node *can* check "did I already push this branch / open this
  PR / send this notification" before repeating a side effect on retry — applied at the node boundary,
  not pervasively. **Do not invent a new `(run_id, node_id, attempt)` triple** — reuse the deterministic
  `task_id` (§8.4) as the node/attempt component, since it is *already* stable across both retry (§10.1)
  and crash/interrupt resume (§9.4) and *already* changes on a genuinely new attempt (§8.6). §11.5
  specifies the concrete ledger (storage, write timing, API).
- **Heartbeat-style sub-node liveness/partial-progress** (Temporal Activity Heartbeat). The closest
  production reference (athena-graphs) ships **zero** heartbeat code and no per-node timeout — its only
  liveness signals are a whole-run `max_seconds` and a single blocking `subprocess.run(timeout=...)`,
  both "did it take too long," not "is it still making progress" (§13.4). The cheap, informative proxy
  for a streaming CLI-agent node is the **timestamp of the last stdout line** — any NDJSON event
  (even a non-terminal token delta or a Codex `item.started`) resets it, so "no event in N seconds" is
  a soft stuck-signal well before the hard timeout fires. Use **two independent thresholds**: a soft
  `heartbeat_interval` (emit a warning event, let a supervisor show "still working, last activity Ns
  ago") vs. a hard `timeout` (kill via §14.7); conflating them either false-positive-kills a node that
  is just thinking hard or never surfaces "looks stuck" until the expensive hard kill. This is the one
  edge case snapshot-at-superstep doesn't solve for free: **mid-node-crash recovery below one full node
  execution.** §13.4 gives the concrete streaming/heartbeat design.

### 11.4 Where replay genuinely wins (honest edge cases)

1. **Mid-node crash with a partially-applied external side effect the snapshot can't see** (email
   sent / PR opened / card charged before the node was recorded complete). A pure snapshot re-runs the
   node → re-sends. Fix: wrap the specific *engine-known* side effects (`git push`, Slack post, ticket
   transition) with idempotency keys — don't adopt replay wholesale. **Honest caveat (§11.5):** an
   idempotency ledger alone does **not** make this crash-window disappear — neither DBOS nor Temporal
   removes it for external, non-transactional calls (DBOS's "exactly-once" applies only to
   `@DBOS.Transaction` steps, where the ledger write and the side effect share one Postgres
   transaction; a `git push` cannot). The ledger is the fast path; a per-effect **reconciliation
   query against the external system's real state** (does `origin/<branch>` already point at this
   commit? is there already an open PR from this head?) is the correctness backstop for the ambiguous
   "reserved but not confirmed" case.
2. **At-least-once trigger dedup upstream of the graph** (DBOS `SetWorkflowID`). A snapshot engine
   replicates this trivially: key the run by the trigger's natural ID, check-and-create-once.

Both are satisfied by bolting idempotency keys onto snapshot, not by re-architecting around replay.

| Question | Event-sourced replay | State snapshot (chosen) |
|---|---|---|
| Persisted | log of side-effect results | serialized state per super-step |
| Recovery | re-run orchestrator from top, skip logged work | deserialize last checkpoint, resume scheduler |
| Cost of crash before checkpoint | bounded by log granularity (sub-step w/ heartbeats) | bounded by super-step (whole node re-runs) |
| Determinism burden on orchestrator | strict, hard-to-verify, SDK-enforced (loosely) | none — state is data, not replayed code |
| Fits "node = expensive non-det subprocess" | poor | good |
| Steal anyway | idempotency keys; heartbeat/partial-progress | — (this is the base) |

Citations (27 primary sources in the source finding): Temporal docs.temporal.io/{workflow-execution,
workflow-definition, workflows, encyclopedia/event-history/*, encyclopedia/retry-policies,
activity-definition, design-patterns/long-running-activity}; Inngest inngest.com/docs/{learn/how-
functions-are-executed, learn/inngest-steps, guides/step-parallelism, setup/checkpointing} +
inngest-js#1248; Restate docs.restate.dev/* + service-protocol repo; DBOS docs.dbos.dev/{architecture,
why-dbos, python/tutorials/workflow-tutorial} + dbos-inc mintlify concepts.

### 11.5 The idempotency-key ledger — concrete spec

§11.3's "idempotency keys" bullet is a decision, not a design. This is the design, synthesized from
DBOS's `operation_outputs` table and Temporal's `operations`-table pattern, then adapted to
graph-bro's deterministic `task_id`.

**Key shape — reuse `task_id`, add `effect_key`.** The ledger key is `(task_id, effect_key)`, where
`task_id` is the §8.4 `xxh3_128` hash and `effect_key` is a short node-supplied discriminator
(`"push:origin/feature-x"`, `"pr:open"`) so one node performing >1 side effect in sequence
(push, *then* open-PR) can resume at exactly the second, not repeat the first or skip both. Reusing
`task_id` is strictly stronger than a new `(run_id, node_id, attempt)` triple: it is stable across
`RetryPolicy` attempts (§10.1 clears `task.writes` and increments a local counter but never mints a
new id) and across crash/interrupt resume (the same hash re-derives from the same checkpoint fields,
§9.4), yet correctly *changes* on a genuinely new attempt (a `Command`/`update_state` re-entry, §8.6,
produces fresh triggers → fresh `task_id` → fresh reservation). **The two triggering conditions the
gap worried about — retry re-invocation and resume re-execution — are one case from the ledger's
point of view**, both checked at the top of `idempotent_effect()`; neither DBOS's per-workflow
counter `function_id` nor Temporal's caller-assigned Activity ID has an equivalent content-derived id.

**Where it lives — a new sibling table, not a checkpoint field, not the `writes` table.** A checkpoint
field is durable strictly too late (the side effect can complete, and the crash happen, *before* the
super-step's checkpoint is written — that is precisely why §9.4's node re-runs). The §8.5 pending-`writes`
table is the wrong lifecycle: `writes` rows are cleared the instant a superseding checkpoint lands
(`after_tick`, §7.3), but a completed side effect *actually happened* and stays true forever. Use a
**new `side_effects` table in the same store** as the checkpoint DB (one backup target), joined only
by the shared `task_id`, with its own much-longer pruning TTL:

```sql
CREATE TABLE side_effects (
  task_id     TEXT NOT NULL,   -- §8.4 xxh3_128(checkpoint_id, ns, step, node, PULL|PUSH, *triggers)
  effect_key  TEXT NOT NULL,   -- node-supplied: "push:<branch>", "pr:open", ...
  status      TEXT NOT NULL CHECK (status IN ('pending', 'done')),
  result      BLOB,            -- serialized outcome once done (PR url, commit sha, ...)
  created_at  INTEGER NOT NULL,
  completed_at INTEGER,
  PRIMARY KEY (task_id, effect_key)
);
```

**Write timing — reserve before, complete after (the split is unavoidable, not polish).** Write #1
is the reservation `INSERT ... ON CONFLICT (task_id, effect_key) DO NOTHING`, durable **synchronously**
*before* the side effect fires (never deferred to `async`/`exit` durability, §10.8 — losing it
reintroduces the bug); then re-`SELECT` regardless, since a prior attempt may already hold it. Write #2
is `UPDATE ... SET status='done', result=? WHERE ... AND status='pending'`, *after* the call returns.
Mirror DBOS's conflict check: if the row is already `done` with a **different** stored `result` than
this attempt produced, raise loudly (two different commit SHAs under one supposedly-idempotent
operation is a correctness bug, not a race to paper over) — the same "loud-fail on unreduced concurrent
writes" instinct §7.1/§13.2.4 apply to reducers. Because the external call (git, GitHub) is *not* a
row in the same DB, the reserve-INSERT and the side effect can never share one transaction — this is
exactly why the split is mandatory, whereas Temporal's own SQL example (a balance debit) closes the
window for free by wrapping both in one transaction.

**Node-facing API:**
```python
def idempotent_effect(task_id, effect_key, perform, reconcile=lambda: None):
    row = ledger.get(task_id, effect_key)
    if row and row.status == "done":
        return deserialize(row.result)                 # fast path: already did it, cached result
    if row is None:
        ledger.insert_pending(task_id, effect_key)      # write #1, durable before perform()
    else:  # status == "pending": an earlier attempt crashed inside perform() — AMBIGUOUS
        prior = reconcile()                             # ask the external system: did it land?
        if prior is not None:
            ledger.mark_done(task_id, effect_key, prior); return prior
        # else: never left the machine (crashed before the call went out) — fall through
    result = perform()
    ledger.mark_done(task_id, effect_key, result)        # write #2
    return result
```

**The honest limit: reconciliation is per-effect-type, not free.** A `pending`-but-not-`done` row is
genuinely ambiguous — "started, then the process died, don't know if the call landed." No generic
ledger closes this window (§11.4); the only correct resolution is a `reconcile()` hook specific to the
effect's external system: `git push` is nearly self-idempotent (`reconcile` = compare `origin/<branch>`
SHA to the local commit; surface a *diverged* remote as a conflict, not a silent "done"); `gh pr open`
has **no** native idempotency key at all (`reconcile` = "list open PRs with this head branch" — one
found = done, record its URL; none = the create never landed, safe to retry). The ledger stays
authoritative and cheap for the common case (`done` row → zero external calls); reconciliation is paid
only on the rare crash-window case.

**Pruning is independent of checkpoint retention.** A run's checkpoints may be pruned long before
there is zero risk of a stale retry; conversely a `side_effects` row for a run that finished weeks ago
carries no duplicate-retry risk and prunes on its own longer TTL (e.g. 30–90 days, tuned to "how long
could a crashed worker sit before someone resumes it"). Index `created_at`; never gate one table's
prune on the other's retention state.

Sources: DBOS `SetWorkflowID`/`operation_outputs` — https://docs.dbos.dev/python/tutorials/workflow-tutorial ;
https://docs.dbos.dev/explanations/system-tables ;
https://github.com/dbos-inc/dbos-transact-py/blob/main/dbos/_schemas/system_database.py ;
`recordOperationResult` conflict check — https://github.com/dbos-inc/dbos-transact-ts/blob/219883e6/src/system_database.ts ;
"exactly-once for transactional steps only" — https://supabase.com/blog/durable-workflows-in-postgres-dbos .
Temporal idempotency-key formula — https://docs.temporal.io/activity-definition ;
https://docs.temporal.io/develop/python/best-practices/error-handling ; `operations`-table SQL, pruning
caveat, "check pre-existing results" race — https://temporal.io/blog/idempotency-and-durable-execution ;
key-must-not-be-regenerated — https://learn.temporal.io/tutorials/python/standalone-activities/ .

## 12. Comparative framework semantics

Six frameworks beyond LangGraph/PocketFlow/CLI-runners, with the mechanisms worth stealing.

- **Mastra (TS)** — `.then/.branch/.parallel/.dountil/.dowhile/.foreach`, all schema-typed and
  validated at build time. `.parallel()` is a hard sync point, output keyed by step id
  (`{[step.id]: output}`). `suspend()` is **step-scoped** (called inside `execute`), snapshot to
  `workflow_snapshots` table; **`forEachIndex`** gives per-iteration resume granularity. Two state
  channels: typed `inputData` (step-to-step) + a separate `state`/`setState` blackboard that persists
  across suspend/resume and propagates parent→child.
- **Pydantic Graph** — nodes are `@dataclass`es whose `run()` **return-type annotation IS the edge
  declaration**, enforced at runtime. Loops = a node returning its own type. No fan-out/join primitive
  (a genuine gap). `BaseStatePersistence` with per-node `created→pending→running→success/error`
  snapshots; **`graph.iter_from_persistence(persistence)` advances exactly one node per call as a
  stateless function of `(run_id, persistence)`** — a fresh process each call, genuinely
  distributable/queueable. The strongest form of "O(1) resume, controller never blocks."
- **Microsoft Agent Framework** — explicit Pregel/BSP superstep model, documented gotcha that fast
  parallel chains still wait on the slowest sibling in the same superstep. 5 typed edge kinds
  (Direct/Conditional/Switch-Case/**Multi-Selection dynamic fan-out**/Fan-in via
  `AddFanInBarrierEdge`). HITL via `RequestPort`/`ctx.request_info()` — a **typed request/response
  channel** matched by response type, persisted as checkpoint state and re-emitted on restore.
  Checkpoints at superstep end; executors opt into checkpoint participation (not automatic).
- **AutoGen GraphFlow** (`DiGraphBuilder`) — the standout: **`activation_group` +
  `activation_condition="all"|"any"`** cleanly splits AND-barrier from OR-race joins, and lets
  different incoming edges to the same node belong to different groups (distinguishing "initial entry"
  from "loop-back"). Validation rule: a node's edges must be **all-conditional or all-unconditional**
  (independently converged with LangGraph's "pick one mechanism"). Callable conditions aren't
  serializable — a durable graph needs a string/dict DSL (as athena-graphs uses) or name-registration.
- **CrewAI Flows** — `@start/@listen/@router/and_/or_` decorators; `@router` returns a string label
  (PocketFlow's action-string routing, reinvented). `and_()` = AND-join (fires once), `or_()` =
  OR-join (fires per completion). `@persist` → SQLite append-only `flow_states` + a dedicated
  `pending_feedback` table for HITL. Explicit **resume** (same UUID, extend history) vs **fork** (new
  UUID from a snapshot) distinction. `self.state` writes lock-guarded via `StateProxy`.
- **OpenAI Agents SDK** — handoff-**as-tool-call**, explicitly rejecting upfront graph declaration for
  a code-first approach. Full-conversation-history transfer by default; `input_filter`/`input_type`/
  `nest_handoff_history` as escape hatches. No native checkpoint/resume. Guardrail scope gotcha: input
  guardrails apply only to the first agent, output only to the last. The anti-graph argument is a valid
  counter-pressure: don't force graph ceremony on a two-node triage flow.
- **Google ADK** — `SequentialAgent`/`ParallelAgent`/`LoopAgent` as deterministic template composition.
  `ParallelAgent` has **zero built-in reducer** — distinct-key discipline is convention-only (the
  cautionary tale: documents state races as the developer's problem). `LoopAgent(max_iterations=N)` +
  sub-agent `escalate=True` = two independent termination paths. Join by composition (nest
  `ParallelAgent` as one step inside a `SequentialAgent`). `transfer_to_agent` moves control down the
  hierarchy only (siblings can't hand off directly).

### 12.1 Comparison table

| Framework | Routing | Loop | Join/barrier | Resume | State model |
|---|---|---|---|---|---|
| Mastra | `.branch`, one fires; schema-uniform | `.dountil`/`.dowhile` + `.foreach`; manual throw | `.parallel()` hard sync, keyed by step id | step-scoped `suspend`/`resume`; per-`foreach` via `forEachIndex`; `restart()` | typed `inputData` + separate `state` blackboard |
| Pydantic Graph | return-type union from `run()` | node returns its own type; no guard | **none built-in** | per-node snapshot; `iter_from_persistence` advances one node, stateless | single `StateT` object |
| MS AF / AutoGen | 5 typed edges; string/callable conds | cycle of edges; `activation_group`+`condition` | `AddFanInBarrierEdge`; `all`\|`any` per group | superstep checkpoints; `RequestPort` HITL persisted | typed messages + per-executor opt-in state |
| CrewAI | `@router` string label | `@router` + counter | `and_()`/`or_()` combinators | `@persist` SQLite; resume vs fork; `pending_feedback` | `self.state` dict/BaseModel, lock-guarded |
| OpenAI SDK | handoff = tool call | not a primitive | n/a | none native | full history transferred |
| Google ADK | fixed list order / composition | `LoopAgent(max_iter)` + `escalate` | `ParallelAgent` (no reducer!) nested in `SequentialAgent` | none at this layer | `session.state` flat dict, convention isolation |

### 12.2 Five "steal this" recommendations

1. **Split join-barrier-mode from merge-policy** the way AutoGen's `activation_group`/
   `activation_condition` does: `join(sources, mode: "all"|"any", group_id)` independent of the reducer
   combining payloads. Solves "loop back after whichever branch finishes first" without a bespoke hack.
2. **Make persistence a pure function of `(run_id, store)` at single-node granularity** (pydantic-graph
   `iter_from_persistence`). Core loop = "advance one node given persisted state"; a superstep batcher /
   CLI driver / queue worker is a thin wrapper.
3. **Treat HITL as ordinary checkpointed state with type-matched (not ID-matched) resolution**
   (MS AF `RequestInfoExecutor`) + a dedicated storage table for HITL-blocked runs (CrewAI
   `pending_feedback`) so "show me every run waiting on a human" is one query.
4. **Require identity-keyed or reducer'd parallel writes** (Mastra's per-branch key; athena-graphs'
   "conflict without a reducer = loud failure") rather than ADK's silent-convention model.
5. **Support both a code-first handoff mode and a validated declared-graph mode** — gate the code-first
   escape hatch to acyclic single-path flows; require declared-graph past that (loops/joins/resume).

Sources: mastra.ai/docs/workflows/*; ai.pydantic.dev + pydantic-ai repo; learn.microsoft.com/agent-
framework/workflows/* + microsoft/autogen; docs.crewai.com + crewAI repo; openai.github.io/openai-
agents-python; google.github.io/adk-docs.

## 13. Minimal engine walkthrough

### 13.1 PocketFlow core (~100 lines) and what it costs

```python
class BaseNode:
    def __init__(self): self.params,self.successors={},{}
    def next(self,node,action="default"): self.successors[action]=node; return node
    def prep(self,shared): pass
    def exec(self,prep_res): pass
    def post(self,shared,prep_res,exec_res): pass
    def _exec(self,prep_res): return self.exec(prep_res)
    def _run(self,shared): p=self.prep(shared); e=self._exec(p); return self.post(shared,p,e)
    def __rshift__(self,other): return self.next(other)             # a >> b
    def __sub__(self,action): return _ConditionalTransition(self,action)  # a - "act" >> b

class Node(BaseNode):                       # adds retry + fallback
    def __init__(self,max_retries=1,wait=0): super().__init__(); self.max_retries,self.wait=max_retries,wait
    def exec_fallback(self,prep_res,exc): raise exc
    def _exec(self,prep_res):
        for self.cur_retry in range(self.max_retries):
            try: return self.exec(prep_res)
            except Exception as e:
                if self.cur_retry==self.max_retries-1: return self.exec_fallback(prep_res,e)
                if self.wait>0: time.sleep(self.wait)

class Flow(BaseNode):                        # the entire "engine"
    def get_next_node(self,curr,action): return curr.successors.get(action or "default")
    def _orch(self,shared,params=None):
        curr,p,last = copy.copy(self.start_node),(params or {**self.params}),None
        while curr:
            curr.set_params(p); last=curr._run(shared); curr=copy.copy(self.get_next_node(curr,last))
        return last
```

Annotations that matter:
- **`successors: dict[str, BaseNode]` keyed by action string is the ENTIRE edge model** — no edge
  objects, no condition callables. Static and "conditional" routing are the *same mechanism*; the
  condition logic lives inside `post()`, which returns the action string.
- **Three-phase lifecycle** `prep → exec → post`: `exec` receives only `prep`'s return, not `shared`,
  deliberately isolating the retryable unit from the store. `post` is the only phase with read/write
  `shared` access and its return is the routing action.
- **The whole engine is `_orch`'s `while curr:` loop.** No graph is built or validated up front.
  `copy.copy(node)` before each run gives reused nodes (loops, shared instances) their own
  `params`/`cur_retry`. `Flow` **is** a `BaseNode`, so nesting is free.

What it lacks (the production gap):

| Missing | Consequence |
|---|---|
| **No checkpointing** — `shared` lives only in process memory | crash mid-flow loses everything; no resume; HITL must be modeled as `post()` ending the flow with the caller storing `shared` externally, zero help |
| **No parallel-join/barrier** — `successors` tracks outgoing only, nothing counts arrivals | `A→C, B→C` join is inexpressible; parallel writes to a `shared` key silently race (no reducer) |
| **No cycle/step bound** — `while curr:` has no `max_steps`/visited-set | `a>>b>>a` runs forever; termination is 100% the node authors' responsibility |
| **No structured error routing** — exceptions kill the flow or are absorbed by `exec_fallback` | no graph-level `on_error` edge |
| **No observability** — no event stream/trace | debugging = adding `print`s |

Only parallelism primitive: `AsyncParallelBatchNode._exec = asyncio.gather(*items)` over one node's
*batch items* — no fan-out across *different* nodes, no join anywhere.

Source: https://raw.githubusercontent.com/The-Pocket/PocketFlow/main/pocketflow/__init__.py

### 13.2 athena-graphs — production-tier reference (closest to graph-bro)

**Core types** (`types.py`):
```python
START="__start__"; END="__end__"
@dataclass
class Command: update: State = field(default_factory=dict); goto: str|list|tuple|None = None
@dataclass
class Interrupt: prompt: str; data: State = field(default_factory=dict); update: State = field(default_factory=dict)
@dataclass
class Checkpoint:
    state: State
    ready: list[str]                       # the frontier — which nodes are about to run
    arrivals: dict[str, list[str]]          # join-barrier bookkeeping, keyed by edge id
    step: int
    history: list[StepTrace] = field(default_factory=list)
```
A node returns one of four shapes: `None` (no-op), a `Mapping` (update via declared edges), a
`Command` (update + `goto` that *overrides* edges for this node this run), or an `Interrupt` (pause +
checkpoint). **`Checkpoint` is exactly the resumability contract** — nothing else is needed to
reconstruct a mid-run graph.

**The runner loop** (`core.py::CompiledGraph._run`), the load-bearing algorithm to steal:
```
state, ready, arrivals, step ← checkpoint fields   # empty / [START] on fresh invoke
while ready is non-empty:
    guard max_steps / max_seconds
    active ← dedupe(ready); step += 1
    snapshot ← frozen copy of state                 # nodes never see each other's writes mid-step
    results ← execute each node in active (ThreadPoolExecutor if >1 and parallel=True)
    bucket results into {interrupted, commanded, on_error-redirected, fatal}
    state ← merge(state, all updates)                # reducers apply here
    if any fatal (no on_error target) → FAIL
    completed ← active minus interrupted
    next_ready, ended ← transitions(completed, state, arrivals, commands)
    if interrupted:
        ready ← unique(interrupted_nodes + next_ready)  # paused nodes re-enter the frontier
        checkpoint.save(state, ready, arrivals, step, history); RETURN "interrupted"
    if ended: checkpoint.delete(); RETURN "completed"
    ready ← next_ready
RETURN "dead_end"   # frontier emptied without reaching END
```
- **`ready` IS the frontier** — no separate queue; recomputed each step by `transitions`.
- **Interrupted nodes go back into `ready`** on resume, which is why `Interrupt`-returning nodes must
  be idempotent (check-then-ask): the same function runs again, sees the answer now in `state`,
  returns a normal update. This is the exact "re-run on resume" contract of §9.4, at node granularity.
- A **"dead_end"** (frontier empties without `END`) is a distinct terminal status from "failed" —
  catches topology-authoring bugs. Six statuses: `running | interrupted | completed | dead_end |
  failed | orphaned`.
- Execution is **thread-based**; file-editing CLI-agent nodes sharing a cwd must run sequentially
  (the engine offers no per-node sandboxing — only "don't put them in the same parallel superstep").

**Routing** (`_transitions`) — joins, conditional edges, dynamic routers coexist in one per-source loop:
```python
for source in completed:
    if (cmd := commands.get(source)) and cmd.goto is not None:
        destinations.extend([cmd.goto] if isinstance(cmd.goto,str) else list(cmd.goto))
        continue                                     # Command.goto wins outright, skips edges/routes
    for edge in self._edges:
        if source not in edge.sources: continue
        if len(edge.sources)==1:                     # plain (possibly conditional) edge
            if edge.condition is None or edge.condition(state): destinations.append(edge.target)
        else:                                        # join: len(sources) > 1
            seen = arrivals.setdefault(edge.key, [])
            if source not in seen: seen.append(source)
            if set(seen)==set(edge.sources):          # ALL arrived
                arrivals[edge.key]=[]                  # RESET the barrier for the next loop pass
                if edge.condition is None or edge.condition(state): destinations.append(edge.target)
    for route in self._routes:                       # dynamic router (add_conditional_edges)
        if route.source==source:
            for item in _route_choices(route.router(state)):
                destinations.append(route.paths[item] if route.paths else item)
```
**A join = a multi-source edge whose barrier `arrivals[edge.key]` resets once full** — the identical
concept to LangGraph's `NamedBarrierValue`, expressed as a plain JSON-serializable
`dict[str, list[str]]` instead of a typed channel class.

**Reducers & conflict** (`_merge`) — loud by default:
```python
for key, values in by_key.items():
    reducer = self._reducers.get(key)
    if reducer is not None:
        current, pending = (merged[key], values) if key in merged else (values[0], values[1:])
        for v in pending: current = reducer(current, v)
        merged[key] = current
    elif len(values)>1 and any(v != values[0] for v in values[1:]):
        raise StateConflictError(f"parallel nodes wrote different values to {key!r}; register a reducer")
    else: merged[key] = values[-1]
```
Built-in named reducers: `append` (`[*l,*r]`), `sum` (`l+r`), `merge` (`{**l,**r}`); any
`(current,new)->merged` callable works via `set_reducer`.

**JSON topology schema** (`spec.py`) — three node kinds:

| kind | fields | behavior |
|---|---|---|
| `agent` | `role`, `system`, `prompt` (`$key` template over flat state), `output_key`, `response` (`text`\|`json`), `merge` (spread JSON into state), `retry` | calls `agent.run(...)`, returns `{output_key: text}` or parsed/merged JSON |
| `human` | `question` (templated), `answer_key`, `data_keys` | if `answer_key not in state` → `interrupt(question, data=...)`; else `{f"{id}_completed": True}` — the idempotency trick |
| `set` | `update` (templated string values, others literal) | deterministic state write, no model call |

Edge `when` grammar (a small recursive DSL — serializable, survives a restart):
```
rule := {"all":[rule,...]} | {"any":[rule,...]} | {"not":rule}
      | {"key":<dotted.path>, "exists":bool}
      | {"key":..., "equals":v} | {"key":..., "not_equals":v}
      | {"key":..., "truthy":true} | {"key":..., "falsy":true} | {"key":..., "contains":v}
```
`from` as a **list** = join (rejects `START` among join sources, `END` as any source). `max_steps`
(default 100) is the loop guard. `build_topology` compiles the graph **during validation** so a
malformed topology never gets a run id.

**Run directory + MCP control plane** (`runs.py`):
```
~/.athena-graphs/runs/<YYYYmmdd-HHMMSS>-<uuid8>/
  request.json     status.json     events.jsonl     checkpoints/     result.json
```
`start()` validates synchronously, decides `effective_parallel` (False when a cwd is set AND the
backend is a CLI-coding-agent), launches on a **daemon thread**, returns immediately. `status()`
self-heals ("orphaned" if `owner_pid` isn't this process). `tail(cursor, limit)` pages `events.jsonl`.
`resume(answers)` only proceeds if `status=="interrupted"`, merges answers into the checkpoint,
re-enters `_run`. Nine MCP tools: `graph_{start,status,tail,resume,result,diagram,validate,list}` +
`list_backends`/`doctor`. **The MCP call never blocks for the run's duration.**

Sources: https://github.com/luckeyfaraday/athena-graphs — `plugins/athena-graphs/agentgraph/
{core,types,spec,checkpoint,runs,agent}.py` + `references/{graph-spec,mcp-tools}.md` + `examples/
{branching,human_review}.py`.

### 13.3 Two scheduling models

**Kahn's algorithm (pure DAGs, no cycles):**
```
indegree[n] ← incoming edge count; ready ← {n : indegree[n]==0}
visited = 0
while ready:
    layer ← drain ready; run all in parallel (safe: none depends on another in layer)
    for n in layer:
        visited += 1; state = merge(state, results[n])
        for edge (n→m): indegree[m] -= 1; if indegree[m]==0: ready.add(m)
if visited < total_nodes: raise CycleDetectedError   # cycle detection is a free side effect
```
Joins are trivial (`indegree[m]=2`, becomes ready when both decrement it). **Breaks the moment you
add a back-edge** — a loop target's indegree can never be satisfied by a single topological pass. This
is why athena-graphs/LangGraph don't use indegree counting.

**Message/channel-driven activation (cyclic graphs):**
```
channels ← {}; frontier ← {START} (or the resumed checkpoint's `ready`); step ← 0
while frontier:
    guard max_steps; step += 1
    active ← dedupe(frontier); snapshot ← frozen state
    results ← run each node in active (isolated snapshot)
    for (key,value) in all writes: channels[key].update([value])
    frontier ← {}
    for node n subscribing to channel k:
        if channels[k].is_available():
            frontier.add(n)
            if channels[k].consumes_on_read: channels[k].consume()   # reset barrier for next pass
    if END reached: RETURN "completed"
RETURN "dead_end"
```
The reframing: stop asking "has every predecessor ever run" (indegree, can't reset) and ask "did a
channel node X subscribes to receive a *new* message since X's last run." **Barriers can reset** — a
`NamedBarrierValue`'s `seen` set clears on `consume()`, so the same join fires again on a second loop
pass. Activation is data-driven, not structure-driven; termination is a designed condition
(`END`/empty frontier), never a proof about graph shape — so `max_steps` is mandatory as a second
line of defense in *both* models.

**`NamedBarrierValue` source** (the whole persisted state is just `seen`):
```python
class NamedBarrierValue(Generic[Value], BaseChannel[Value, Value, set[Value]]):
    __slots__ = ("names", "seen")
    def __init__(self, typ, names): super().__init__(typ); self.names = names; self.seen = set()
    def update(self, values):
        updated = False
        for v in values:
            if v in self.names:
                if v not in self.seen: self.seen.add(v); updated = True
            else: raise InvalidUpdateError(f"At key '{self.key}': Value {v} not in {self.names}")
        return updated
    def get(self):
        if self.seen != self.names: raise EmptyChannelError()
        return None
    def is_available(self): return self.seen == self.names
    def consume(self):
        if self.seen == self.names: self.seen = set(); return True   # <-- reset makes it reusable
        return False
    def checkpoint(self): return self.seen                            # trivially serializable
    def from_checkpoint(self, checkpoint):
        empty = self.__class__(self.typ, self.names); empty.key = self.key
        if checkpoint is not MISSING: empty.seen = checkpoint
        return empty
```
Both LangGraph's typed `NamedBarrierValue.seen` and athena-graphs' bare `arrivals[edge.key]` list
converge on the same truth: **a join's durable state is just which predecessors have reported since
the last reset.**

Practical guidance: use Kahn/indegree only if the graph is provably acyclic (free cycle detection,
no channels needed); the moment any edge can fire twice, use the resettable-barrier model — a plain
`dict[edge_id, set[source_id]]` you `.clear()` on satisfaction is a complete `NamedBarrierValue`
replacement (~15 lines, athena-graphs' `_transitions` is the proof).

Source: https://github.com/langchain-ai/langgraph/blob/main/libs/langgraph/langgraph/channels/named_barrier_value.py

### 13.4 The CLI-agent node executor: subprocess contract, output capture, streaming, kill, heartbeat

§13.2 walks athena-graphs' *graph* runtime; this walks the *node executor* underneath it — the seam
where a node's "work" is a headless CLI coding agent (`claude -p`, `codex exec`, `opencode run`)
instead of an in-process function. Everything below is grounded in athena-graphs source and in live
runs against `claude` v2.1.218 / `codex-cli` 0.142.5 on the research machine, 2026-07-23.

**The subprocess-result → graph-state bridge is four lines.** athena's `AgentNode.__call__`
(`agent.py`) templates the prompt from state, calls `agent.run(AgentRequest(...))`, optionally parses,
optionally wraps in `{output_key: value}`. `AgentResponse.text` — a single decoded string returned
synchronously — *is* the value that lands in state. There is no intermediate representation.
**Gotcha:** the topology's `response: "json"` field does **not** tell the CLI to emit JSON — it only
selects a post-hoc `extract_json` parser over whatever text the tool printed. `expects_json` is
accepted on `AgentRequest` but **never read by `CliAgent`**; only the API backend (`ClaudeAgent`) uses
it. To actually constrain a CLI backend's output you must wire the instruction/flag into that
backend's command template yourself — it is not automatic.

**Prompt delivery is a static, compile-time property of the command template.** `CliAgent`'s rule: if
the templated command contains a literal `{prompt}` or `{combined}` token, the prompt is substituted
into `argv` and stdin is closed (`subprocess.DEVNULL`); otherwise the whole `{system}\n\n{prompt}`
combined string is piped on stdin and the CLI gets no prompt argument. `shutil.which(argv[0])` resolves
the binary once and rewrites `argv[0]` to its absolute path (robust against a stripped `PATH` under a
process manager). Copy this verbatim — it is simple and correct.

**Per-backend argv + output-capture contract (the actual reference):**

| Backend | `command` list | Prompt | Output parsing |
|---|---|---|---|
| `claude_code` | `["claude","-p","{prompt}","--append-system-prompt","{system}","--output-format","json"]` (+ `--model`, `--dangerously-skip-permissions`) | arg | `_parse_claude_json` → `data["result"]`, raises on `data["is_error"]` |
| `codex` | `["codex","exec"]` (+ `--dangerously-bypass-approvals-and-sandbox`) + `{combined}` | arg | **none** — raw stripped stdout |
| `opencode` | `["opencode","run","--print-logs"]` (+ `--dangerously-skip-permissions`) + `{combined}` | arg | **none** — raw stripped stdout |
| `aider` | `["aider","--message","{combined}","--no-auto-commits","--yes-always"｜"--yes"]` | arg | **none** |
| `grok_build` | `["grok","--no-auto-update","-p","{combined}","--output-format","plain","--no-alt-screen"]` (+ `--always-approve`, `-m`) | arg | **none** |

**Only `claude_code` gets a structured output envelope in the reference.** The other four capture raw
`.strip()`ped stdout with no JSON, no `-o`/`--output-last-message` file for Codex (which supports one),
no `--format json` for OpenCode (which supports one) — athena took the cheap path everywhere except
Claude Code. graph-bro should decide per-backend whether to invest in structured-output flags; at
minimum, upgrade Codex to `-o <file>` + `--output-schema <file>` and OpenCode to `--format json`
(the latter needs its own live-verification pass — opencode was not installed on the research machine).

**Claude Code `--output-format json`** (live-verified) emits one object with `is_error` (bool),
`result` (the text), `subtype`, `session_id` (for `--resume`/`--continue` multi-turn nodes),
`total_cost_usd`/`usage` (per-node cost accounting), `duration_ms`/`duration_api_ms` (a free "how long
did this node take" signal), `num_turns`. **On error it still writes valid JSON to stdout with exit
code 1.** This exposes a bug in athena to *not* copy: `CliAgent.run` checks `returncode != 0` **before**
parsing, so an error response's structured `result`/`is_error` fields are discarded in favor of a
truncated raw-text error. **Fix: when `--output-format json` was requested, attempt `json.loads(stdout)`
first and honor `is_error`; fall back to raw stdout/stderr only if that parse fails** — do not let a
non-zero exit short-circuit past the structured error body.

**Streaming: the reference does not stream at all.** `CliAgent.run` is a single blocking
`subprocess.run(capture_output=True, timeout=...)`; `events.jsonl` receives only graph-level events
(`node_started`/`node_finished`, emitted once per node by the engine), never anything from the child's
stdout mid-run. A `events.jsonl` built the same way shows a node "start," then multi-minute silence,
then "finish" with the full output — acceptable for a v0, but exactly the observability gap. To get
incremental events, switch from `subprocess.run` to `asyncio.create_subprocess_exec` and pump NDJSON
stdout (`claude -p --output-format stream-json --verbose --include-partial-messages` /
`codex exec --json`) line-by-line, appending each parsed event to `events.jsonl` as a second event
producer alongside the graph-level events:

```python
async def run_streaming_node(argv, *, cwd, on_event, timeout, heartbeat_interval=15.0):
    proc = await asyncio.create_subprocess_exec(
        *argv, cwd=cwd, stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        start_new_session=True)                          # own process group — see §14.7
    last_line_at = time.monotonic(); result_line = None
    deadline = time.monotonic() + timeout

    async def pump_stdout():
        nonlocal last_line_at, result_line
        async for raw in proc.stdout:
            last_line_at = time.monotonic()
            line = raw.decode().strip()
            if not line: continue
            try: event = json.loads(line)
            except json.JSONDecodeError: continue        # tolerate stray non-JSON lines
            on_event(event)                               # <-- the events.jsonl append (gap: the bridge)
            if event.get("type") == "result":            # claude terminal marker
                result_line = event
            elif event.get("type") == "item.completed" and \
                 event.get("item", {}).get("type") == "agent_message":  # codex terminal marker
                result_line = event

    async def watchdog():                                 # heartbeat + hard-timeout (§11.3)
        while proc.returncode is None:
            await asyncio.sleep(1)
            idle = time.monotonic() - last_line_at
            if idle > heartbeat_interval:
                on_event({"type": "heartbeat", "idle_seconds": idle, "pid": proc.pid})
            if time.monotonic() > deadline:
                raise TimeoutError(f"node exceeded {timeout}s wall clock")
    try:
        await asyncio.wait_for(asyncio.gather(pump_stdout(), watchdog()), timeout=timeout)
    finally:
        await _kill_process_group(proc)                   # §14.7 — always, even on success
    return result_line or {"type": "error", "message": "no result event before EOF"}
```

Backend terminal-event detection is the "how do I know I'm done" knowledge, per-backend: Claude Code's
last NDJSON line is **always** `type=="result"` (same shape as the blocking `--output-format json`
object, so a streaming reader reuses the blocking parser); Codex has **no** guaranteed-last rule — you
must scan for `item.completed` with `item.type=="agent_message"` (a `turn.completed` line follows it
with only usage stats, no text). **Codex field-name gotcha:** the item discriminator is `type` in the
current Rust source (`exec_events.rs`) and in live capture, but older docs/PRs show `item_type` — parse
defensively (`item.get("type") or item.get("item_type")`). Other stream-json footguns: `stream-json`
**requires `--verbose`**; some Claude Code releases require `--verbose` *before* `--output-format
stream-json` and `--print` always present (SDK issue #60) — put `--print --verbose` first
unconditionally; piped stdin is capped at 10 MB (write large context to a file, reference its path);
read stdout promptly (the CLI waits up to 30s for a slow consumer to drain, but do not buffer-and-batch).

**Non-streaming backends have no intermediate signal at all** — the only heartbeat possible is an
external supervisor polling `psutil.Process(pid).cpu_times()`/`.io_counters()` and flagging "0% CPU,
no I/O for N seconds." This is exactly the shape of a headless agent stuck on a permission prompt it
can never receive: **`--dangerously-skip-permissions` / `--dangerously-bypass-approvals-and-sandbox`
/ `--always-approve` is not merely a convenience — for a node with no heartbeat, omitting it is a
silent-hang risk**, since the prompt goes to a TTY graph-bro isn't attached to and the process waits
forever with zero further stdout, zero CPU, and no signal until the hard timeout eventually fires.

Sources: athena-graphs `main` (`agent.py`, `adapters/cli.py`, `runs.py`, `core.py`, `spec.py`,
`factory.py`), fetched 2026-07-23; `https://code.claude.com/docs/en/headless.md`;
`codex exec --help` (live), `https://learn.chatgpt.com/docs/non-interactive-mode`,
`https://github.com/openai/codex/blob/d807d44a/codex-rs/exec/src/exec_events.rs`,
`https://github.com/openai/codex/pull/4525`; `https://opencode.ai/docs/cli/`;
`https://github.com/anthropics/claude-agent-sdk-typescript/issues/60`; live shell runs of `claude -p`
and `codex exec` on the research machine (`claude` v2.1.218, `codex-cli` 0.142.5), 2026-07-23.

## 14. Pitfalls & failure modes

Ten failure modes, each with the scenario, how Pregel handles it (with test names/source), and the
design implication for a from-scratch engine.

### 14.1 Unequal-length parallel branches at a join
`rewrite → analyzer → retriever_one` (2 hops) and `rewrite → retriever_two` (1 hop) both feed
`add_edge([retriever_one, retriever_two], qa)`. If you schedule on "any predecessor produced output"
instead of "all *declared* predecessors did," `qa` runs with partial input or twice. Pregel activates
`qa` only when **all N static in-edges have written** (barrier count), tested by
`test_in_one_fan_out_state_graph_waiting_edge`. **Adjacent trap:** a predecessor behind a conditional
edge that *doesn't* fire → the join never triggers and the workflow hangs — independently hit by
Microsoft agent-framework (#2157) and Google ADK's `JoinNode` docs. **Implication:** a join's
predicate must be over the *static* in-edges, and every declared join source must be reached by every
possible resolution of every router upstream of it. The "tombstone" is **not** a sentinel value
written into the channel from outside (no barrier mechanism surveyed can invent a write nobody
produced — §14.9) — it is a topology discipline: route an optional branch through a mandatory
pass-through funnel node and declare the *funnel* as the join source. §14.9 specifies the mechanism.

### 14.2 Interrupt vs real exception inside a parallel branch
`GraphInterrupt` is a `GraphBubbleUp` — it **does not cancel siblings**; the other branches run to
completion (or their own interrupt) before the super-step commits and the run pauses. A **real
exception** is fail-fast: `_should_stop_others` / `asyncio.wait(..., FIRST_COMPLETED)` cancels every
in-flight sibling. **Implication:** your engine needs two categorically different signals from a node:
"pause" (bubble-up, no sibling cancel, checkpoint-and-park) vs "failure" (fail-fast, cancel siblings).
Collapsing them either kills a sibling's expensive LLM call on every human review, or burns budget
letting a real error's siblings finish. Multiple simultaneous interrupts need collision-free ids and
an explicit `{id: value}` resume map (LangGraph shipped bugs here: #4028, #5952, #6626 — parallel
tool interrupts hashed to identical ids until an index was added to the hash).

### 14.3 Non-idempotent side effects re-running after resume
The contract (§9.4): the interrupted/crashed node re-runs from the top of its function; code before
`interrupt()` runs again. This is "the contract," not a bug (confirmed repeatedly on the forum). A
node that writes a DB row / sends an email *before* `interrupt()` duplicates it on every resume.
**There is no supported "am I resuming?" flag** — the internal `CONFIG_KEY_RESUMING` also fires on
ordinary retries, conflating two reasons for re-entry. **Sanctioned fixes:** split the node (setup in
a predecessor, `interrupt()` alone in its successor — only the pausing node re-runs); or a state
marker no-op on the second pass; or push side effects *after* `interrupt()`. A subtler variant
(#7361): `Command(resume=...)` against a `checkpoint_id` was ambiguous with time-travel *replay*
until a fix — a genuine resume silently re-executed already-completed tasks. **Implication:** treat
"replay from checkpoint N" and "resume a pending interrupt" as **structurally distinct API
operations**, never inferred from "a checkpoint id is present"; steer users to split-node/state-marker
patterns rather than exposing a resume flag.

### 14.4 Checkpoint bloat in long loops
An append-only reducer (`add_messages`) stores the **entire accumulated list** every super-step —
O(n²) total storage. Separate three axes: (1) what the *LLM* sees — bounded by summarization/trim
(`RemoveMessage`); (2) what a *checkpoint* stores — bounded by delta/incremental channels (`DeltaChannel`,
O(n²)→O(n)); (3) what stays on *disk* — bounded only by TTL/prune (nothing else frees bytes;
`checkpoint_blobs` persist forever otherwise). A real regression (`deepagents#2876`): moving trim from
`before_model` (emitted the tombstone) to `wrap_model_call` (only a pointer) kept the model window
bounded but grew checkpoint state unboundedly. Gotcha: `DeltaChannel`'s reducer doesn't support
`REMOVE_ALL_MESSAGES` — use a single `Overwrite(new_list)` as the reset base. **Implication:** design
these three concerns explicitly and separately; a prune pass must be delta-chain-aware (never delete a
write row a surviving checkpoint's delta channel depends on without first forcing a snapshot).

### 14.5 Recursion-limit exhaustion mid-loop
`recursion_limit` (default 25) counts **super-steps**, not tool calls — under fan-out these diverge.
`RemainingSteps` is the graceful-degradation signal. Real bug (#5548): the prebuilt ReAct agent's
`_are_more_steps_needed` fires *before* `GraphRecursionError` would, so it silently emits "need more
steps" and stops **without raising** — breaking callers that catch the exception. `RemainingSteps`
resets per subgraph (nested graphs each get 25). Platform deployments silently reset a compiled
override to 25 unless passed per-invocation. **Implication:** document loudly what the limit counts;
provide both a hard limit and a soft budget, but be explicit whether the soft path *ever* suppresses
the hard exception (silent suppression breaks callers); decide and test whether subgraph budgets are
shared or independent.

### 14.6 State-schema evolution breaking old checkpoints
LangGraph applies the **latest** deployed code to every thread (not the code the run started under):
*"every change you ship is effectively a backward-compatible API change with respect to your existing
checkpoints."*

| Change | Safe? | Failure if unsafe |
|---|---|---|
| Add field with default / `NotRequired` | Safe | — |
| Remove unused field | Safe | old data ignored |
| Rename field | **Unsafe** | data orphaned, new field gets default (silent loss) |
| Tighten type / Optional→required | **Unsafe** | deserialization/type error on load |
| Add required field no default | **Unsafe** | old checkpoints error on load |
| Rename/remove a **node a thread is parked at** | **Unsafe** | nowhere to resume — hard failure |

**Asymmetry:** edge topology is *not* persisted — adding/removing/rerouting edges between existing
nodes is safe for in-flight threads. Only renaming/removing a *node a thread is parked at* is
dangerous. **Implication:** key resumption strictly off **node name + channel schema, never off edge
structure**; never fail a schema change *silently* (prefer loud errors over "field gets default and
appears to work"); stamp a `flow_version` on state at thread *start* for business-logic versioning;
build a migration layer (version tag in checkpoint *metadata*, not app state).

### 14.7 Cancellation propagation to subprocess/async nodes
`TimeoutPolicy` is built entirely on `asyncio` cancellation: *"If your node uses synchronous
`time.sleep()` or CPU-bound work, the timeout will not fire until the event loop is released."* **Sync
nodes are rejected a timeout at compile time.** On timeout the runner clears buffered `task.writes`
(so a timed-out attempt's partial writes never leak into a retry) and `.cancel()`s the asyncio task —
but **child tasks already scheduled before the timeout still complete** (intentional, tested). So a
timeout stops the *node*, not necessarily the *external work* it started: a subprocess-backed node
(`claude -p`) needs its own code to plumb cancellation through to the OS process. LangGraph exposes
`CONFIG_KEY_TIMED_ATTEMPT_OBSERVER` so an external supervisor can compute a kill deadline. **Implication
for subprocess-node engines:** cancellation is a first-class contract at the subprocess boundary —
hold the `Popen` handle in a scope the cancel handler reaches and explicitly SIGTERM→SIGKILL in a
`finally`; clear partial writes on a cancelled attempt; expose an external watchdog for hung
in-process cancellation. Distinguish framework-initiated cancellation (sibling failed → silent
teardown) from a node's self-raised `CancelledError` (→ `NodeCancelledError`, a reportable failure).

**The reference's kill story is weaker than this and must not be copied.** athena-graphs uses
`subprocess.run(argv, timeout=..., capture_output=True)`; on `TimeoutExpired`, CPython's
`subprocess.run` calls `process.kill()` (SIGKILL) on the **immediate child only** — it cannot reach
grandchildren the CLI agent spawned (MCP servers, sandboxed helpers, `git`, linters), which become
orphans that outlive the "timed out" error. There is no `start_new_session=True`, no process group,
no `os.killpg` anywhere in athena. **The fix — process-group kill:**
```python
async def _kill_process_group(proc, grace=5.0):
    if proc.returncode is not None: return
    pgid = os.getpgid(proc.pid)              # valid because spawned with start_new_session=True
    try: os.killpg(pgid, signal.SIGTERM)     # graceful: the CLI and every child it forked
    except ProcessLookupError: return
    try: await asyncio.wait_for(proc.wait(), timeout=grace)
    except asyncio.TimeoutError:
        try: os.killpg(pgid, signal.SIGKILL)  # escalate: unignorable
        except ProcessLookupError: pass
        await proc.wait()
```
`start_new_session=True` makes the child a process-group leader (`proc.pid == pgid`), so `os.killpg`
reaches every descendant, not just the direct child — two levels (SIGTERM to let a well-behaved CLI
flush partial diffs, SIGKILL only after the grace period). This also sidesteps CPython issue #119710
(still open): `Process.wait()`/`communicate()` can block until stdout is **closed**, not just until
the process exits, so a grandchild holding the inherited stdout pipe can hang `wait()` even after the
direct child is dead — killing the whole group closes that fd. Do not rely on single-process
`proc.kill()` + a bare `await proc.wait()` as the only cleanup path. Run `_kill_process_group` in a
`finally` **even on the success path**, to reap any child the CLI itself leaked (§13.4). (Windows has
no real signals — `terminate()`/`kill()` both map to `TerminateProcess`, and groups need
`CREATE_NEW_PROCESS_GROUP` + `CTRL_BREAK_EVENT`; flag if cross-platform is a goal.) Sources:
`docs.python.org/3/library/asyncio-subprocess.html`, `github.com/python/cpython/issues/119710`
(fetched 2026-07-23).

### 14.8 Error in one fan-out branch — fail-fast vs collect-errors
Default is **strict fail-fast, transactional per super-step**: *"if any branch raises, none of the
updates are applied to state (the entire superstep errors)."* But *"none applied to state"* does not
mean the successful sibling's work is lost — **per-task pending writes** are durable independently
(§8.5). `test_pending_writes_resume` asserts: `one.calls==1, two.calls==2` (a succeeded sibling is
**not** re-run when a failing sibling retries); `get_state().values=={"value":3}, .next==("two",)`;
resume completes to `{"value":6}` without re-running `one`. Layered on top: `RetryPolicy` (retries
only the failed branch), `error_handler` (runs after retries exhausted, atomically),
`ToolNode(handle_tool_errors=...)` (collect-errors at one tool's granularity, feeds an error
`ToolMessage` back to the LLM). **Implication:** fail-fast-per-superstep is the right default, but you
need two escape hatches: durable per-task writes (the single most load-bearing correctness property
to test — a succeeded sibling never redone) and a node/fan-out-level "collect all outcomes incl.
errors into the join" policy (for adversarial-reviewer/voting patterns).

### 14.9 Deadlocks from mis-declared join dependencies
A recurring cross-engine bug class: a join's static "how many predecessors do I wait for" count
desyncs from "how many will actually run." Netflix Conductor (`#1957`) — dynamic fork/join stuck
`IN_PROGRESS` after a retry-after-failure never re-invokes the join's terminal check. StackStorm
Orquesta (`#212`) — nested-workflow join `UnreachableJoinError`, parent spins `running` for 19+ hours.
Argo/Metaflow (`#3002`) — the opposite: a join fired *before* all true predecessors (bad `depends`
generation through a conditional split). **Common thread:** the activation condition is computed once
at compile from static topology, but the runtime path (retries, nested forks, conditional skips)
diverges and nothing re-derives it.

**The mechanism, confirmed by source: no engine surveyed recomputes join reachability at runtime.**
LangGraph's `NamedBarrierValue.names` (frozen `set(starts)`, §13.3) and athena-graphs' `edge.sources`
(frozen `tuple`, §13.2) are both immutable post-compile; a name enters `seen`/`arrivals` **only if the
literal source node actually runs** (its writer fires), and `update()` *raises* on a name not in the
frozen set — so no other node can write a missing name from outside. A conditionally-skipped
predecessor is therefore unrescuable by any in-channel mechanism. Neither engine even rejects the
topology at compile time; it silently compiles and manifests at runtime (in athena, as a distinct
`"dead_end"` terminal status if the frontier empties, or wasted `max_steps` budget if other activity
keeps the frontier live — with no indication of *which* join was the culprit). Three independently
built engines converge on the identical choice and the identical prescribed workaround: Microsoft
agent-framework #2157 (maintainer: "This is by design... [it] will only run when it receives messages
from all executors"; the filer's ask for a "source completed without output" signal is unanswered),
Google ADK's `JoinNode` docs ("All static predecessors... must execute and complete... Make sure to
include failsafe output from any node that outputs to a `JoinNode`").

**The actual fix — convert the optional predecessor into a mandatory funnel node** (verbatim from
LangGraph maintainer `vbarda`, issue #954): every mutually-exclusive conditional destination routes
through one pass-through "sink" node, and the **funnel — not the original conditional targets — is
declared as the join's static source.**
```python
workflow.add_edge("agent_2_2", "agent_2_4")        # both mutually-exclusive conditional
workflow.add_edge("agent_2_3", "agent_2_4")        # outcomes converge on the funnel
workflow.add_edge(["agent_2_4", "agent_3"], "agent_4")   # join declares the FUNNEL, not agent_2_2/2_3
```
It is airtight because the funnel's own inbound trigger is a `guard=False` `EphemeralValue` (§7.6) —
it accepts a write from any *one* of several possible upstream writers without erroring, so "reached
via d1 OR d2, never both" resolves to exactly one funnel execution per pass. The "tombstone" is not a
value flowing through state; it is simply *the funnel running at all*, guaranteed by construction. Put
differently: **you cannot make an optional write satisfy a barrier; you can only make the write
mandatory by moving the barrier's attachment point downstream of every branch that could produce it.**
The maintainer explicitly rejects the naive alternative (`add_edge([agent_2_2, agent_2_3, agent_3],
agent_4)`) — "this is saying agent_4 needs data from *all* nodes, but... we only ever run either
agent_2_2 or agent_2_3." The pattern composes with athena-graphs identically (insert a cheap
deterministic `set`-kind node as the funnel, make it the literal join source in the topology JSON).

**A cheaper escape hatch — model runtime-determined arity as dynamic fan-out, not a static join.**
The map-reduce shape (§9.3) sidesteps this whole bug class *structurally*: `add_edge("generate_joke",
"best_joke")` is a plain single-source edge, yet `best_joke` correctly waits for all N
dynamically-`Send`-spawned tasks because the barrier is the **super-step boundary itself** (PUSH tasks
execute one step after the `Send`s that create them; `best_joke` becomes eligible only in the following
step, by which point every PUSH task has completed and folded into the reducer). There is no "expected
N, got N-1" desync possible because there is no separately-declared expected N — the dispatcher and the
join arity are the same runtime event. **Design rule:** if a join's "which predecessors ran" is decided
by a single upstream router, prefer dynamic fan-out (dispatcher emits 0..k sends, one single-source
trigger downstream, no barrier bookkeeping); reserve the funnel pattern for genuinely independent static
branches each with their own conditional logic.

**The harder alternative — recompute the required-predecessor set as conditionals resolve — is
unimplemented anywhere surveyed and higher-risk.** Argo/Metaflow (#3002) attempts exactly this and gets
it wrong in the *opposite* direction (fires a join *before* all true predecessors — silent data loss,
arguably worse than a loud stall). Correctly computing "given this routing decision, which of J's
sources are now provably impossible" is a fixed-point reachability analysis, not a single BFS, the
moment two or more routers jointly determine reachability into one join. **Do not build this for the
first cut** — the funnel discipline is O(1) (pure topology construction using primitives graph-bro
already needs) and provably correct by the same argument LangGraph/athena-graphs/ADK rely on.

**Implication for graph-bro:** (1) keep the resettable-barrier mechanics as-is (the bug is in the
topology feeding the barrier, not the barrier); (2) add a **compile-time lint** neither reference
engine has — when a join's declared source `s` is also a non-exhaustive destination of some router,
warn ("join `{target}` requires `{s}`, but `{s}` is only conditionally reached via `{router}`; insert
a funnel node") — cheap since it only walks the router's declared `paths`, and a warning (not a hard
error) tolerates always-both-fire routers like §14.1's test case; (3) add a **runtime join watchdog**
(the timeout-then-diagnose net): track super-steps since each join last made progress, and if that
exceeds a small threshold while the run is otherwise still live, raise a loud `UnreachableJoinError`
naming the stalled join and which declared sources have not reported — instead of silently consuming
`max_steps` or (Argo-style) firing early; (4) document the funnel / dynamic-fan-out authoring rules
explicitly, since every engine surveyed pushes this to the graph author, not the scheduler.

Additional sources (fetched 2026-07-23): LangGraph issue #954 (funnel/sink pattern, maintainer
`vbarda`) https://github.com/langchain-ai/langgraph/issues/954 ; `test_pregel.py::test_in_one_fan_out_
state_graph_waiting_edge_multiple_cond_edge` (the always-both-fire non-counterexample);
MS agent-framework #2157 https://github.com/microsoft/agent-framework/issues/2157 and #2156;
Google ADK `JoinNode` docs https://github.com/google/adk-python/blob/4d8fbf71/docs/guides/workflow/join_node/index.md
and graph routes how-to ("failsafe output") https://github.com/google/adk-docs/blob/main/docs/graphs/routes.md ;
athena-graphs `core.py` `_transitions:511`, `_validate:229-256`.

### 14.10 Concurrent runs on the same thread_id
(a) **"Double texting"** — a second invocation on the same `thread_id` before the first finishes reads
the first's in-flight state (e.g. `AIMessage` with pending `tool_calls` and no matching `ToolMessage`
yet → `ValueError`). (b) **Cross-thread contamination masquerading as an engine bug** — a documented
case traced one tenant's data appearing in another's response to an **LLM-provider prompt-cache
collision** sharing an API key, *not* the checkpointer (whose per-thread transactional isolation was
verified first). Also: invoking an existing thread with a *different* initial state does **not** reset
it — saved state wins, new input is merged/ignored. **Implication:** treat "is another run active on
this thread_id" as a first-class question (explicit lock/lease, or documented last-write-wins — never
an emergent race); rule out your own persistence isolation *before* blaming the engine for
cross-run contamination; never silently ignore a new initial-state input on a resuming thread.

Sources: LangGraph docs/forum/issues (#1957 Conductor, #212 Orquesta, #3002 Metaflow, #4028, #5548,
#5952, #6626, #7361, #2876 deepagents, discussions #3147/#5166/#2040), MS agent-framework #2157, ADK
JoinNode docs, `libs/langgraph/tests/test_pregel.py`, Camunda/Zeebe & DBOS testing blogs.

## 15. Test checklist

LangGraph's own suite parametrizes every correctness test across **all** checkpointer backends
(`conftest_checkpointer.py`, memory/SQLite/Postgres/Redis) — a single test body runs against each
storage impl, catching backend-specific bugs. Steal that fixture pattern. Three reusable techniques:
(1) property tests over random DAGs (six invariants: dependency order, completeness, failure
propagation, parallelism bound, resume idempotence, priority sanity — "acyclic by construction" via
`edges only i→j with i<j`); (2) crash-injection sweep (kill at *every* super-step boundary, resume,
assert byte-identical final state + no completed node re-executes + locks released on
mid-critical-section crash — DBOS's leaked-condition-variable bug shape); (3) replay-determinism
(Camunda's `ReplayStateRandomizedPropertyTest`: random topology, random path, after every step stop +
replay-only-restart + diff state — beware leftover scheduled commands leaking into the replay).

**Scheduling / topology**
- [ ] A join with N static predecessors fires exactly once after all N wrote, regardless of path length.
- [ ] A join with a conditionally-skipped predecessor is caught by the compile-time funnel lint
      (join source is a non-exhaustive router destination → warning), and at runtime the join
      watchdog raises a loud `UnreachableJoinError` naming the stalled join + unreported sources
      rather than hanging or silently burning `max_steps` (§14.9).
- [ ] The funnel-node pattern satisfies the join: two mutually-exclusive conditional branches route
      through one pass-through node declared as the join source → join fires exactly once whichever
      branch ran (§14.9).
- [ ] An always-both-fire router feeding a static join does **not** trip the funnel lint into a hard
      error (warning-only tolerates it — the §14.1 non-counterexample).
- [ ] Random-DAG property suite, ≥25 seeds each.
- [ ] Golden-file snapshot of compiled topology (nodes, edges, join barriers, reducer assignments).

**Parallel execution**
- [ ] A real exception in one branch cancels in-flight siblings AND the super-step's state update is
      atomic (no partial-branch writes land).
- [ ] A succeeded sibling's per-task write survives a failing sibling and is **not** re-executed on
      resume (assert call counts, not just final state — `test_pending_writes_resume` equivalent).
- [ ] A pause/interrupt in one branch does **not** cancel siblings.
- [ ] Multiple simultaneous interrupts get collision-free ids; resume requires `{id: value}` map.
- [ ] Concurrent writes to an unreduced key raise a loud typed error at merge time.

**Checkpoint / resume**
- [ ] Checkpoint equivalence: resuming from *every* super-step boundary → state identical to an
      uninterrupted run.
- [ ] Crash-injection sweep (no completed node re-runs; locks released on mid-critical-section crash).
- [ ] A naive single-node pattern with pre-pause side effects *does* double-execute — test the gap
      explicitly so it's documented, not assumed away.
- [ ] Replay and resume are distinguishable API operations (resuming a pause never falls into a
      "replay from scratch" path merely because a checkpoint id is present).

**Loops / recursion**
- [ ] Recursion limit enforced at exactly the configured count (off-by-one both directions); the unit
      counted (super-step vs node vs tool call) is explicit and tested under fan-out.
- [ ] A soft budget never silently suppresses the hard limit's exception (the ReAct #5548 regression).
- [ ] Subgraph recursion budgets: tested as shared or independent, matching documented behavior.

**Schema evolution**
- [ ] Old checkpoints load after add-optional / remove-unused; **fail loudly** after rename /
      tighten-type / add-required-no-default.
- [ ] A thread parked at a later-renamed/removed node fails to resume with a clear error, never a
      silent misroute.
- [ ] A migration round-trip: write under v1, migrate, read under v2, confirm integrity.

**Cancellation / subprocess nodes**
- [ ] Cancelling/timing-out a subprocess node actually terminates the child process **and its
      grandchildren** (spawn a child that forks a SIGTERM-ignoring grandchild; confirm process-group
      SIGTERM→SIGKILL escalation reaps both — the orphan case athena's single-process kill misses, §14.7).
- [ ] Partial writes from a cancelled attempt are cleared, never leaked into a successful retry.
- [ ] Framework-initiated vs self-raised cancellation are distinguishable in error reporting.
- [ ] A streaming backend's NDJSON events are appended to `events.jsonl` incrementally *while the node
      runs*, and the terminal event is detected per-backend (Claude `type=="result"`, Codex
      `item.completed`+`agent_message`) — not just one final line after the process exits (§13.4).
- [ ] A Claude Code error response (exit 1 but valid JSON on stdout) is parsed via `is_error`/`result`,
      not discarded by a non-zero-exit short-circuit (§13.4 / §13.2 bug).
- [ ] Soft `heartbeat_interval` (no stdout event for N s → warning event) fires independently of the
      hard `timeout` (kill) — a node doing a long tool call is not false-positive-killed (§11.3).

**Idempotent side effects (ledger, §11.5)**
- [ ] Retrying a node after its `git push` succeeded but a later line threw: the push is **not**
      repeated (ledger `done` hit, zero git calls) and the node proceeds past it.
- [ ] Kill the process between `perform()` returning and `mark_done()` committing, then resume:
      `reconcile()` runs exactly once and the cached/queried result is used — no second push/PR fires.
- [ ] Two effects under one `task_id` (push, then PR-open): crash after the first `mark_done`, before
      the second's reservation → resume skips the first (found `done`), executes only the second, in order.
- [ ] A row already `done` with result R1; a buggy retry computes R2 ≠ R1 for the same
      `(task_id, effect_key)` → loud typed error, never a silent overwrite (mirrors `DBOSWorkflowConflictError`).
- [ ] A `side_effects` row outlives its run's checkpoints being pruned — pruning one table never
      depends on / is blocked by the other's retention (independent TTL, §11.5).
- [ ] Two genuinely different attempts (different `task_id` from an `update_state`/`Command` edit
      between them) targeting the same branch: each gets its own reservation, neither treated as a
      duplicate of the other.

**Concurrency on shared identifiers**
- [ ] Two concurrent invocations on the same thread/run id: reject / queue / documented last-write-wins
      — a deliberate tested choice, not an emergent race.
- [ ] Persistence-layer isolation verified directly (every write scoped by thread/run id in its own
      transaction, no shared mutable buffer) before blaming the engine for contamination.
- [ ] Invoking a non-fresh thread with different initial input: documented and tested whether saved
      state or new input wins.

Sources: `libs/langgraph/tests/*`, Camunda "Bulletproofing Zeebe against concurrency bugs" &
`#19393`, DBOS "How to Test Durable Execution", floxy-stress-test, OpenSIN
`tests/test_scheduler_properties.py`.

## 16. Build order for graph-bro

Dependency-ordered minimal feature set — each item is buildable once the ones above exist. This is
the build order (not a usefulness ranking). Items 1–4 make graphs *work at all*; 5–10 harden a
working loop-with-branches for production. That gap is exactly PocketFlow (1–4, informally) vs
athena-graphs/LangGraph (1–10, explicitly).

1. **Shared state dict + node-as-function contract.** `node(state) -> update_dict | Command |
   Interrupt | None`. (PocketFlow `shared`, §13.1; athena-graphs 4-shape return, §13.2.)
2. **Static edges = adjacency** (node→node, or action-string keyed). Linear pipelines. (§13.1.)
3. **A bounded execution loop with a `max_steps`/`max_seconds` cap.** Needed *before* deliberate
   cycles, because step-2 routing can already loop by accident. (PocketFlow is the cautionary tale.)
4. **Conditional edges** — a `(state)->bool` gate or a `(state)->next_node(s)` router. Turns linear →
   branch, and with step 3, branch → loop-with-exit (review/revise). **Highest-leverage feature:
   loops are free once you have conditional routing + a step bound.** (§13.2.3.)
5. **Reducers for concurrent/repeated writes to one key**, loud-fail-by-default for unregistered
   conflicts (`StateConflictError` / `InvalidUpdateError`). Needed the moment >1 node writes a key —
   from parallelism (step 6) or a loop's accumulator. Built-ins: `append`/`sum`/`merge`. (§13.2.4, §7.1.)
6. **Parallel fan-out + join (barrier).** Fan-out is free (multiple edges out of one node). The join
   is the first genuinely new data structure: `arrivals: dict[edge_id, set[source]]` that fires+resets
   when the source set is complete (the ~15-line `NamedBarrierValue` equivalent, §13.3). Needs step 5.
   Use the resettable-barrier model, not indegree counting (loops need re-arming barriers). For
   file-editing CLI-agent nodes sharing a cwd: run sequentially (no per-node sandbox) or worktree-per-node.
   A join source must be reached on *every* resolution of every upstream router — route optional
   branches through a mandatory funnel node and join on the funnel; add a compile-time lint + runtime
   watchdog for violations (§14.9).
7. **Checkpoint object + pluggable store.** `{state, frontier/ready, join-barrier state, step, history}`
   serializable as one unit, atomic write-then-rename (temp file → `os.replace`). O(1) resume, load
   one snapshot. Store behind a `batch()`-style interface (§8.9). Persist **per-task pending writes**
   keyed by a deterministic `(run_id, node, step, triggers)` hash for crash-safe effectively-once
   execution (§8.5) — this is the single most load-bearing correctness property. Co-locate a separate
   `side_effects` ledger table in the same store (same `task_id` key, independent lifecycle/TTL) for
   engine-known external side effects (§11.5).
8. **Interrupt/resume (HITL) as a first-class node return type**, built on step 7. A node returns
   "pause, ask this, re-enter me idempotently on resume"; resuming merges an answer into `state` and
   re-adds the node to the frontier. The pausing node **re-runs from the top** — force idempotency via
   check-then-ask (the athena-graphs `human` node) or split-node patterns; treat "replay from
   checkpoint" and "resume a pending interrupt" as distinct API operations (§14.3). Requires steps 6+7.
9. **Structured per-node error routing (`on_error`)**, distinct from a Python-exception-crashes-the-run.
   A node's failure becomes `Command(update={"last_error":..., "failed_node":...}, goto=error_node)`.
   Layers on step 4's routing. (§13.2.2.)
10. **Observability hook (Observer/event callback + StepTrace history) and a detached control surface**
    (start/status/tail/resume/result over a durable run directory + MCP tools). Streaming is a
    synchronous inline callback at super-step boundaries (§10.4), not a log tailer. The MCP call never
    blocks for the run's duration (§13.2). Optional for a purely in-process engine; needs everything above.

**Architecture decisions already made by this research (don't re-litigate):**
- **State-snapshot-per-super-step, not event-sourced replay** (§11) — the node is an expensive
  non-deterministic subprocess; never re-run it on resume.
- **Channels + subscribers, not nodes + edges, at runtime** (§7) — a join is a resettable barrier
  channel, not a node kind; conditional routing is a runtime writer, not a compile-time shape.
- **Snapshot the whole channel state per super-step for coarse durability; per-task pending writes for
  fine crash-safety** (§8.5). Default checkpoint writes to async (off the hot path) so fine-grained
  nodes stay cheap (§10.8).
- **Loud-fail on unreduced concurrent writes** (§13.2.4). **Idempotency ledger** for engine-known side
  effects (git push, PR open) — a separate `side_effects(task_id, effect_key, status, result)` table
  keyed by the existing deterministic `task_id` (not a new triple), with a reserve-before/complete-after
  write split and a per-effect `reconcile()` backstop; a ledger alone cannot close the crash window
  (§11.5). **Heartbeat** for stuck long-running nodes = last-stdout-line timestamp, two thresholds
  (soft warning vs. hard kill), not the reference's single blocking-timeout (§11.3, §13.4).
- **CLI-agent node executor** (§13.4): copy athena's compile-time prompt-delivery rule verbatim; parse
  Claude Code's JSON envelope but fix the non-zero-exit-short-circuit bug; stream NDJSON via
  `asyncio.create_subprocess_exec` for backends that support it; **kill by process group**
  (`start_new_session=True` + `os.killpg`, SIGTERM→SIGKILL, in `finally` even on success) to reap
  orphaned grandchildren; treat `--dangerously-skip-permissions` as a hang-mitigation, not a
  convenience, for headless nodes.
- **A serializable condition DSL** (athena-graphs' `when` grammar, §13.2) not opaque callables, so
  topologies survive a process restart (§12: callable conditions aren't serializable).
- **Split join-barrier-mode (`all`/`any`) from merge-policy (reducer)** (§12.2 rec. 1). **Key resume
  off node name + channel schema, never edge structure** (§14.6). **max_steps is mandatory** in any
  scheduling model (§13.3).
