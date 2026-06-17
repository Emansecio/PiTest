# Pit — Domain Language

Glossary for Pit, an agentic coding CLI. This file is a glossary only: it defines what
terms *mean*, not how they are implemented.

## Language

**Mode**:
The operating stance the user cycles in the interactive session (footer indicator, bound
to a cycle key). A Mode is the cross-product of two facets: a **Permission** facet and an
**Orchestration** facet. Current Modes: `Plan`, `Auto`, `Fusion · Plan`, `Fusion · Auto`.
_Avoid_: "permission mode" when you mean the whole stance — that is only one facet.

**Permission** (facet of a Mode):
What the agent is allowed to touch. `plan` = read-only (bash/edit/write blocked); `auto` =
guarded writes (builtin deny rules enforced as hard blocks).
_Avoid_: tier (the "tier" framing was dropped; permission is a facet, not a standalone axis).

**Orchestration** (facet of a Mode):
How many independent reasoning paths run and how they are reconciled. `solo` = one agent;
`fusion` = a Panel of models plus a Synthesizer.
_Avoid_: "fusion mode" as if it were a Permission value — Fusion composes with `plan`/`auto`.

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
- **Todo vs Plan** were two competing task-tracking systems injected into the same turn.
  Resolution (ADR-0007): **Todo** is the canonical universal tracker for interactive work;
  **Plan** is reserved for long, multi-phase work with dependencies/verification.

## Example dialogue

> **Dev:** If I'm in Fusion · Plan and hit the cycle key, what do I get?
> **Expert:** Fusion · Auto. The cycle walks the cross-product of the two facets; the key
> flips Permission from `plan` to `auto` while the Orchestration facet stays `fusion`.
>
> **Dev:** And the two models answering — those come from `/model`?
> **Expert:** No. The **Panel** (two models) is configured with `/fusion`. The model from
> `/model` is the **Synthesizer** — it reads both Panel answers and writes the final one.
>
> **Dev:** So Fusion is a permission level?
> **Expert:** No — Fusion is the **Orchestration** facet. Permission (`plan`/`auto`) is a
> separate facet. A Mode is the combination of both.
