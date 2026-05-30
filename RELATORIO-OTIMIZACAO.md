# Relatório de Otimização — pi-monorepo (REVISADO + verificado no código)

Auditoria paralela por 14 especialistas, **depois revisada lendo o código real** nas linhas citadas.
Foco: performance / hot path / build / excelência. Segurança → Apêndice A.
Sem mudanças aplicadas.

> **Aviso importante:** a 1ª rodada (grep-only) produziu **vários falsos positivos e estimativas infladas**
> porque não verificou frequência de chamada, caches/coalescing já existentes, nem que o render é diferencial.
> Esta versão marca cada item como **✅ verificado**, **⚠️ superdimensionado** ou **❌ falso positivo**.
> Itens P2/P3 herdados não re-lidos individualmente estão marcados **(não re-verificado)**.

## Placar pós-verificação

| Bucket | Itens | O que é |
|---|---|---|
| **P0 real** | 1 | hot path / todo ciclo, ganho claro, baixo risco |
| **P1 real** | 3 (+1 a validar) | startup / config, ganho claro |
| **P2 real-modesto** | ~12 | padrão real, ganho pequeno ou caminho frio |
| **Descartado** | 8 | falso positivo ou ganho negligível |

---

## P0 — fazer (verificado, melhor ROI)

### ✅ P0.1 `package.json:14` — build serial dos 4 pacotes
```
"build": "cd packages/tui && npm run build && cd ../ai && npm run build && cd ../agent && npm run build && cd ../coding-agent && npm run build"
```
Verificado: serial real. Grafo de deps: `agent`→`ai`, `coding-agent`→todos; `tui`+`ai` são independentes.
Fix: 1ª onda `tui`+`ai` em paralelo, depois `agent`, depois `coding-agent` (`npm-run-all`/`concurrently`).
Impacto: build −15-25% (paralelismo limitado pelo grafo).

---

## P1 — fazer (verificado, startup/config)

### ✅ P1.1 `coding-agent/src/utils/syntax-highlight.ts:1` + `main.ts:54` — lazy-load `highlight.js`
Verificado: cadeia `main.ts:54 → theme.ts:16 → syntax-highlight.ts:1 → import hljs`. `main.ts` é entry de **todos** os modos → `highlight.js` (~150KB) carrega no boot mesmo em print/rpc/list-models.
Fix: dynamic import de `highlight.js` dentro da função que destaca; deferir `initTheme`/`theme.ts` para os call sites do modo interativo.
Impacto: startup menor em modos não-interativos + menos parse no boot. (Magnitude −150KB/−180ms é estimativa; direção correta.)

### ✅ P1.2 `package.json:15` — `check` sequencial
```
"check": "biome check ... && tsgo --noEmit && npm run check:browser-smoke && npm run check:generated"
```
Verificado: 4 tarefas independentes em série.
Fix: `npm-run-all --parallel` (nomear sub-tasks).
Impacto: check −30-40% (gargalo do CI).

### ✅ P1.3 `vitest.config.ts` (todos) — sem `pool: "threads"`
Verificado: nenhum config seta `pool`/`poolOptions`.
Fix: `pool: "threads"`, `singleThread: false`.
Ressalva: exige isolamento estável dos testes (sem estado global compartilhado) — validar antes.
Impacto: suíte −50-70% se isolada.

### ⚠️ P1.4 `tsconfig.base.json` — sem `incremental` (VALIDAR antes)
Verificado: `incremental` ausente. **MAS** build/check usam `tsgo` (TS native preview), cujo suporte a `.tsbuildinfo` é imaturo/diferente do `tsc`. O ganho −70-80% **não é garantido com tsgo**.
Ação: testar `incremental: true` + `tsBuildInfoFile` e medir; se tsgo ignorar, não adianta. Manter só se medição confirmar.

---

## P2 — real, mas ganho modesto / caminho frio

### ⚠️ Rebaixados de P0/P1 após verificação
| Item | Verificação | Fix correto |
|---|---|---|
| `tui/src/undo-stack.ts:12` — clone no editor | ⚠️ **NÃO é por keystroke**: editor.ts:1090 coalesce por palavra ("consecutive word chars coalesce into one undo unit"). É ~1 clone/palavra. Real só p/ buffers grandes. | shallow + COW nos arrays, ou snapshot diff |
| `settings-manager.ts:604,608` — `structuredClone` getter | ⚠️ Real, mas 15 call sites todos em `package-manager.ts` (install/list) e `config-selector.ts` (UI) — **ops frias, não hot path** | retornar `Readonly<Settings>` sem clone |
| `tui/src/utils.ts:156-168` — 3 regex por grafema | ⚠️ Mitigado: pre-filtro `couldBeEmoji` evita RGI regex + `visibleWidth` tem cache LRU por string. Só cache-miss paga | memoizar width por segment (Map) |
| `tui/src/components/input.ts:151,162` — spread do segmenter | ⚠️ Real, O(n) por tecla de cursor, mas input é linha curta. Importa só em linha longa | iterator `.next().value` |
| `theme.ts:1102-1125` — `getLanguageFromPath()` | ⚠️ Problema real é **rebuildar o objeto `extToLang` literal a cada chamada** (7 call sites), não falta de memo | mover `extToLang` p/ escopo de módulo (não LRU) |

### Herdados (não re-verificados individualmente)
| Arquivo:linha | Padrão | Fix |
|---|---|---|
| `ai/src/utils/validation.ts:374` | `filter(k => !validKeys.includes(k))` | `Set` (roda por tool-call) |
| `coding-agent/.../scoped-models-selector.ts:43` | filter+includes inconsistente c/ linha 45 (já Set) | `Set` |
| `agent/src/harness/agent-harness.ts:393,535` | `splice(0,1)`/`splice(0)` O(n) | deque/`shift` |
| `agent/src/harness/agent-harness.ts:625,642` | `.find(c => c.name === name)` linear | `Map` |
| `tui/src/kill-ring.ts:39` | `Array.unshift` O(n) | índice circular |
| `ai/src/cli.ts:18`, `auth-storage.ts:110` | `existsSync()`+`readFileSync()` double-hit | `try readFileSync; catch ENOENT` |
| `coding-agent/.../extensions/loader.ts:716-717,742-743,827` | `statSync` duplo / `existsSync && statSync` | reusar 1 stat |
| `coding-agent/.../web-search/extractors.ts:102,121` | fetch sem `accept-encoding: gzip,br` | header → −70% banda |
| `ai/scripts/generate-models.ts:270,328,386` | 3 fetches sequenciais (build-time) | `Promise.all` |
| `coding-agent/.../theme/theme.ts:463,493` | `readdirSync` mesmo dir 2× | cache mtime |
| `coding-agent/.../components/armin.ts:335` | `.map(row => [...row])` por frame glitch | pre-alloc + mutate |
| `coding-agent/.../components/bash-execution.ts:140,144` | `theme.fg("muted", ...)` por linha no render | memoizar styled |
| `coding-agent/.../components/config-selector.ts:383,385` | 2 `.filter(type==="item")` por render | cachear count |
| `coding-agent/.../components/tool-execution.ts:304-335` | rebuild `Image`+`Spacer` por update | diff de blocos |
| `tui/src/utils.ts:247-253` | LRU eviction cria iterator | ponteiro `head` |

### Excelência / dead code (não-perf, não re-verificado)
| Arquivo:linha | Padrão | Fix |
|---|---|---|
| `ai/src/utils/oauth/index.ts:93,109` + `types.ts:12,66` | exports `@deprecated`, 0 callers | deletar |
| `package.json:20` | `@types/node` root `^22` vs pacotes `^24` | alinhar (dedup) |
| `.github/workflows/ci.yml:23` | `node-version: 22` sem pin | pinar `22.19.0` |
| Todos `packages/*/package.json` | falta `"sideEffects": false` | tree-shake do consumer |
| `package.json` `copy-assets` | 10+ spawns `shx` | script Node único |

---

## ❌ Descartados — falso positivo ou ganho negligível

| Item original | Por que descartado |
|---|---|
| **footer-data-provider "I/O triplo por keystroke"** | ❌ **FALSO**: branch é cacheado (`cachedBranch`), `findGitPaths` só roda no constructor + `setCwd`, refresh é debounced via FS watcher. `getGitBranch()` devolve cache. Não toca FS por tecla. |
| **`tui.ts:1171-1242` `buffer +=` no render** | ❌ Render é **diferencial** (só linhas mudadas, ex: 1 p/ spinner), 1 write no fim. V8 trata `+=` com cons-strings. Ganho marginal. |
| **`utils.ts:50-120,910-1000` `result +=` em truncate** | ❌ Limitado à largura da linha (~80-200), só linhas mudadas, `visibleWidth` cacheado. Marginal. |
| **`symbol.ts:49-52` regex recompilado por chamada** | ❌ V8 **cacheia o pattern de regex literal**; só aloca wrapper. `detectKind` roda **1×/op** (linha 279), não "centenas/arquivo". O regex pesado real (`buildDeclarationPatterns`) **já tem cache** (`declarationPatternCache`). |
| **`agent-session.ts:1045` `.includes()` em loop** | ❌ Real, mas `event.hints` tem punhado de itens. O(n·m) com n,m minúsculos. "10-100×" é enganoso (n é ~3). |
| **`learned-error-store.ts:174` `.includes()` em loop** | ❌ Arrays minúsculos (rule IDs) + caminho **frio** (geração de report `learn:report`), não runtime. |
| **`theme.ts:561-580` tema re-parseado "por load/render"** | ❌ `loadThemeJson` roda via `initTheme`/troca de tema/watcher — **não por render**. O objeto `Theme` é construído 1× e reusado. Builtins já cacheados. |
| **`list-models.ts:80-86` 6 `.map()`** | ❌ Comando one-shot frio (`pit --list-models`). 600 vs 100 iters = microssegundos. Cosmético. |

---

## Auditoria limpa (sem ação)
- Concorrência: `Promise.all`/`allSettled` corretos, `AbortSignal` propagado, retry+backoff em `openai-codex-responses.ts:232-310`.
- Memory leaks: listeners removidos, child PIDs rastreados+limpos, output accumulator bounded, WebSocket TTL.

---

## Plano de execução honesto

1. **`package.json` build paralelo** (P0.1) — confirmado, baixo risco
2. **`check` paralelo** (P1.2) — confirmado
3. **lazy-load highlight.js** (P1.1) — confirmado, melhor ganho de startup
4. **vitest `pool: threads`** (P1.3) — validar isolamento
5. **medir `incremental` com tsgo** (P1.4) — só manter se medição comprovar
6. Varredura P2 conforme tocar nos arquivos (undo COW, getLanguageFromPath escopo módulo, Set em validation/harness, double-hit I/O, accept-encoding)

> Os "lags de digitação" vendidos antes (undo por tecla, footer por tecla) **não procedem**: undo coalesce por palavra, footer é cacheado.

---

## Apêndice A — Segurança (fora de escopo, não re-verificado)
- `hooks/runner.ts:71` `spawn(cmd,{shell:true})` com cmd do usuário → injection
- `hooks/runner.ts:17-20` `new RegExp` com matcher do usuário → ReDoS
- `hooks/runner.ts:145-149,32-36` stdout/stderr unbounded + `JSON.parse` sem cap → DoS
- fetch sem `AbortSignal.timeout()` em OAuth (`openai-codex.ts:97,141`, `github-copilot.ts:95`) → hang
- `} catch {}` silenciosos (`cli.ts:37`, `openai-codex-responses.ts`, `skills.ts:291`, `package-manager.ts`) → observabilidade
