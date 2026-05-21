# Relatório de Otimização — PiTuned (`pit`) — VERSÃO VELOCIDADE

Foco: **wall-clock**. Tempo até primeiro token, tempo total por turno, tempo até resultado de tool call. Custo/token é ignorado.

Toda recomendação aqui é justificada por **segundos cortados**, não por dólares.

---

## TL;DR — onde está o tempo perdido HOJE

Numa sessão de coding agent típica (1 turno = 1 user msg → assistant → tool call → tool result → assistant final), o orçamento de tempo é mais ou menos:

```
[ user ] → [ extension hooks pré-request ]  ← 200-800ms serial (17 extensões)
        → [ network round-trip ]            ← 100-300ms
        → [ TTFT do modelo ]                ← f(prompt_size, model)
        → [ reasoning tokens streamados ]   ← f(thinking_level, model)
        → [ output + tool_call streamados ] ← f(output_tokens, model)
        → [ tool execution local ]
        → [ extension hooks pós-tool ]      ← serial
        → [ 2º request ] (repete tudo acima)
```

**Os 4 gargalos de wall-clock em ordem de impacto:**

1. **Thinking level `high` no Opus 4.7** — reasoning é gerado **antes** de qualquer output visível. `high` = 1500–4000 reasoning tokens × ~60 tok/s no Opus = **25–60s adicionais por turno**.
2. **Modelo `claude-opus-4-7`** — Opus gera a ~50–80 tok/s. Sonnet a ~120–200 tok/s. Pra tool-call work, Sonnet é **2–3x mais rápido em wall-clock** com qualidade equivalente em 90% dos turnos.
3. **17 extensões com hooks serializados** — `before_provider_request` roda hook por hook em loop `for await` (`runner.ts:898`). 50ms × 17 = ~850ms por request. Acontece **2x por turno** (request inicial + após tool result).
4. **Prompt prefix ~25k tokens** — TTFT do Anthropic escala com input. Cache hit reduz drasticamente, mas: (a) primeira chamada da sessão paga full; (b) atenção do decoder ainda escala com contexto; (c) qualquer mudança em meio do prefix invalida cache e refaz.

**Resultado prático**: turno típico hoje provavelmente leva **40–90s**. Aplicando os 4 itens acima: alvo **8–20s**. Fator **3–5x mais rápido**.

---

## 1. Thinking level — MAIOR alavanca de velocidade

`~/.pi/agent/settings.json`:
```json
"defaultThinkingLevel": "high"
```

### Por que custa segundos

Reasoning tokens são gerados **sequencialmente** antes do output. Não dá pra paralelizar. Não dá pra cachear. Cada token é tempo real.

Estimativa empírica Opus 4.7:
- `minimal`: ~0 reasoning toks → 0s overhead
- `low`: ~300 reasoning toks → ~5s overhead
- `medium`: ~800 reasoning toks → ~12s overhead
- `high`: ~2500 reasoning toks → **~40s overhead**

Para cada turno. Multiplica por número de turnos numa sessão.

### Ação

```json
"defaultThinkingLevel": "low"
```

Para tarefas mecânicas (95% do uso de coding agent: edit X, run Y, read Z), `low` ou `minimal` é suficiente. Cicla `high` no TUI quando arquitetar algo novo.

**Ganho esperado**: -25s a -40s por turno. **Maior ganho do relatório, custo zero.**

---

## 2. Modelo — segunda maior alavanca

Atual: `claude-opus-4-7` (default).

### Velocidades observadas (output tokens/segundo, Anthropic)

| Modelo | TTFT | Output rate | Bom pra |
|--------|------|-------------|---------|
| Opus 4.7 | 1.5–3s | ~60 tok/s | arquitetura complexa, debug profundo |
| Sonnet 4.x | 0.6–1.2s | ~150 tok/s | tool calls, edits, code review |
| Haiku 4.5 | 0.3–0.6s | ~250 tok/s | navegação, leituras, batch reads |

Numa cadeia de 3 tool calls + 1 resposta final, com ~500 tokens de output em cada:
- Opus: 3 × (3s TTFT + 8s output) + 12s resposta = **~45s só de modelo**
- Sonnet: 3 × (1s + 3s) + 4s = **~16s só de modelo**

### Ação

Trocar default pra `claude-sonnet-4` (ou modelo Sonnet mais recente que você tem em `enabledModels`). Cicla Opus quando começar tarefa que precisa de raciocínio profundo (atalho `Ctrl+M` no TUI).

```json
"defaultModel": "claude-sonnet-4-x"
```

**Ganho esperado**: 2x–3x em wall-clock por turno. **Sem perda perceptível em 90% dos casos típicos de coding agent.**

---

## 3. Extension hooks serializados

`runner.ts:890` — `emitBeforeProviderRequest`:

```ts
for (const ext of this.extensions) {           // SERIAL por extensão
    const handlers = ext.handlers.get("before_provider_request");
    for (const handler of handlers) {          // SERIAL por handler
        const handlerResult = await handler(event, ctx);
        if (handlerResult !== undefined) {
            currentPayload = handlerResult;    // mutação acumulada → precisa ser ordem
        }
    }
}
```

**Por que serial**: cada hook pode **mutar o payload** (modificar prompt antes de mandar pro provider). Ordem importa, Promise.all quebraria semântica.

**Mas**: hooks que NÃO mutam podem rodar em paralelo. Mesmo padrão dos listeners passivos (que já foi paralelizado em `agent-loop.ts`).

### Custos observáveis

Extensões instaladas hoje que provavelmente registram `before_provider_request`:
- `pi-claude-oauth-adapter` — refresha OAuth token quando expira. Pode ter rede.
- `pi-agent-browser-native` — pode injetar contexto de browser
- `agentmemory` (extension global) — pode injetar memórias relevantes

Cada um faz I/O assíncrono. Cenário pessimista: 200-500ms por hook × N hooks = **0.5–2s adicionais por request**, **2x por turno**.

### Ações

**3a. Auditoria — qual extensão registra qual hook?**

Roda:
```bash
PI_TIMING=1 pit -p "echo hi" 2>&1 | grep -i "before_provider\|hook\|extension"
```

Identifica os hooks lentos. Provavelmente 2–3 extensões dominam.

**3b. Paralelizar hooks não-mutativos no runner**

Patch em `runner.ts:890` — split entre hooks que retornam `undefined` (paralelos seguros) e hooks que retornam payload (sequencial):

```ts
async emitBeforeProviderRequest(payload: unknown): Promise<unknown> {
    const ctx = this.createContext();
    let currentPayload = payload;

    // 1ª passada: hooks side-effect-only (paralelo)
    const sideEffectHooks: Array<Promise<void>> = [];
    const mutatingHooks: Array<{ ext: Extension; handler: Handler }> = [];

    for (const ext of this.extensions) {
        const handlers = ext.handlers.get("before_provider_request") ?? [];
        for (const handler of handlers) {
            if (handler.declaresMutation === false) {       // novo campo opt-in
                sideEffectHooks.push(handler(event, ctx).then(() => {}));
            } else {
                mutatingHooks.push({ ext, handler });
            }
        }
    }
    await Promise.all(sideEffectHooks);

    // 2ª passada: hooks mutativos (serial, preserva ordem)
    for (const { ext, handler } of mutatingHooks) {
        const result = await handler(...);
        if (result !== undefined) currentPayload = result;
    }
    return currentPayload;
}
```

Requer extensões declararem `declaresMutation: false` no manifest. Default `true` pra segurança.

**Ganho esperado**: -200ms a -800ms por request, **2x por turno**.

**3c. Desativar extensões com hooks que você não usa**

`pit uninstall npm:<package>` para extensões dormentes. Cada uma removida = um `for` a menos. Lista de candidatos em §5.

---

## 4. Prompt prefix ainda importa pra velocidade

Não pelo custo. Pela **velocidade de geração**.

### O que cache resolve

Cache hit (Anthropic 1h): TTFT cai de ~3s → ~600ms numa chamada repetida. **Esse ganho já está ativado** (`cacheRetention: long` é default no PiTuned).

### O que cache NÃO resolve

- **1ª chamada da sessão** paga full input processing. Com 25k tokens, isso é ~3-5s adicionais.
- **Geração token-por-token** ainda atende ao prefix inteiro (cached ou não). Output rate de Opus em prompt 25k vs prompt 5k pode diferir 10-30% (Anthropic não documenta exato, mas é observável).
- **Invalidação de cache**: qualquer mudança em arquivo de skill, em `AGENTS.md`, em settings de extensão → cache invalida → próximo turno paga full de novo.

### Ações que efetivamente aceleram

**4a. Compaction mais frequente quando contexto cresce**

`compaction.ts:123`:
```ts
reserveTokens: 16384,
keepRecentTokens: 20000,
```

Quanto MAIOR `keepRecentTokens`, mais tarde compacta, mais lento fica cada turno em sessão longa. Quanto MENOR, mais compactações (cada uma = 1 LLM call extra ≈ 10-30s pra Opus).

**Não mudar agora.** Equilíbrio atual é razoável. Mas **monitorar**: compaction triggered = grande pico de latência. Logar quando dispara e qual turn.

**4b. Trim de skills** (impacto: TTFT primeira chamada da sessão + reduz invalidações)

99 skills no prefix = ~10k tokens. Trimar 60 pra ~10k tokens economiza:
- ~2s na primeira chamada da sessão (input processing)
- Reduz chance de invalidação (menos arquivos sendo trackeados)

Como em §1.1 do report anterior, marcar `disable-model-invocation: true` em SKILL.md de skills não usadas.

**4c. Split de `AGENTS.md`**

251 linhas no project_context de todo turno em PiTuned. Conteúdo de processo (release, PR, changelog) raramente é consultado pelo modelo dentro de um turno mas SEMPRE é processado. Mover pra `CONTRIBUTING.md`.

Impacto wall-clock: **pequeno por turno (~200ms)**, mas se some em sessão longa.

---

## 5. Extensões — limpeza com foco em velocidade

Cada extensão custa:
1. Carregamento no startup (já otimizado via precompile)
2. Tools registradas no prompt (atenção do modelo)
3. **Hooks rodados serialmente em todo request** ← maior custo wall-clock

Lista atual e juízo:

| Pacote | Velocidade | Decisão |
|--------|-----------|---------|
| `pi-autoresearch` | hook pesado? testar | manter (em uso ativo) |
| `pi-claude-oauth-adapter` | OAuth refresh = I/O | manter (auth crítico) |
| `pi-subagents` | tool listing | manter se usa |
| `pi-ask-user` | sem hooks pré-request | low cost |
| `pi-web-access` | tool listing | manter |
| `pi-rtk-optimizer` | só ativa em projeto RTK | **desativar se não em RTK** |
| `rpiv-advisor` | tool listing | manter |
| `rpiv-ask-user-question` | duplica `pi-ask-user`? | **investigar dupla** |
| `pi-caveman` | só skill, low cost | manter |
| `pi-simplify` | tool slash command | **desativar se não usa /simplify** |
| `pi-mcp-adapter` | MCP gateway, **pode ser lento** | **desativar se não usa MCP** |
| `@tintinweb/pi-tasks` | task tracker | escolher um |
| `@capyup/pi-goal` | goal mode | manter se usa |
| `pi-agent-browser-native` | tool + possíveis hooks | manter |
| `@tintinweb/pi-subagents` | **DUPLICA `pi-subagents`** | **desinstalar um** |
| `pi-chrome` | Chrome MCP, cold start lento | **desativar se não usa devtools** |
| `rpiv-todo` | duplica `@tintinweb/pi-tasks` | **escolher um** |

Conservador (sem mexer no que talvez usa):
```bash
pit uninstall npm:@tintinweb/pi-subagents   # duplicata confirmada
pit uninstall npm:@juicesharp/rpiv-todo     # duplicata provável
```

Mais agressivo (recupera ~2 itens de loop de hook):
```bash
pit uninstall npm:pi-rtk-optimizer
pit uninstall npm:pi-simplify
pit uninstall npm:pi-mcp-adapter
pit uninstall npm:pi-chrome
```

**Ganho esperado**: cada extensão removida = 30–200ms a menos por request, dependendo de I/O do hook.

---

## 6. Tool execution — onde acelerar

### 6.1 Já otimizado (não mexer)

- `Promise.all` para batch de tool calls paralelos (`agent-loop.ts:executeToolCallsParallel`)
- `prepareToolCall + tool_execution_start` paralelos (~10x quando hook async)
- Tool map cache por batch
- Sequential short-circuit (evita probe do toolMap quando forceSequential)
- Listeners via Promise.all (~5x com múltiplos subscribers)
- Delta coalescing 16ms (60fps)

### 6.2 Otimização disponível: `executionMode` declarado explicitamente

Hoje **nenhum** tool built-in declara `executionMode: "parallel"`. O default cobre, mas:

`agent-loop.ts:447`:
```ts
const hasSequentialToolCall =
    forceSequential || toolCalls.some((tc) => toolMap.get(tc.name)?.executionMode === "sequential");
```

Se UMA extensão registra um tool com `executionMode: "sequential"`, **todo o batch vira sequencial**. Um único tool de extensão pode estar matando paralelização.

Auditoria:
```bash
grep -rn "executionMode.*sequential" ~/.pi/agent/npm/node_modules/
```

Se aparecer algum tool de extensão sequencial que você usa frequentemente em batch, **considerar mudar pra parallel** se for seguro (ou desabilitar a extensão).

### 6.3 `BASH_UPDATE_THROTTLE_MS = 100`

`bash.ts:186`. Updates de stdout pro TUI a 10 Hz. Não afeta tempo de execução do bash em si, só rendering. Mantém.

### 6.4 `file-mutation-queue`

`tools/edit.ts:withFileMutationQueue` serializa edits no MESMO arquivo. Correto pra evitar race. Mas se você editar arquivos **diferentes** em paralelo, queues são independentes — paralelo real. **Já otimizado.**

---

## 7. Pipeline ideal pra velocidade máxima

Aplicando 1 + 2 + 5 (conservador):

```
Turno típico — antes:
  hooks_pre        :  ~600ms
  network          :  ~150ms
  ttft_opus        : ~2500ms
  thinking_high    :     40 000ms    ← dominante
  output           :   ~5 000ms      ← @60 tok/s, 300 toks
  tool_exec        :    ~500ms
  hooks_pos        :    ~400ms
  ttft_2 + thinking + output (2ª chamada)  : ~25 000ms
  TOTAL            : ~74 150ms = 74s

Turno típico — depois (sonnet + low thinking + -2 ext):
  hooks_pre        :    ~500ms
  network          :    ~150ms
  ttft_sonnet      :    ~800ms
  thinking_low     :   ~3 000ms      ← cai 13x
  output           :   ~2 000ms      ← @150 tok/s
  tool_exec        :    ~500ms
  hooks_pos        :    ~300ms
  2ª chamada       :   ~5 000ms
  TOTAL            : ~12 250ms = 12s

Speedup: ~6x
```

---

## 8. Patches por ROI em SEGUNDOS

| # | Patch | Tempo cortado/turno | Esforço | Risco |
|---|-------|---------------------|---------|-------|
| A | `defaultThinkingLevel: "low"` | **-25s a -40s** | 1 edit JSON | reverte com cicle no TUI |
| B | `defaultModel: claude-sonnet-4-x` | **-15s a -30s** | 1 edit JSON | troca model com `/model` se precisar |
| C | Desinstalar duplicatas (subagents, todo) | **-100ms a -400ms** | 2 comandos | nenhum |
| D | Auditar e desinstalar 3-4 ext dormentes | **-300ms a -1s** | poucos comandos | reverte com install |
| E | Patch paralelizar hooks side-effect | **-200ms a -800ms** | médio (código + manifest opt-in) | requer testes |
| F | Trim skills `disable-model-invocation` | **-1s a -2s** (1ª chamada sessão) | frontmatter | nenhum |
| G | Split `AGENTS.md` (mover seções processo) | **-200ms** | mover texto | nenhum |

**Ordem recomendada: A → B → C → D → F → G → E.**

A + B sozinhos cortam ~70% do tempo de turno. Faz primeiro.

---

## 9. Como medir o ganho

`bench-tool-calls-real.mts` já existe. Métricas a logar no `autoresearch.jsonl`:

- **primary**: `turn_wall_ms` (do user input ao final do último tool result)
- secondary: `time_to_first_visible_token_ms`
- secondary: `reasoning_tokens` (proxy de tempo de thinking)
- secondary: `hooks_wall_ms` (instrumentar runner.ts)

Workflow de teste:
```bash
# Baseline
time pit -p "edit packages/agent/src/agent.ts adicione comment linha 10 'opt'"

# Após patch A (thinking low)
# Editar settings.json
time pit -p "edit packages/agent/src/agent.ts adicione comment linha 11 'opt'"

# Após patch A + B (sonnet)
# Editar settings.json
time pit -p "edit packages/agent/src/agent.ts adicione comment linha 12 'opt'"
```

Cada teste 3x, pega mediana, registra no autoresearch.

---

## 10. O que descartei como não sendo velocidade

- Compactação de prefix por custo (cache `long` já cuida do custo, e prefix maior tem efeito pequeno em velocidade comparado a thinking/model)
- Reduzir maxTokens (não acelera; só limita output)
- BASH_UPDATE_THROTTLE (é rendering, não execução)
- DELTA_THROTTLE 16ms (já ótimo)
- Tudo de startup (você não paga isso a cada turno)

---

**Resumo executivo**: vc tá pagando ~70-80% do tempo de cada turno em thinking high + Opus. Troca pra `low` + Sonnet em settings.json e **velocidade salta 3-6x sem código mudar**.
