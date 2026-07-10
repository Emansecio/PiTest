# Taxonomia — 12 áreas do Pit

Mapa canônico das áreas de produto e arquitetura do Pit. Serve para roadmap,
issues, docs e discussão de escopo — não redefine o glossário de domínio
([CONTEXT.md](CONTEXT.md)) nem as regras de contribuição ([AGENTS.md](AGENTS.md)).

## Por que 12

Menos que isso colapsa conceitos distintos (ex.: harness com compactação, tools
com guards, Fusion com permissions). Mais que isso vira inventário de pastas e
perde valor como mapa mental.

As 12 áreas seguem três critérios:

1. **Responsabilidade única** — cada área tem um job claro; se remover a
   fronteira, o escopo fica ambíguo.
2. **Ortogonalidade** — áreas compostas (ex.: Mode = Permission × Orchestration)
   não são fundidas; cada eixo permanece separado.
3. **Âncora no código** — cada área mapeia para packages/subsistemas reais, não
   para slogans de marketing.

Agrupamentos menores (6 executivas, 4 packages) são projeções desta taxonomia,
não substitutos.

| Nível | Uso | Contagem |
|-------|-----|----------|
| **12 áreas** | roadmap, labels, docs, ownership | canônico |
| **6 executivas** | pitch / status de alto nível | projeção |
| **4 packages** | boundaries de código npm | `@pit/ai`, `@pit/agent-core`, `@pit/coding-agent`, `@pit/tui` |

---

## As 12 áreas

### 1. Harness / runtime

**Responsável por:** o loop do agente — sessão, turn flow, dispatch de tools,
abort, retry, estado e recuperação.

É o “sistema operacional” do Pit: recebe input do Channel, orquestra o ciclo
`agent-session` → `agent-loop` → tool execution → compaction check → provider
call, e devolve o resultado. Features comportamentais não vivem inline aqui;
entram via extensions (ver área 9).

**Âncoras:** `@pit/agent-core`, `packages/coding-agent/src/core/agent-session.ts`,
`packages/agent/src/agent-loop.ts`.

---

### 2. Providers / models

**Responsável por:** a camada unificada de LLM — providers, auth, roles,
fallback, custom models e APIs compatíveis.

Decide *com quem* o harness fala e *como* a chamada é feita (Anthropic, OpenAI,
Google, OpenRouter, OpenAI-compat, etc.). Role (`default`, `smol`, `slow`,
`commit`, `plan`, `compact`) escolhe modelo + thinking; não confundir com Mode.

**Âncoras:** `@pit/ai`, `packages/coding-agent/docs/providers.md`,
`packages/coding-agent/docs/models.md`.

---

### 3. Context economy

**Responsável por:** manter o contexto dentro da janela com fidelidade —
compaction, prune, supersede, defer/recall, thinking cap, prompt cache e token
governor.

É economia de tokens *dentro* do harness, não o harness em si. Inclui benches e
gates de regressão de tokens. Opt-outs `PIT_*` desta área documentam-se em
[docs/token-economy-tuning.md](docs/token-economy-tuning.md).

**Âncoras:** `packages/coding-agent/src/core/compaction/`,
`packages/coding-agent/docs/compaction.md`,
[docs/optimization/context-economy-inventory.md](docs/optimization/context-economy-inventory.md).

---

### 4. Tools

**Responsável por:** o registry e a execução das capacidades do agente —
read/edit/write, bash, search, LSP, chrome, code-mode, web search, e o repair
de argumentos (aliases, coercion, rewrite).

Tools *fazem* coisas no mundo. A política de *quando podem* fazer fica em
Guards (área 5). Fonte única: `TOOL_REGISTRY`.

**Âncoras:** `packages/coding-agent/src/core/tools/`,
[docs/agents/tools-and-config.md](docs/agents/tools-and-config.md).

---

### 5. Guards / prevention

**Responsável por:** impedir ou corrigir erros do modelo — permissions,
grounding, read-guard, edit-precondition, destructive-command, doom-loop,
verification gate, learned-error.

Camadas preventivas (antes da tool) e corretivas (depois / fim de turn). Não
são tools: envolvem o ciclo de tool call. Ordem canônica em
[docs/agents/prevention-layers.md](docs/agents/prevention-layers.md).

**Âncoras:** `packages/coding-agent/src/core/built-ins/`,
`packages/coding-agent/docs/permissions.md`,
`packages/coding-agent/docs/verification.md`.

---

### 6. Orchestration

**Responsável por:** *quantos* caminhos de raciocínio rodam e como se
reconciliam — Solo vs Fusion (Panel + Synthesizer), coordinator e subagents.

Ortogonal a Permission: Mode = Permission × Orchestration. Fusion não é um
nível de permissão; subagents não são “mais um tool” no sentido de produto —
são fan-out de trabalho com accounting e resume.

**Âncoras:** `packages/coding-agent/src/core/fusion/`,
`packages/coding-agent/src/core/coordinator/`,
`packages/coding-agent/docs/fusion.md`,
`packages/coding-agent/docs/subagents.md`.

---

### 7. Task cognition

**Responsável por:** como o agente estrutura o trabalho — Todo (tracker
universal + triage + sync reminder), Plan (DAG versionado com verify), Goals
(autonomia com budget).

Todo ≠ Plan (ADR-0007): Todo é o tracker do dia a dia; Plan é para trabalho
multi-fase com dependências. Goals amarram continuação autônoma a um orçamento
de tokens.

**Âncoras:** `packages/coding-agent/src/core/todo/`,
`packages/coding-agent/src/core/plan/`,
`packages/coding-agent/src/core/goal/`,
`packages/coding-agent/docs/goals.md`,
[docs/adr/0007-todo-first-triage-and-sync-reminder.md](docs/adr/0007-todo-first-triage-and-sync-reminder.md).

---

### 8. Memory & learning

**Responsável por:** persistência e recuperação além do turn atual — memory
on-demand, hindsight (retain/recall/reflect/forget), learned-error cross-session,
árvore de sessão / branch / fork.

Complementa Context economy: compaction *esquece com cuidado*; memory/hindsight
*lembram sob demanda*. Sessions (tree, branch summaries) são a superfície
durável da conversa.

**Âncoras:** `packages/coding-agent/src/core/memory/`,
`packages/coding-agent/src/core/hindsight/`,
`packages/coding-agent/docs/memory.md`,
`packages/coding-agent/docs/sessions.md`.

---

### 9. Extensibility

**Responsável por:** como o core permanece mínimo e o resto entra por fora —
extensions TypeScript, skills, hooks, prompt templates, pit packages, MCP.

Regra de produto: o que não pertence ao core vira extension/package. MCP é a
ponte para tools/resources externos; packages empacotam extensions + skills +
themes para compartilhar.

**Âncoras:** `packages/coding-agent/src/core/extensions/`,
`packages/coding-agent/src/core/mcp/`,
`packages/coding-agent/docs/extensions.md`,
`packages/coding-agent/docs/skills.md`,
`packages/coding-agent/docs/packages.md`,
`packages/coding-agent/docs/mcp.md`.

---

### 10. TUI / experience

**Responsável por:** a superfície interativa no terminal — activity rendering,
mensagens, themes, motion, keybindings, welcome, footer de Mode.

É a experiência do Channel `interactive`, não de todos os channels. Biblioteca
de rendering diferencial em `@pit/tui`; componentes de sessão em
`modes/interactive/`.

**Âncoras:** `@pit/tui`, `packages/coding-agent/src/modes/interactive/`,
`packages/coding-agent/docs/tui.md`,
`packages/coding-agent/docs/themes.md`,
`packages/coding-agent/docs/keybindings.md`.

---

### 11. Channels / embed

**Responsável por:** *como* o Pit é consumido — `text`, `json`, `rpc`,
`interactive`, SDK Node, dry-run.

Channel (I/O surface) ≠ Mode (stance Permission × Orchestration). Esta área
cobre integração programática e streams estruturados; a TUI (área 10) é uma
implementação do channel interactive.

**Âncoras:** [CONTEXT.md](CONTEXT.md) (Channel),
`packages/coding-agent/docs/sdk.md`,
`packages/coding-agent/docs/rpc.md`,
`packages/coding-agent/docs/json.md`,
`packages/coding-agent/docs/dry-run.md`.

---

### 12. Platform & quality

**Responsável por:** rodar e manter o Pit com confiança — Windows, Termux,
tmux, terminal setup, telemetry, benches, CI gates (`check`, `check:fast`,
token benches).

Não é feature de agente; é o chão sob as outras 11 áreas. Mudanças aqui
protegem regressão e portabilidade.

**Âncoras:** `packages/coding-agent/docs/windows.md`,
`packages/coding-agent/docs/termux.md`,
`packages/coding-agent/docs/tmux.md`,
`bench/`, `scripts/check-token-bench.mjs`, `./test.sh`.

---

## Projeção em 6 (executiva)

| Executiva | Áreas |
|-----------|-------|
| **Core harness** | 1 + 2 |
| **Token & context** | 3 |
| **Agency** | 4 + 5 + 7 |
| **Multi-agent** | 6 + 8 |
| **Surface** | 9 + 10 + 11 |
| **Ops** | 12 |

---

## Fronteiras que não se misturam

| Não fundir | Por quê |
|------------|---------|
| Harness ≠ Context economy | Loop vs. economia *dentro* do loop |
| Tools ≠ Guards | Execução vs. política/prevenção |
| Fusion ≠ Permissions | Facetas ortogonais de Mode |
| Todo ≠ Plan | Tracker universal vs. DAG multi-fase |
| TUI ≠ Channels | Uma surface vs. todas as surfaces de I/O |
| Memory ≠ Compaction | Lembrar sob demanda vs. esquecer com cuidado |

---

## Uso sugerido

- **Issues / PRs:** label `area:<nome>` alinhado a uma das 12 (ex.:
  `area:context-economy`, `area:orchestration`).
- **Docs:** novos guias de subsistema apontam para a área correspondente.
- **Escopo de PR:** se a mudança cruza 3+ áreas sem necessidade, provavelmente
  está grande demais — fatiar por área.
- **Propostas de feature:** classificar na área antes de implementar; se não
  cabe em nenhuma, ou é extensão (área 9) ou a taxonomia precisa de revisão
  explícita.
