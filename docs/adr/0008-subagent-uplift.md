# ADR-0008: Subagent Uplift — built-ins, continuação, observabilidade, cap, token accounting

## Status
Accepted

## Context
Auditoria (2 agentes Opus + validação contra o código) posicionou o coordinator de
subagentes do Pit à frente do Codex e em paridade/à frente do Claude Code na mecânica
bruta (worktree isolation, output estruturado, messaging bidirecional, background com
re-injeção, resume durável), mas **atrás do CC em eixos de produto**: sem agent types
built-in curados, sem continuação conversacional de um subagente são, sem observabilidade
ao vivo, sem cap de concorrência e sem accounting de tokens por subagente.

## Decision
Implementados 5 dos 6 gaps (o #6 ficou de fora — ver abaixo):

|-|-|
| Gap | Decisão |
| Built-ins curados | `BUILT_IN_AGENT_TYPES` (`builtin-agents.ts`): explore/plan/review/general, semeados em `loadAgentTypes` antes de user/project (que sobrescrevem). Zero-config — `source: "builtin"`. |
| Continuação conversacional | Novo `op:"continue"` (≠ `op:"resume"`): retém o Agent vivo de runs/spawns concluídos **com sucesso** num map `continuable` (FIFO cap 8) e re-dirige via `agent.prompt`. `resume` continua exclusivo a interrompidos/erro. |
| Observabilidade ao vivo | **Leve, por turno** (não por tool): `spawn.ts` emite `onSubagentEvent({turn, lastTool})` no `turn_end` já assinado → coordinator (`onSubagentProgress`) → `AgentSessionEvent` `subagent_start`/`subagent_progress` → status line na TUI. Sem streaming de cada tool (evita exagero). |
| Cap de concorrência | Semáforo module-scoped `MAX_CONCURRENCY` (`PIT_SUBAGENT_MAX_CONCURRENCY`, default 4) envolvendo spawn/run; tempo de fila NÃO conta no timeout. |
| Token accounting | `SubagentRecord.usage`/`SpawnSubagentResult.usage` acumulados de `message.usage` por turno; surface em `op:list` e no `subagent_complete` (turns/tokens). |
| UI | Cautelosa: só enriquece status lines existentes (start/progress muted, complete com `· N turns · N tok`). Sem overlay/componente novo. |

## Considered Options (rejeitadas / adiadas)
- **#6 Retry automático em falha — ADIADO.** Re-executar um subagente perde os turnos já
  feitos (estado in-memory), e abort por turn-cap/timeout não deve ser retryado. O `op:resume`
  manual já cobre queda/ESC. Backlog: retry só de erro de transporte (5xx) antes do 1º turno.
- **Streaming de cada tool-call do subagente** — rejeitado por exagero/custo; o progresso
  por turno já dá o sinal "vivo" sem inundar a TUI.
- **Mudar a assinatura de `onAsyncComplete` para carregar turns/tokens no complete async** —
  evitado (atravessa 3 camadas); os campos são opcionais e a UI degrada graciosamente.

## Consequences
- **Positivo:** paridade de produto com o CC nos eixos visíveis; zero-config via built-ins;
  fan-out grande deixa de auto-sabotar (cap); custo por subagente fica observável.
- **Negativo:** `continuable` retém Agents em memória (mitigado por FIFO cap 8).
- **Risco:** `PIT_SUBAGENT_MAX_CONCURRENCY` default 4 pode precisar de tuning por provider.

## Implementation
Workflow de 4 lanes por arquivo disjunto (built-ins / spawn / coordinator-extension / TUI)
contra contratos pré-fixados em `types.ts` + `AgentSessionEvent`; wiring cross-camada
(`built-ins/index.ts`, `agent-session-services.ts`, `agent-session.ts`) feito à mão e
validado contra o código. Gate verde: tsgo + biome + 3095 testes (12 novos).
