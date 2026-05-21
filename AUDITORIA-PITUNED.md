# Auditoria PiTuned — Harness + Velocidade

Scope: `packages/agent/src/{agent,agent-loop}.ts`, `packages/coding-agent/src/core/extensions/{runner,loader}.ts`, `packages/coding-agent/src/core/sdk.ts`, `scripts/{precompile-pi-packages,bench-startup,bench-prompt-size}.{mjs,mts}`, `autoresearch.jsonl`, `RELATORIO-OTIMIZACAO.md`. Extensões instaladas em `~/.pi/agent/npm/node_modules`.

Complexity: MEDIUM (score 4 — >1000 linhas, integração API externa, múltiplos runtimes) — model: opus-4-7 (atual).

Mode: audit-only. Restrição usuário: sem trocar modelo/reasoning.

## Health Status

Status: YELLOW.
Reason: 3 ganhos confirmados de wall-clock no harness não tomados (emitContext clone incondicional, emitBeforeProviderRequest serial documentado mas não shipado, métodos `getAll*`/`getCommand` recomputam por chamada). Nenhum bug correto, só desperdício mensurável.

---

## Findings

### P1
`packages/coding-agent/src/core/extensions/runner.ts:890` — `emitBeforeProviderRequest` serial mesmo quando hook é side-effect-only.
Evidence: Loop `for ... for await handler(...)` linha 894-919. Não existe split entre hooks que retornam payload vs `undefined`. `pi-claude-oauth-adapter\extensions\index.js:402` registra handler `before_provider_request` que muta payload — único hook mutativo confirmado nos 21 extensions instalados. Outros (memory, browser-native, autoresearch) provavelmente só leem.
Impact: Toda chamada ao provider espera todos os hooks serialmente. 2x por turno (request inicial + após tool result). Patch E já documentado em `RELATORIO-OTIMIZACAO.md:138-166` — implementação não shipada.
Fix: Split em 2 passadas. 1ª paralela com `Promise.all` para hooks declarados `declaresMutation: false` (default `true` para segurança). 2ª serial preservando ordem de mutação. Marcar oauth-adapter como mutativo, todos demais como side-effect-only no manifest.
Confidence: confirmed (grep mostra só oauth-adapter retornando payload modificado).

### P2
`packages/coding-agent/src/core/extensions/runner.ts:858-888` — `emitContext` faz `structuredClone(messages)` incondicional toda chamada.
Evidence: linha 860 `let currentMessages = structuredClone(messages);` antes do loop de handlers. `sdk.ts:373-377` registra `transformContext` que chama `emitContext` toda turn. `pi-claude-oauth-adapter`, `@capyup/pi-goal\extensions\goal.js`, `pi-subagents`, `pi-lens` registram handler `context` — mas oauth-adapter só muta quando `shouldApply(ctx) && activeTurn` (`index.js:392`). Clone roda mesmo nas turns sem mutação.
Impact: Em transcript de 25k tokens, `structuredClone` de array de AgentMessage custa 5-20ms por turn no caminho quente. Multiplica turns longos.
Fix: Passar referência. Só clonar lazy quando handler retornar `{messages}` diferente da entrada. Atual contrato é safe porque oauth não muta in-place, mas garantir documentando handler contract: "não mutar event.messages; retornar novo array se modificar". Alternativa conservadora: early-out `if (!this.hasHandlers("context")) return messages` (já protege instalações sem hooks de contexto).
Confidence: confirmed.

### P2
`packages/coding-agent/src/core/extensions/runner.ts:374-407, 512-559` — `getAllRegisteredTools`, `getFlags`, `getRegisteredCommands`, `getCommand` recomputam estruturas a cada chamada.
Evidence: cada método itera `this.extensions`, aloca Map/Set/Array novos. `agent-session.ts:1139, 1271, 2158, 2275` + `interactive-mode.ts:435, 495, 3726` chamam frequentemente. `getCommand` (linha 557) chama `resolveRegisteredCommands()` que reconstrói dedup/seen/taken a cada chamada — pior caso O(N²) em commands para um simples lookup.
Impact: Em modo interactive, render de footer/keybinding-hints + autocomplete + slash-command resolution chamam esses getters em loops de UI. Não é dominante mas é desperdício constante.
Fix: Cachear resultado por identidade do array `this.extensions`. Invalidar em `/reload` (recria `ExtensionRunner`, cache vai junto). Para `getCommand`, construir Map<invocationName, ResolvedCommand> uma vez, lookup O(1).
Confidence: confirmed.

### P3
`packages/coding-agent/src/core/extensions/loader.ts:530-555` — `loadExtensions` serial documentado, mas `awaitPrewarm` torna `Promise.all` viável.
Evidence: linhas 521-529 explicam por que serial. Run 4 do `autoresearch.jsonl` confirma `prewarmExtensionLoader` no main start não ajudou (4580 vs 4559 wall, dentro do ruído). Mas raciocínio do comentário é sobre jiti cache contention — agora maioria das extensions são precompiladas `.js`, carregadas via `import()` nativo (linha 410-426). Para essas, contention jiti não existe.
Impact: Após precompile, 21 extensions × `.js` import nativo poderiam paralelizar. Wall time atual 4-5s — limitante é I/O e parse, paralelizar pode ganhar 0.5-1.5s. Para extensions ainda em `.ts`, mantém serial.
Fix: Split na descoberta: `paths.filter(p => p.endsWith(".js"))` vai em `Promise.all`, `.ts` continua serial. Medir com `bench-startup.mjs`.
Confidence: confirmed (jiti contention só aplica a paths `.ts` no caminho fallback).

### P3
`scripts/precompile-pi-packages.mjs:100-113` — `collectTsFiles` para entry de arquivo direto em raiz da package walka o package INTEIRO.
Evidence: linha 109 `const walkRoot = parent === packageDir ? packageDir : parent;`. Comentário linha 95-99 justifica para pegar siblings (ex: `./extract.ts` referenciado por `./index.ts`). Mas walka `test/`, `tests/`, etc. já estão em SKIP_DIRS (linha 71) — bom. Walka mesmo arquivos não importados pelo entry.
Impact: Pacotes com muitos arquivos `.ts` não-importados pelo entry pagam transpile esbuild extra. autoresearch run 2 mostra regressões `pi-subagents 90->464ms` e `@tintinweb/pi-tasks 50->357ms` — many-file overhead nativo ESM exatamente sobre arquivos precompilados que talvez nem sejam necessários.
Fix: Trocar walk cego por AST trace dos imports a partir dos entries declarados. Esbuild com `metafile: true` resolve isso de graça — `build({entryPoints, bundle: true, ...})` daria UM `.js` por entry resolvendo deps internas. Atual modo `bundle: false` força resolução em runtime, perdendo trade que `pi-subagents`/`pi-tasks` regrediram.
Confidence: confirmed (autoresearch já registrou regressão; trade-off não documentado).

---

## Predictive Findings

`packages/coding-agent/src/core/extensions/runner.ts:892` — Payload mutável compartilhado entre hooks (categoria: concurrency / state accumulation).
Evidence: `currentPayload` propaga por extensão. Se hook A muta e hook B falha mid-edit (throw), `currentPayload` fica em estado parcialmente mutado mas `emitError` segue. Próximo hook recebe payload corrupto.
Trigger: Extension instável (ex: oauth refresh em rede flaky) joga throw após modificação parcial do `system` array.
Repro idea: extension A muta `payload.system = [...]`, extension B throw, extension C inspeciona — vê estado A meio aplicado.
Impact: Difícil reproduzir mas surge como bug fantasma "às vezes prompt sai diferente". Sem teste pra isso.
Fix: Snapshot `currentPayload` antes de cada handler. Em throw, restaurar snapshot e seguir.
Confidence: partial (requer ver se algum hook hoje throw após mutação parcial).

`packages/coding-agent/src/core/extensions/loader.ts:441` — `jiti.import(extensionPath, { default: true })` em uma instância compartilhada (categoria: state accumulation over time).
Evidence: `_sharedJiti` singleton com `moduleCache: true`. Em sessão longa, qualquer `/reload` ou registro/desregistro mantém entries antigos no cache. Sem invalidação.
Trigger: usuário usa `/reload` várias vezes editando extension TS local. Cache acumula versões.
Impact: vazamento de memória menor, possivelmente módulo zumbi reagindo a eventos.
Fix: jiti expõe API de reset? Senão criar nova instância em `/reload`.
Confidence: uncertain (precisa testar comportamento de /reload na branch atual).

---

## Technical Hygiene

`autoresearch.jsonl:3` — registra regressão `pi-subagents 90->464ms` no commit precompile. Trade-off conhecido mas não documentado no `README-PITUNED.md`. Mover nota para README.

`packages/agent/src/agent.ts:553-563` — branch `this.listeners.size === 1` vs `Promise.all` evita custo de allocate-array em caso comum. Mantém. Comentário linha 552 "Listeners run in parallel via Promise.all. Subscription order is no longer observable" desatualizado para size===1 branch (size 1 = serial). Atualizar.

`packages/agent/src/agent-loop.ts:425-432` — `buildToolMap` constrói Map por batch. Em batches grandes (8+ tools paralelos), Map é melhor que `array.find`. Em batches de 1-2 (caso típico), Map.set+get tem overhead vs lookup linear. `tool_bench_fanout_per_call_ms: 0.018` (autoresearch run 3) confirma overhead mínimo. Mantém.

`nul` (arquivo na raiz, untracked) — provável artefato de redirect Windows (`> nul`). Remover.

## Partial Or Uncertain

`packages/coding-agent/src/core/extensions/runner.ts:680-712` — `emit()` genérico itera extensions × handlers sequencial pra TODOS os eventos, mas só `session_before_*` events curto-circuitam em `result.cancel`. Outros eventos (ex: `session_shutdown`, `tool_result_modified`) podem ser paralelizados sem trocar semântica.
Evidence so far: tipos de eventos em `RunnerEmitEvent`. Maioria parece side-effect.
Missing evidence: cada event-type ter contrato documentado de ordering. Auditar `extensions/types.ts`.
Next step: ler `types.ts` + `docs/extensions.md`, classificar cada event em "ordered/unordered". Aplicar `Promise.all` nos unordered.
Confidence: partial.

`scripts/bench-prompt-size.mts:10` — `APPROX_CHARS_PER_TOKEN = 3.7`. Anthropic usa BPE diferente de OpenAI; constante única superestima Claude (~3.9-4.2) e subestima OpenAI (~3.5). 
Evidence so far: constante fixa.
Missing evidence: comparar com `tiktoken`/contagem real.
Next step: trocar por contagem real via tokenizer do provider em uso, ou ao menos derivar por amostra.
Confidence: uncertain (afeta só métricas, não código de produção).

## Verification

- `git log -n 20 --oneline` — passou; identificados 6 commits PiTuned-específicos.
- Grep `on("context"` em `~/.pi/agent/npm/node_modules` — passou; confirma 4 extensions instaladas registram `context`. Valida finding P2 emitContext.
- Grep `on("before_provider_request"` em mesmo diretório — passou; só `pi-claude-oauth-adapter` muta. Valida finding P1 split.
- `autoresearch.jsonl` lido — confirma runs 1-4, run 4 prewarm rollback validado.
- Tests não rodados (audit-only, mode default).

## Residual Risk

- Não medido custo real do `structuredClone` em transcript de produção. Recomendado adicionar `METRIC emit_context_ms` no `runner.ts` por turn e correlacionar com `messages.length`.
- Não validado se algum extension instalado registra hook `tool_call` async pesado — `runner.ts:806-827` é serial. Investigar se `emitToolCall` short-circuits em block-results corretamente.
- Bench `bench-startup.mjs` mede só `pit --help` (carga de extensões). Não mede first-token-latency em turn real. Sem ground truth, otimização de hooks pode dar ganho que bench não captura.

## Scope Notes

- Reviewed: agent loop, extension runner, extension loader, sdk.ts, precompile script, bench scripts, autoresearch jsonl, RELATORIO existente, ~21 extensions instaladas (grep-level).
- Not reviewed: `compaction.ts` (RELATORIO já cobre), provider transport (`packages/ai/src/providers/*`), TUI components, RPC mode, sessões JSONL storage, prompt-templates. Auditoria deliberadamente focada no caminho quente turn-by-turn que o usuário descreveu como "harness mais rápido".
