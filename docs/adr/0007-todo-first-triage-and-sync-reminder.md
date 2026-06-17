# ADR-0007: Todo-First Triage e Reminder de Sincronização

## Status
Accepted

> Design alinhado em sessão de grilling/domain-modeling (2026-06-17).
>
> **As shipped (2026-06-17):** entregue como desenhado. A triagem (D1/D2/D4) é a 1ª
> guideline do system prompt, gated em `tools.includes("todo")` (`system-prompt.ts`).
> A indução de criação saiu da guideline da tool (`tools/todo.ts` agora só pede
> manutenção). O `<todos>` enumera os itens (D8, `todo-manager.ts:systemPromptSection`).
> O reminder de sync (D6/D7/D8) vive em `todo-cadence.ts` (puro, espelhando
> `stagnation.ts`) + wiring fino em `agent-session.ts` (`_maybeInjectTodoCadenceReminder`
> em `turn_end`, steer efêmero), e a rede one-shot da triagem em `_maybeFireTodoFirstNudge`
> (`tool_execution_end`, dispara na 2ª ação de trabalho sem todo). Settings-gated via
> `toolFeedback.todoCadenceReminder` (default enabled, threshold 3, cooldown 30s). 22
> testes novos; gate verde (tsgo + biome + 3084 testes).

## Context
O subsistema `todo` (lista de tarefas nativa) tem dois problemas, ambos validados
ponta-a-ponta contra o código:

**1. Indução fraca (Eixo 1).** O uso de todo é proativo-opcional: a única pressão é
a `promptGuidelines` estática da tool (`tools/todo.ts:71`, "For non-trivial multi-step
tasks…"), que vira um bullet perdido na seção Guidelines (`system-prompt.ts:233-238`)
e é rotineiramente ignorada. Não há heurística, gate, nem reminder. O dono quer que
materializar um todo vire reflexo antes de agir — inclusive em tarefas de investigação/
diagnóstico, não só de implementação.

**2. Defasagem do todo (Eixo 2).** O todo "fica atrás" da ação real. Causa-raiz em duas
camadas, nenhuma é render (o overlay repinta síncrono no `changeListener`):
- **Injeção stale:** o bloco `<todos>` é injetado uma vez por prompt do usuário
  (`agent-session.ts:3621`), antes de `_runAgentPrompt`; o loop agêntico roda N turnos
  via `agent.continue()` sem nunca re-derivar o `<todos>`. Pior: `systemPromptSection()`
  injeta apenas a **contagem agregada** ("X open of Y"), não enumera os itens
  (`todo-manager.ts:173-184`). O modelo perde o fio do próprio estado.
- **Comportamento do modelo:** marcar `in_progress`/`completed` é uma tool-call extra
  que o modelo economiza. Não há acoplamento entre execução e todo — `_handleToolExecutionEnd`
  (`agent-session.ts:1683`) dispara doom-loop/repeating/learned-errors/failure-budget,
  mas nada toca o todo. Existe infra de steer (`_fireReminder`, `agent-session.ts:2017`)
  usada por 5 sistemas, e **nenhum** é de todo — o Pit não tem o equivalente ao
  system-reminder de todo recorrente do Claude Code.

## Decision

|-|-|
| Eixo | Decisão |
| D1 — Trilho canônico | `todo` é o trilho **universal**: dispara para qualquer tarefa não-trivial, incluindo investigação/leitura de código, não só planejamento de implementação. `plan` fica reservado a trabalho longo multi-fase com dependências/verify. |
| D2 — Piso do reflexo | Amplo com escape: dispara quando a tarefa exige **≥2 ações OU descoberta**; pula o caso genuinamente trivial de 1 passo óbvio. |
| D3 — "Propor" todo | Criar-e-seguir, sem pausar para aprovação (o dono opera com stop-hook `/goal`). |
| D4 — Indução | **Triagem no raciocínio** + rede leve. O agente classifica a tarefa pela régua (D2) como ato de abertura do thinking e cria o todo se aplicável. Rede: se agir (≥1 tool de trabalho) sem todo num caso que era de todo, um nudge silencioso **one-shot por prompt** aparece. Não bloqueia. |
| D5 — Re-injeção | Via **steer/system-reminder efêmero**, nunca reescrevendo o system prompt (rewrite do sufixo por turno invalida o cache — 1.25× write vs 0.1× read; já marcado token-negativo em sessão anterior). |
| D6 — Gatilho da sync | **Híbrido**: dispara quando um item está `in_progress` há >K turnos sem update **OU** quando houve mutação real (edit/write) no turno sem nenhum todo update. Cooldown anti-ruído espelhando `decideStagnationReminder`. K inicial = 3. |
| D7 — Ação do reminder | **Relembrar**, nunca auto-completar: o harness não sabe qual item um `edit` conclui; auto-marcar produziria estado errado. |
| D8 — `<todos>` no contexto | Passa a **enumerar** `#id status subject` dos itens abertos, não só a contagem. |

**Pontos de implementação** (ancorados): a triagem (D4) e a régua (D2) entram como
protocolo de abertura no system prompt — posição comportamental, não o bullet de tool
de hoje. O reminder de sync (D6) é um novo `_maybeInjectTodoCadenceReminder` chamado de
`turn_end` (`agent-session.ts:1591`, ao lado de `_maybeInjectStagnationReminder`), via
`_fireReminder(..., {deliverAs:"steer", display:false})`. A rede one-shot (D4) e a
detecção "mutação sem update" reusam `MUTATING_TOOL_NAMES` (`stagnation.ts`). D8 expande
`TodoManager.systemPromptSection()` (`todo-manager.ts:173-184`).

## Considered Options (rejeitadas)
- **Hard gate bloqueante na 1ª ação** — garantia dura de todo-first, mas atrito e
  round-trip extra; conflita com o fluxo rápido do dono. Rejeitado em favor da rede soft (D4).
- **Só reescrever a guideline** — é essencialmente o status quo; o modelo já ignora.
- **Rewrite do `<todos>` no system prompt por turno** — invalida cache (D5).
- **Re-injetar todo turno (estilo Claude Code)** — trilho mais firme, mas custo de
  contexto constante mesmo quando nada mudou; o gatilho híbrido (D6) cobre o sintoma
  pagando só quando defasou.
- **Auto-completar todo por evento de tool** — estado errado (D7).
- **Unificar todo×plan num só sistema** — elimina a ambiguidade de raiz, mas é refactor
  grande (overlay + persistência + 2 tools + migração); fora de escopo, resolvido por
  papéis distintos (D1).

## Consequences
- **Positivo:** o todo vira trilho de atenção confiável (reduz drift em tarefa longa);
  o estado deixa de ficar stale durante a execução; a defasagem percebida é capada em
  K turnos. Alinha o Pit ao mecanismo que faz o todo do Claude Code funcionar (reminder
  recorrente + itens enumerados), sem o custo de re-injetar todo turno.
- **Negativo:** a rede one-shot e o reminder híbrido custam round-trips quando disparam
  (mitigado por one-shot/cooldown/`display:false`). A triagem no thinking herda o furo
  "depende do modelo obedecer" — por isso a rede.
- **Risco:** K e o cooldown podem precisar de tuning (começar em 3, ajustar com uso real).
  A heurística "tarefa não-trivial" pode gerar falsos positivos/negativos — medir em uso.
