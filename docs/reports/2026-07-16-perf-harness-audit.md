# Auditoria de desempenho e harness — Pit (2026-07-16)

Análise de ponta a ponta feita por 5 agentes Fable em paralelo, um por dimensão:
startup/cold-start, runtime do agent loop, camada de providers (@pit/ai),
TUI/responsividade interativa e harness de desenvolvimento. Todas as sugestões
seguem as restrições do projeto: **nativas, on-by-default, zero config manual**,
escape hatch via `PIT_NO_*`, e qualquer cache proposto tem invalidação automática
(mtime/content-key) com fallback para o src recém-editado.

Baselines medidos nesta máquina (Windows 11, Node 22.22):

| Métrica | Hoje | Potencial estimado |
|---|---|---|
| Boot interativo até prompt utilizável | ~4,5–7 s | ~2–2,5 s |
| `pit --version` | 1.373 ms | ~316 ms |
| `pit --help` | 3,4–8 s | < 1 s |
| TTFT (primeiro token por turno) | +40–200 ms de TLS refeito quase todo turno | eliminável |
| Pre-commit (`check:static`) | ~9 s wall | ~5–6 s |
| Pre-push (`npm run check`) | 59 s **e flaky (2/3 falhas espúrias)** | 59 s confiável |
| `check:fast` | 53,8 s (só 6 s mais rápido que o completo) | segundos com `--changed` |

---

## 1. Velocidade de uso — startup (maior ganho absoluto)

### 1.1 Launcher usa wrapper tsx (2 processos) — trocar por `node --import tsx` — **S, ~0,4–1,0 s em todo boot**
- `bin/pit:27`, `bin/pit.cmd:26`, `pi-test.ps1:31` fazem `exec tsx` (processo wrapper + shim .cmd).
- Medido: `--version` 1.373 ms → 316 ms; `tsx -e ""` 530–690 ms vs `node --import tsx -e ""` ~290 ms.
- Fix: `exec node --import "file://$REPO_ROOT/node_modules/tsx/dist/loader.mjs" "$CLI" "$@"` nos 3 launchers. Mesmo pipeline tsx, zero staleness, zero config.

### 1.2 `execSync("claude --version")` bloqueante no boot — **S/M, 0,4 s típico, até 2,7 s cold**
- `main.ts:786` → `claude-code-version.ts:27`: `execSync` (timeout 3 s × 2 candidatos) antes do runtime.
- Fix: spawn assíncrono disparado no topo de `main()` que seta `PIT_CLAUDE_CODE_VERSION` quando resolver (o valor só é necessário no 1º request Anthropic; os ~2,4 s de module-eval do runtime acontecem em paralelo → custo líquido ~0). Cachear resultado em `~/.pit/agent/` keyed por mtime do `claude.cmd`.

### 1.3 Grafo built-ins + sdk = ~2,4 s de module-eval serial — **M, 0,3–0,8 s + habilita 1.2**
- Timing interno: `createRuntime-start: 2401ms` (`main.ts:684-685`); `coordinator-extension.ts` sozinho ~915 ms; `agent-session.ts` é god-module (~170 linhas de import, incl. export-html, lsp, chrome-devtools).
- Fix (a) **S**: disparar `import("./core/agent-session-services.ts")` logo após `parseArgs`, sobrepondo com migrations/sessionManager/claude-version. (b) **M/L**: converter leaves raros-no-boot (export-html, chrome, lsp, debug-verify) em `await import()` no call-site — padrão já usado em `main.ts` para theme/session-picker/modes.

### 1.4 `--help` constrói o runtime completo — **M, 3–7 s → <1 s**
- `main.ts:797-803`: help só é tratado depois de `createAgentSessionRuntime`.
- Fix: help estático imediato + flags de extensão de cache em `~/.pit/agent/` keyed por paths+mtimes (miss → caminho atual). Escape `PIT_NO_HELP_CACHE`.

### 1.5 Imports eager evitáveis — **S, ~0,5–0,8 s somados**
- Subcomandos importados sempre: `main.ts:42-44` (`package-manager-cli` = 372–392 ms) → lazy por prefixo de argv.
- `cli/args.ts:9` arrasta o barrel de permissions → tools → `@pit/ai` inteiro (617–873 ms no grafo) só para `normalizePermissionMode` → importar `permissions/types.ts` direto.
- `cli.ts:8,19`: undici (135–161 ms) importado antes do early-exit `--version` → mover para depois.

### 1.6 Boot: I/O sync e bloqueios do primeiro paint — **M, ~0,4–0,6 s somados**
- `reload-package-resolve` = 319 ms de fs sync (`resource-loader.ts:428-434`, `package-manager.ts:894`) → cache de `ResolvedPaths` em disco keyed por mtimes. Escape `PIT_NO_RESOLVE_CACHE`.
- `reload-update-skills` = 201 ms lendo ~160 SKILL.md sync (`resource-loader.ts:571-572`) → `fs/promises` + `Promise.all`, ou ler só o frontmatter; sobrepor com o paint inicial.
- `interactive-mode.ts:826`: `ensureTool("fd"/"rg")` bloqueia `ui.start()` → iniciar UI primeiro, resolver em background; cachear path resolvido do PATH.

### 1.7 Infra de medição com pontos cegos — **S, habilita as próximas rodadas**
- `printTimings()` inalcançável em `--help`/`--dry-run` (`main.ts:802,828`); custo pré-`main()` (~0,9–1,7 s de tsx boot + eager imports) invisível ao `PIT_TIMING`; `bench-startup.mjs:36` usa `shell:true` no Windows (+50–100 ms de ruído).
- Fix: `printTimings()` antes dos early-exits; `time("module-eval")` no topo de `cli.ts`; bench com `shell:false`.

Nota: precompilar o repo **não** vale — a invalidação por conteúdo do tsx já dá fallback automático ao src editado (requisito do dono); `NODE_COMPILE_CACHE` sob tsx mediu ganho zero. O `precompile-pi-packages.mjs` para extensões já tem contrato de frescor correto.

---

## 2. Velocidade de uso — TTFT e rede (ganho por turno, toda sessão)

### 2.1 Keep-alive de 4 s: TCP+TLS refeito praticamente a cada turno — **S, +40–200 ms de TTFT em quase todo turno — prioridade máxima da camada**
- `packages/coding-agent/src/cli.ts:19`: `EnvHttpProxyAgent` sem `keepAliveTimeout` (default undici = 4.000 ms). O gap entre turnos (tools + render + digitação) quase sempre excede 4 s → socket fechado → DNS/TCP/TLS novos.
- Fix: `keepAliveTimeout: 60_000` (+ `keepAliveMaxTimeout` coerente). Escape `PIT_KEEPALIVE_MS`/`PIT_NO_KEEPALIVE_TUNING`.
- **Par obrigatório:** `retry-with-fallback.ts:29-31` não cobre `ECONNRESET`/`EPIPE`/`socket hang up` — adicionar à regex retryable (socket idle morto pelo servidor vira ECONNRESET no POST seguinte).

### 2.2 `allowH2: false` penaliza fan-out de subagentes — **M**
- `cli.ts:19`: HTTP/1.1 → 1 socket TLS por request concorrente no coordinator/fanout.
- Fix: `allowH2: true` on-by-default com `PIT_NO_HTTP2`; exige soak de SSE-sobre-H2 contra Anthropic/ChatGPT backend antes de promover.

### 2.3 Refresh OAuth bloqueia o primeiro request após expiração — **S/M, +0,3–1,5 s esporádico (pior caso 30 s)**
- `auth-storage.ts:513-543` + `oauth/anthropic.ts:240-258`: refresh síncrono no hot path do `getApiKey`.
- Fix: pre-refresh fire-and-forget ao fim do turno quando `expires - now < ~10 min` (o file lock já resolve corrida multi-instância). Escape `PIT_NO_OAUTH_PREFRESH`.

### 2.4 Anthropic SDK com `maxRetries` default (2) — stalls mudos antes do TTFT — **S**
- `anthropic.ts:513-517`: backoff exponencial invisível à TUI; empilha com a camada de retry/fallback do AgentSession (que tem UI e fallback-chain).
- Fix: clamp de `maxRetries` para 0–1 no provider por default; escape `PIT_NO_PROVIDER_RETRY_CLAMP`.

### 2.5 Micro-otimizações de CPU por token — **S, opcionais**
- Codex: `JSON.stringify(body)` do contexto inteiro computado mesmo no caminho WS default (`openai-codex-responses.ts:176`) → lazy no primeiro uso (~1,2 ms/turno @ 500 KB).
- Codex WS: probe de continuação re-verifica a história inteira por turno (`openai-codex-responses.ts:1302-1329`) → comparar só além do prefixo verificado + memoizar stringify de instructions/tools (**M**).
- SSE Anthropic: scan de `\r` amplifica ~12× o line-split (`anthropic.ts:322-332`, 44 µs vs 3,7 µs por chunk de 16 KB) → buscar `\n` primeiro.
- `flushSseEvent` clona `raw` por evento sem necessidade (`anthropic.ts:288`) → transferir referência.

---

## 3. Custo (tokens/$$)

### 3.1 Cache retention "long" (1 h) paga escrita 2× sem ganho em sessão ativa — **S/M**
- `anthropic.ts:45-58,492`: TTL 1 h = write premium 2,0× vs 1,25× do 5 m; leituras renovam TTL de graça, então sessões com gaps < 5 min têm hit rate idêntico com "short".
- Fix: retention adaptativo — "short" para subagentes/one-shot, "long" só para a sessão interativa principal. Escape já existe (`PIT_CACHE_RETENTION`).

O prompt caching em si está exemplar nos dois providers (4 breakpoints bem gastos no Anthropic; instructions byte-estável + `prompt_cache_key` no Codex) — não mexer.

---

## 4. TUI / responsividade interativa

O pipeline já é excepcionalmente otimizado (lex incremental, virtualização, memos, throttle 16 ms). Restou:

### 4.1 Carga síncrona do highlight.js (~96 ms) no fechamento do primeiro fence — **S, freeze visível 1×/sessão**
- `syntax-highlight.ts:4-22` (lazy deliberado) + `theme.ts:1261-1279`: load de 96 ms + highlight 1–11 ms no mesmo tick em que o primeiro bloco de código fecha — congela spinner/teclado ~100 ms mid-stream.
- Fix: pré-aquecer o hljs em idle após o primeiro paint (`setImmediate` pós-start da TUI). Escape `PIT_NO_HLJS_PREWARM`.

### 4.2 Highlight re-executa em todo step de resize — **S/M**
- `markdown.ts:406-429`: `tokenLineCache` keyed por width, mas a saída do hljs independe de width. Transcript com ~20 blocos ≈ +40–150 ms por step do drag de resize.
- Fix: memo módulo-level `(code, lang) → linhas highlighted` (mesmo padrão do `cellWrapCache`), sobrevivendo a `freeze()` e resize.

### 4.3 Transcript inteiro vive no frame para sempre — O(N do histórico) por frame — **L, só se sessões longas forem alvo**
- Virtualização cobre o render, mas flatten/`applyLineResets`/diff/`extractCursorPosition` continuam O(N linhas totais): 0,271 ms/f @ 8 k linhas (linear, ~34 ns/linha) → ~1,7 ms/f @ 50 k, pago a 60 fps durante streaming.
- Fix: culling de scrollback (filhos settled acima de um high-water são commitados ao scrollback do terminal e saem do frame vivo). Trade-off: perde re-wrap do histórico em resize. Escape `PIT_NO_TRANSCRIPT_CULL`.
- Isso subsume os 3 "Remaining Opportunities" do PERF_LOG.md — não mexer neles isoladamente.

### 4.4 Alocações O(N) de flatten por frame durante streaming — **S/M**
- `tui.ts:405-423` + `virtualized-container.ts:199-215`: prefixo quase inteiro re-alocado em cada nível de aninhamento, todo frame de 16 ms (~11 MB/s de churn de GC @ 8 k linhas).
- Fix: double-buffer dos arrays de flatten (padrão já existente no repo: `decorBufferA/B`, `resetBuffer*`).

Prioridade baixa (registrados, não recomendados agora): tick de reveal a 30 fps quando backlog pequeno; fast-path no `updateContent` por chunk.

---

## 5. Runtime do agent loop

Já está em nível de µs por turno (rodadas P01–P04, M5–M12, T02–T10 anteriores). Restos:

### 5.1 Fan-out de eventos serializa o stream em listeners lentos — **M, proteção arquitetural**
- `agent.ts:692-702`: `processEvents` aguarda todos os listeners antes do próximo evento. Hoje custo ~0 (nenhum built-in registra handlers de update), mas listener de 1 ms → ~1 s/turno medido (`read_listener_overhead_ms=1039`).
- Fix: estender o padrão P04 (fila ordenada, drenada em boundaries) ao dispatch do `Agent`. Escape `PIT_NO_DECOUPLED_EVENT_FANOUT`.

### 5.2 TTSR re-escaneia o rolling buffer com todas as rules a cada delta cru — **S**
- `agent-loop.ts:786-797` + `ttsr.ts:129-148`: R rules × 2 KB × N deltas (~40 M chars re-escaneados numa resposta de 2000 deltas com 10 rules); escala com rules aprendidas via hindsight.
- Fix: mover o `feed` para o flush do delta coalescido de 16 ms (buffer idêntico, detecção atrasa ≤16 ms, ~50–100× menos passes). Escape `PIT_NO_TTSR_COALESCED_FEED`.

### 5.3 `stableArgsFingerprint` descartado no caminho comum — **S**
- `agent-loop.ts:1359`: fingerprint recursivo dos args antes do `beforeToolCall`, só consumido se `argsMutation.mutated` (~0% dos casos); 1,1 ms/1 MB em writes grandes.
- Fix: eliminar o par de fingerprints; quando `mutated`, revalidar com `validator.Check` (µs). Comportamento idêntico, sem flag.

### 5.4 Flush síncrono do learned-error store no turn boundary — **S**
- `agent-session.ts:2165` → `learned-error-store.ts:91-92`: `writeFileSync` + prune sync entre turnos (1–50 ms ocasional; pior em Windows com AV).
- Fix: gravação async com fila serializada (padrão `_drainQueue` do SessionManager); prune só no dispose.

---

## 6. Harness de desenvolvimento

### 6.1 Pre-push flaky: vitest morre sem sumário dentro do check-parallel — **S, P1 do harness**
- 2 de 3 execuções de `npm run check` falharam com `check failed: vitest` sem linha de sumário (crash, não assert); a suite direta passou (557 files/5105 tests/61,4 s). `check-parallel.mjs:115-152`; o token-bench sobrepõe o startup do vitest.
- Impacto: gate não confiável → hábito de `--no-verify` num repo público (é a origem real do problema registrado em memória).
- Fix: distinguir "crash sem sumário" de "testes falharam" e re-rodar o vitest 1× automaticamente com aviso; adiar o token-bench até o vitest imprimir progresso. Escape `PIT_NO_CHECK_RETRY`.

### 6.2 E2E live falha (em vez de pular) com credencial inválida — **S**
- `packages/ai/test/oauth.ts:57-95`: token que refresca mas está revogado passa o `skipIf` e falha live (ex.: `openai-codex-cache-affinity-e2e.test.ts:10`).
- Fix: capturar erro de auth (401/403/invalid_grant) → `ctx.skip("credencial inválida — renove o login")`; hard-fail mantido sob `CI`. Escape `PIT_NO_E2E_AUTOSKIP`.

### 6.3 token-bench falha falso em worktrees (DX-02, já diagnosticado) — **S**
- `plans/README.md:104-107`: `bench-session-tokens.mts:451` mede prefixo a partir de `process.cwd()` → em worktree o gate falha.
- Fix: derivar a raiz de `import.meta.url` / normalizar o path.

### 6.4 `check:fast` não é fast (53,8 s vs 59,2 s) — **M**
- Custo dominado por collect/transform por fork (`collect 775,95 s` CPU vs `tests 350,64 s`), não pelos testes excluídos.
- Fix: `vitest --run --changed` (nativo, git-aware) com fallback para a suite unit completa quando o diff toca arquivos core. Escape `PIT_NO_CHANGED_ONLY`.
- Raiz estrutural (**M/L**): isolamento por fork re-importa o grafo TS inteiro ~24×; testar `isolate: false`/pool threads no subset unit.

### 6.5 token-bench é 100% do caminho crítico do pre-commit — **S**
- `check:static`: `total=5919ms token-bench=5918ms` — roda 4 scripts tsx em todo commit.
- Fix: cache por hash de conteúdo dos inputs + baseline; hash igual ao último PASS → `token-bench: cached ok`. Pre-push/CI sempre rodam de verdade. Escape `PIT_NO_BENCH_CACHE`.

### 6.6 packages/ai, tui e agent não rodam em nenhum gate local — **M**
- `check-parallel.mjs:193-205`: workspace tests só com `--workspace-tests`, que nenhum script local passa (só o CI). Push tocando `packages/ai` quebra no CI, não localmente.
- Fix: pre-push detectar pacotes tocados (`git diff --name-only @{push}..HEAD`) e acrescentar os workspace tests desses pacotes. Escape `PIT_NO_PUSH_WORKSPACE_TESTS`.

### 6.7 Docs para agentes — **S, alto retorno**
- **Não existe CLAUDE.md** → sessões Claude Code não carregam AGENTS.md. Fix: `CLAUDE.md` de 1 linha: `@AGENTS.md`.
- AGENTS.md não documenta o loop rápido que já existe (1 arquivo de teste = 1,5 s; `CHECK_TIMING=1`; teste por pacote) → adicionar bloco "Verify while iterating".
- Dois CONTEXT.md com identidades diferentes; `AGENTS.md:39` aponta invariantes que estão em `docs/CONTEXT.md:77`, não no da raiz → fundir/corrigir o ponteiro.

### 6.8 Guarda-corpos e higiene — **S/M**
- Sem catraca contra testes lentos novos: ligar `report-slow-tests --fail-ms=45000` após vitest verde (começando acima do pior atual: lsp-hardening 37,7 s). Escape `PIT_NO_SLOW_TEST_GATE`.
- Benches de perf runtime emitem METRICs que ninguém compara → `scripts/baselines/runtime-perf.json` com budgets, no padrão (exemplar) do token-economy.
- Entulho na raiz do repo público: `spinning-ascii-globe-animation/`+`.zip`, `GROK_PIT-AMPO.md`, `profiles-node/`, `reports/` (untracked); `Taxonomia.md`, `TaxonomiaAnalise.md`, `PERF_LOG.md` (tracked) → convenção `scratch/` gitignorada + mover docs para `docs/reports/`.
- Loop de restage do pre-commit é vestigial (`.husky/pre-commit:16-24` promete formatação que `check:static` não faz) → `biome check --write` nos staged, ou remover o loop.

---

## Sequência recomendada (custo/benefício)

**Rodada 1 — quick wins S, ~1 dia, maior impacto percebido:**
1. Launcher `node --import tsx` (1.1) + undici pós-early-exit (1.5)
2. `keepAliveTimeout` 60 s + regex ECONNRESET (2.1)
3. `claude --version` assíncrono + import antecipado do sdk (1.2 + 1.3a) — ~2 s eliminados por overlap
4. Prewarm do hljs (4.1)
5. CLAUDE.md `@AGENTS.md` + bloco "Verify while iterating" + ponteiro de invariantes (6.7)
6. Retry automático do vitest no check (6.1) + autoskip de E2E com credencial inválida (6.2) + fix do worktree (6.3)

**Rodada 2 — S/M:**
7. Subcomandos/args lazy (1.5), cache de resolve/skills (1.6)
8. Cache do token-bench no pre-commit (6.5), retention adaptativo (3.1), maxRetries clamp (2.4), OAuth pre-refresh (2.3)
9. hljs memo por (code,lang) (4.2), TTSR coalescido (5.2), fingerprint (5.3), learned-errors async (5.4)

**Rodada 3 — M/L, medir antes:**
10. `--help` com cache (1.4), lazy leaves do agent-session (1.3b)
11. `check:fast --changed` + investigação isolate:false (6.4), workspace tests no pre-push (6.6)
12. HTTP/2 com soak (2.2), double-buffer de flatten (4.4), fan-out desacoplado (5.1)
13. Culling de scrollback (4.3) — só se sessões muito longas virarem alvo

**Resultado esperado das rodadas 1–2:** boot ~4,5–7 s → ~2–2,5 s; TTFT −40–200 ms em praticamente todo turno; fim do freeze de 100 ms no primeiro bloco de código; pre-push confiável (fim do `--no-verify`); pre-commit ~9 s → ~5–6 s.

---

## O que foi auditado e está saudável (não retrabalhar)

- **SSE/streaming**: parsing cursor-based sem O(n²), TextDecoder reusado, tool-args com parse único, 1 JSON.parse por evento.
- **Prompt caching**: exemplar nos dois providers (breakpoints Anthropic, instructions byte-estável Codex).
- **Montagem de request**: fast paths e WeakMap caches em `transformMessages`/conversões; `buildParams` = 1,1 ms/550 KB.
- **Tokens**: heurística char-based com calibração EMA, zero chamadas countTokens.
- **Persistência de sessão**: JSONL append-only com fila async serializada (0,03 ms hot path).
- **Compaction/fusion por turno**: µs (caches por referência em todos os níveis).
- **Tools**: pool de spare-shell, rg com caps, read com dedupe.
- **TUI**: markdown incremental de verdade, virtualização do render, memos em editor/footer/activity-line, throttle 16 ms, git via watchers async.
- **Harness**: gate paralelo bem tuned, baseline de token-economy versionado estado-da-arte, `test.sh`/`test.ps1` herméticos com paridade Windows.
