# Pit — Domain Language

Authoritative domain language for Pit, an agentic coding CLI. It defines what terms
mean, not their implementation; the Todo and Plan entries also define their normative
selection boundary for contributors and coding agents.

## Language

**Mode**:
The operating stance the user cycles in the interactive session (footer indicator, bound
to a cycle key). A Mode is the combination of two facets: a **Permission** facet and an
**Orchestration** facet — but not their full cross-product. Current Modes: `Plan`, `Ask`,
`Auto`, `Fusion · Plan`. There is no `Fusion · Ask` or `Fusion · Auto` in v1: the invariant
is that Orchestration `fusion` implies Permission `plan` (enforced by `nextFusionCycleState`
in `permissions-extension.ts`). The cycle key walks a pure 4-stop loop, not the
cross-product: `Plan → Ask → Auto → Fusion · Plan → Plan`.
_Avoid_: "permission mode" when you mean the whole stance — that is only one facet.

**Permission** (facet of a Mode):
What the agent is allowed to touch, and — for the two read-only values — the stance the
model takes while it is there. `plan` = read-only (bash/edit/write blocked) with the plan
ritual: research, build a Plan, present it for approval; `ask` = the same read-only
enforcement with a Q&A stance: answer the question directly, no Plan, no approval ritual,
and point the user at another Mode when they ask for code changes; `confirm` = `auto`'s
enforcement with a human gate on the terminal: reads run free, and a mutation no allowlist
covers pauses for per-action approval (Allow once / Allow for session / Deny); `auto` =
guarded writes (builtin deny rules enforced as hard blocks).
**The Mode cycle does NOT change**: it is still the same 4 stops
(`Plan → Ask → Auto → Fusion · Plan`). `confirm` is a Permission value that is deliberately
off-cycle — reachable only via `/permission-mode confirm` or `--permission-mode confirm`.
_Avoid_: tier (the "tier" framing was dropped; permission is a facet, not a standalone axis);
treating `ask` as a weaker or more permissive `plan` — what differs is the stance, not what
is blocked; calling `confirm` a Mode stop or expecting the cycle key to reach it.

**Fail-closed** (`permissions.allowlistOnly`, `--allowlist-only`):
An orthogonal permission flag for headless Channels (`text`/`json`/`rpc`, CI), NOT a Mode
and NOT a Permission facet value: it never appears in the cycle and combines with any
Permission value. It flips the terminal decision from allow to deny — only reads, writes
under `allowPaths`, commands under `allowCommands`, and side-effect-free tools (plus
anything in `allowTools`) run; deny rules still win over the allowlists. It is the mirror
of Permission `confirm`, which reads the SAME three lists but asks about what they do not
cover instead of denying it; when both are active `allowlistOnly` wins (CI never prompts).
_Avoid_: "allowlist mode", "CI mode" — it is a flag on top of a Mode, not a stance of its own;
conflating it with `confirm`, which IS a Permission value and needs an interactive Channel.

**Orchestration** (facet of a Mode):
How many independent reasoning paths run and how they are reconciled. `solo` = one agent;
`fusion` = a Panel of models plus a Synthesizer.
_Avoid_: "fusion mode" as if it were a Permission value — and don't assume Fusion composes
with every Permission value: in v1 `fusion` only ever rides on `plan` (there is no
`Fusion · Ask` and no `Fusion · Auto`).

**Fusion**:
The Orchestration facet value where the same prompt is dispatched to a **Panel** of two
models in parallel, then a **Synthesizer** reconciles their outputs into the final answer.
_Avoid_: ensemble, multi-model (use Fusion as the canonical name).

**Panel**:
The set of models that independently answer the prompt under Fusion. Configured via the
`/fusion` command, chosen from the logged-in/available models. Currently two members.
_Avoid_: jury, committee, swarm.

**Synthesizer**:
The model that reads every Panel response, produces a structured analysis (consensus,
contradictions, partial coverage, unique insights, blind spots), and writes the final
grounded answer. The Synthesizer is the default model selected via `/model`.
_Avoid_: judge (the OpenRouter term) — within Pit, prefer Synthesizer.

**Solo**:
The default Orchestration facet: a single agent, no Panel, no Synthesizer.

**Channel**:
The input/output surface of a session: `text`, `json`, `rpc`, `interactive`. (Historically
called "mode" in code via `type Mode`; renamed here to free "Mode" for the operating stance.)
_Avoid_: "I/O mode", "mode" (reserve "Mode" for the operating stance).

**Role**:
A named mapping to a concrete model + thinking level (`default`, `smol`, `slow`, `commit`).
Selected via `--role`.
_Avoid_: confusing Role with Mode — Role picks the model; Mode picks the stance.

**Todo**:
The agent's canonical, universal task list — materialized *before* acting on any
non-trivial task, including pure investigation/diagnosis, not just implementation. The
threshold is "≥2 actions OR some discovery"; genuinely single-step requests skip it.
_Avoid_: checklist, task list (use Todo); do not conflate with Plan.

**Plan**:
The versioned task DAG (steps with dependencies and verify commands) reserved for long,
multi-phase work. Secondary to the Todo in the interactive flow — Plan is for when
dependencies and verification matter, not for everyday task tracking.
_Avoid_: using Plan as a synonym for Todo (they are distinct systems).

**Triage** (Todo triage):
The cognitive act, at the opening of the agent's reasoning, of classifying the task
against the threshold and creating a Todo when it applies. It is a reasoning ritual, not
a mechanical gate — a light one-shot nudge is the only safety net behind it.
_Avoid_: "todo gate" (there is no blocking gate; triage is soft).

**Sync reminder** (Todo cadence reminder):
The ephemeral nudge that hands the enumerated Todo back to the model and asks it to update
status when the list has fallen behind the real work — i.e. an item sits in_progress too
long, or code was mutated without any Todo update. It reminds; it never auto-completes.
_Avoid_: "todo nag"; do not describe it as auto-advancing the list.

## Flagged ambiguities

- **"mode"** was overloaded across three concepts: the I/O surface (`type Mode`), the
  `--role` selector, and the permission stance (`PermissionMode`). Resolution: the
  user-facing cycled stance is **Mode**; the I/O surface is **Channel**; the model selector
  stays **Role**.
- **"plan"** appears as both a Role and a Permission facet value. They are distinct: the
  Role `plan` selects a model/thinking config; the Permission facet `plan` means read-only.
- **"ask"** appears as both a built-in tool and a Permission facet value. They are distinct:
  the tool `ask` poses an interactive question to the user mid-turn; the Permission facet
  `ask` is the read-only Q&A stance.
- **"read-only"** covers exactly two Permission values, `plan` and `ask` — and NOT
  `confirm`, which executes (it only pauses first). `plan` and `ask` are indistinguishable
  in what they allow; they differ only in the stance expected of the model (plan ritual vs.
  direct answer). Say which one you mean instead of "read-only mode".
- **"confirm"** appears both as a Permission value and as the third variant of a
  `PermissionDecision` (`allow` / `deny` / `confirm`). They are related but distinct: the
  Permission value is the stance; the decision variant is a *deferral* the checker returns
  and the layer above resolves into a real verdict (prompt when interactive, deny when not).
- **Todo vs Plan** were two competing task-tracking systems injected into the same turn.
  Resolution (ADR-0007): **Todo** is the canonical universal tracker for interactive work;
  **Plan** is reserved for long, multi-phase work with dependencies/verification.

## Example dialogue

> **Dev:** If I'm in Fusion · Plan and hit the cycle key, what do I get?
> **Expert:** Plain `Plan` (solo, permission `plan`) — not Fusion · Ask or Fusion · Auto.
> The cycle is a pure 4-stop loop over the two facets, not their full cross-product:
> `Plan → Ask → Auto → Fusion · Plan → Plan`. Fusion always rides on the `plan` Permission
> in v1, so `fusion` + `ask` and `fusion` + `auto` are never reachable combinations.
>
> **Dev:** Then what does the Ask stop buy me over Plan, if both are read-only?
> **Expert:** Nothing at the permission layer — the enforcement is identical. What changes
> is the stance: in `Ask` the agent just answers you, with no Plan and no approval step; in
> `Plan` it researches and comes back with a Plan to approve.
>
> **Dev:** And the two models answering — those come from `/model`?
> **Expert:** No. The **Panel** (two models) is configured with `/fusion`. The model from
> `/model` is the **Synthesizer** — it reads both Panel answers and writes the final one.
>
> **Dev:** So Fusion is a permission level?
> **Expert:** No — Fusion is the **Orchestration** facet. Permission (`plan`/`auto`) is a
> separate facet, and in v1 `fusion` is only ever paired with `plan`.
