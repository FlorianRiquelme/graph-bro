# Global standing facts (ratified 2026-07-24)

Global-tier facts, mined from your `/grill-with-docs` overrides. These are the facts that
caused you to override grill's recommendation because grill *couldn't have known them* — so
capturing them once, globally, stops them from ever becoming a fork again.

**Ratified 2026-07-24 and promoted** to `~/.claude/CLAUDE.md` (§ Standing conventions) — the
canonical home sensei applies rules to, so they dedup against future mining. Provenance is tagged
below so every claim stays auditable. This file is now the design record of what was mined and why,
not a live config source.

**Eventual home:** once ratified, these belong at the global tier — imported into your global
`CLAUDE.md` or `~/.claude/conventions.md`, not in this repo. This copy is the draft workspace.

**How agents use it:** a grill/planning agent loads this before proposing. If a proposal
contradicts a ratified fact, it must not propose it (or must flag the contradiction). Unratified
items are candidates, not binding.

---

## Agent operation & permissions

- [x] **I run agents in auto / bypass-permissions mode.** Permission-rule design (deny rules,
  allowlists derived from repeated denials) is not interesting to me — don't propose it.
  <br>_(docs-ideas-triage grill, 2026-07-18 — "i use auto mode and most of my friends and colleagues just straight up use bypass permissions")_

## Naming & domain language

- [x] **Names must reveal intention — readable and self-documenting, making clear what they're
  for.** Prefer clarity over brevity; avoid cryptic or terse abbreviations. Industry/SDK-standard
  domain terms are preferred because they carry shared, unambiguous meaning — not for their own sake.
  <br>_(loop-agents grill, 2026-07-11 — chose faithful SDK token names over shorthand; refined during ratification 2026-07-24 to the underlying principle)_

## Stack & dependencies (TypeScript work)

- [x] **Use zod everywhere**, including the JSON-schema contracts for agents — not only at HTTP
  request-body edges.
  <br>_(loop-agents grill, 2026-07-10 — "we should absolutely use zod for everything, even the json schema contracts for the agents")_
- [x] **Rely on the broad, mature ecosystem rather than zero-dependency / bleeding-edge bets.**
  Don't default to experimental stacks (e.g. TS7) just because an LLM picked them; reverse
  incidental LLM-chosen stack decisions rather than rationalizing them post-hoc.
  <br>_(loop-agents stack grill, 2026-07-10 — "mostly the llm decided on these things. I would actually want to go back and reverse this... I want to rely on the broad ecosystem that exists today")_

## Infrastructure (AWS / EC2)

- [x] **On EC2, rely on the instance's IAM role** — the SDK reads IAM permissions. Don't design
  static access-key/secret delivery for EC2-hosted code. _[scope: AWS/EC2 deployments]_
  <br>_(carnival-website grill, 2026-07-06 — "the permissions are on the ec2 machine provisioned, the sdk reads the iam permissions")_

## Working style

- [x] **Prefer instrumented, data-driven iteration over assumption.** When building something
  whose behavior is uncertain, add observability / a watchdog so decisions come from data.
  <br>_(knowledge-system grill, 2026-07-19 — "we need a watchdog that can show us where things are shaky, so we can iterate data driven instead of assuming")_

## Tooling / workflow facts

- [x] **`/handoff` is retired** — I use the branch-stamped `.handoff.md` baton convention
  instead. Don't reference or propose `/handoff`.
  <br>_(handoff-channel grill, 2026-07-22 — "Im not using /handoff at all, we should immediately remove it from my global claude.md")_

---

## Deliberately NOT promoted (kept out of the global tier)

Shown so the tiering judgment is visible:

- **Platform target (macOS / Linux)** → *repo-scoped*, per your call (2026-07-24). Your dev
  machine is mac, but a repo's deploy/runtime target is a property of *that repo* — it belongs in
  its `CONTEXT.md`, not global. Learning: "environment" facts are **not** automatically global.
- **"Not live yet — no migration/fallbacks needed"** → *volatile*. Inverts the moment the repo
  ships. Must stay a question, never a stored fact.
- **Multi-provider TicketProvider (GitHub issues next)** → *repo-scoped* (loop-agents). Belongs
  in that repo's `CONTEXT.md`/ADR, not global.
- **Watchdog subsystem, rejection-reason mini-grill, zod-contract specifics** → *repo-scoped*
  scope expansions, not portable conventions.
