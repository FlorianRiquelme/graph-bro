# Calibration loop — overrides → standing facts

The mechanism that keeps grill's proposals calibrated so it can **graduate from attended to
headless, per repo**, without a vector DB. Derived from the analysis of your real grill
overrides (see `conventions.draft.md` for the seed facts).

> **This loop already exists — it's `sensei`** (`~/Repos/mine/claudesetup/sensei`). Sensei mines
> friction + repeats from session transcripts nightly, proposes rules to `~/.claude/sensei/proposals/`,
> applies accepted ones to `~/.claude/CLAUDE.md` via `/sensei review`, and handles staleness with
> rejection cooldowns (30/90d), an escalation grace period, and an effectiveness ledger. **Do not
> rebuild any of that here.** What this session added is two things sensei doesn't do yet — see
> *Relationship to sensei* below. The steps in "The loop" are kept only to make the graph's
> dependency on that machinery explicit.

## The core idea

Your overrides are the training signal. Every time you override grill's recommendation, that
override is either a one-off *or* a durable fact that — if captured — stops that fork from
recurring. So the override rate for a repo should **decay** as facts accumulate. That decay is
the calibration curve, and the override rate is the gauge.

## The loop

1. **Capture.** At any grill decision point where you override the recommendation, record a
   candidate: `{ question, recommended, chosen_instead, repo, timestamp }`.
2. **Tier.** The agent classifies the candidate:
   - **global** — true across all repos, stable (naming preference, auto/bypass-permissions) → `conventions.md`
   - **repo-scoped** — true for this repo (glossary, ADRs, stack, platform target) → `CONTEXT.md` / `docs/adr/`
   - **volatile** — expires (e.g. "not live yet") → **not stored**; stays a question forever
3. **Ratify.** You approve promotion + tier, or reject (it stays a one-off). *Human checkpoint.*
4. **Store.** global → conventions file; repo → `CONTEXT.md`/ADR; volatile → nowhere.
5. **Reuse.** The next grill loads global + repo facts as input. A previously-overridden
   question is now either **not asked** (a fact resolves it) or **pre-answered from the fact**
   and shown for a quick confirm.

## Graduation criterion (measurable, not guessed)

When a repo's grill override rate stays **below threshold `T` across `N` runs**, that repo earns
**headless grill**: auto-accept proposals, and interrupt you *only* when a proposal hits the
topic gate below. You don't decide when to trust it — the number does.

## Topic gate (from the override analysis)

Overrides are predicted by **topic, not by grill's confidence**. Even in a graduated repo,
interrupt-and-ask (never auto-accept) when a proposal touches:

- your personal environment / OS / tooling / permissions
- pre-production vs. live status
- vendor/provider lock-in or multi-provider questions
- a scope-vs-ambition tradeoff
- **retrospective grilling** (justifying already-built code) — treat this whole mode as attended;
  it's where "that wasn't a real decision, reverse it" lives

Auto-accept everything else.

## Map to graph-bro primitives

- **Facts files** = state read at the grill node's entry (input channel).
- **Override capture** = writes to a `candidate_facts` channel via an append reducer.
- **"Promote fact?"** = a `human` node (checkpoint → pause → ratify-merge).
- **Graduation** = a conditional edge keyed on the repo's override-rate metric:
  below `T` → route to the headless grill node; above `T` → route to the attended grill node.

## Scope guard

The facts store is **intentionally dumb**: flat, human-readable, fully read each run, no
embeddings, no retrieval. graph-bro stays workflow orchestration; this is a thin adjunct — **not
memory/RAG**. A flat file stays inspectable and diffable; a vector store would reintroduce the
blackbox this whole design exists to avoid.

## Relationship to sensei — what's actually new (don't rebuild the rest)

Sensei already owns capture, proposal, human-review apply, cooldowns, and effectiveness. Two things
it does **not** do yet, which this session surfaced:

1. **Ceremony-aware override mining.** Sensei mines generic friction across a whole session. A
   *grill override* is richer: it happens at a decision point where grill stated a specific
   recommendation, so the signal is `(question, recommended, chosen_instead)`, not just "user pushed
   back." Feeding grill decision points to sensei as a distinct, high-signal event type would catch
   overrides its correction lexicon misses (e.g. "what if we used the X API?" reads as a question,
   not a correction).
2. **Per-repo override rate as a graduation metric.** Sensei tracks rule *effectiveness*, not
   per-skill-per-repo override *rates*. That rate is what tells a repo it has earned **headless**
   grill (the conditional edge in the graph). It's the one number graph-bro needs and sensei doesn't
   compute today.

Everything else above describes what sensei already does. graph-bro **reads** the facts sensei
curates in `~/.claude/CLAUDE.md` and per-repo `CONTEXT.md`; it does not maintain its own store.

## Open threads (small, later)

- Values for the graduation threshold `T` and window `N`.
- Whether volatile repo-facts get re-confirmed on a timer or on next-touch.
