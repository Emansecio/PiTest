# TaxonomiaAnalise — prioridades para melhorar o Pit

Companheiro de [Taxonomia.md](Taxonomia.md). Consolida a análise área a área com
foco em **melhorias acionáveis**, não em inventário do que já existe.

> **Regra:** antes de implementar qualquer item, confirmar em
> [docs/agents/already-built.md](docs/agents/already-built.md) que não está
> shipped. Esta análise exclui o básico já feito.

**Data:** 2026-07-09  
**Revisão anti-FP onda 1:** 2026-07-09  
**Onda 2 + revisão anti-FP:** 2026-07-09 (áreas 7, 4, 1, 2)  
**Onda 3 + revisão anti-FP:** 2026-07-09 (áreas 8, 9, 11, 12)  
**Onda 4 + revisão anti-FP:** 2026-07-09 (embed/RPC + platform leftovers)  
**Onda 5 + revisão anti-FP:** 2026-07-09 (leftover sweep — lista completa zero-config, sem Top 8)  
**Onda 5 SHIPPED:** 2026-07-09 (18/18 zero-config; `npm run check:fast` green)  

---

## Ordem de ataque

| # | Área | Por quê nesta ordem |
|---|------|---------------------|
| 1 | **3 · Context economy** | Frontier ativo; ROI mensurável (benches + gates) |
| 2 | **5 · Guards / prevention** | Qualidade residual; assimetria subagent real |
| 3 | **10 · TUI / experience** | Estado ambíguo sob verify / grupos / plan |
| 4 | **6 · Orchestration** | Persistência + parse Judge + defaults de custo |
| 5 | **7 · Task cognition** | Plan orphan + triage noise (pós-onda 2) |
| 6 | **4 · Tools** | Caps por ocupação + discovery fallback |
| 7 | **1 · Harness / runtime** | Abort pré-stream + precompile extensões |
| 8 | **2 · Providers / models** | Wiring de roles (smol/fallback/Plan exit) |
| 9 | **8 · Memory & learning** | On-demand shipped |
| 10 | **9 · Extensibility** | Core mínimo |
| 11 | **11 · Channels / embed** | SDK/RPC estáveis |
| 12 | **12 · Platform & quality** | Contínuo (CI) |

---

## Revisão anti-falso-positivo

Cada sugestão da onda 1 foi re-lida contra código. Vereditos:

| Veredito | Significado |
|----------|-------------|
| **KEEP** | Gap real; evidência confirma |
| **NARROW** | Gap real, mas escopo/urgência da auditoria estava inflado |
| **DROP** | Falso positivo, já coberto, ou conflita com decisão explícita do produto |
| **TRADEOFF** | Não é “falta de código” — precisa A/B, não PR de feature |

### Tabela de vereditos (onda 1)

| Sugestão original | Veredito | Motivo |
|-------------------|----------|--------|
| Presend mid-turn (compactar entre rounds de tools) | **DROP → NARROW** | CHANGELOG removeu *proactive compaction mid-turn* de propósito. Overflow já tem recovery compact+retry (`checkCompaction` + `isContextOverflow`). Live prune pós-tool já existe (K3). Gap residual estreito: wire `prepareNextTurn` só para *economia leve* (não compact abort), se medido. |
| Reservar thinking budget no presend | **KEEP** | `estimateWireTokens` não reserva headroom; inventário B8 VALID; sem implementação. |
| Política reativa a `instabilityTurn` | **TRADEOFF** | Warning TUI only é verdade (G2), mas auto-tighten prune = H1 (prune vs cache). Não tratar como bug. |
| Grep auto `files_with_matches` | **KEEP** | Modo existe; default `content`; sem auto-switch (A7 PARTIAL). |
| Paridade compaction ↔ branch summarizer | **NARROW** | Gap C7 real, mas risco de fidelidade alto; só com gate `bench-compaction-fidelity` — não prioridade #1. |
| Destructive + learned-error em subagents | **NARROW** | Assimetria **real** (`subagent-guards.ts` exclui de propósito). Mas deny-floor catastrófico **já** aplica via `permissionChecker` no spawn. Gap = só tier médio (speed-bump) + learned-error — não “subagent sem proteção”. |
| Coerção JSON→array em *todos* built-ins | **NARROW** | `edit`/`edit_v2` já coerçam `edits`. Gap = outros arrays (`plan.steps`, `ask.options`, `ast_edit`, …) + `stripNullishOptionalArgs` no path built-in. Não é “todos falham”. |
| Hints tier-4 para symbol/lsp/ast_edit | **NARROW** | `symbol` já tem “Did you mean” inline. Gap real = `lsp` / `ast_edit` no registry central; impacto menor que auditoria sugeriu. |
| Guard-efficacy → dosing adaptativo | **KEEP** (baixa pri) | Correlator grava e “nunca consome” — verdade. Esforço L; não é quick win. |
| Intent-gate LSP para símbolos | **KEEP** (baixa pri) | Fail-open deliberado em v1 (`symbolResolve intentionally omitted`). Gap real, não urgente. |
| Loader pós-turno (verify) | **KEEP** | `verification` só `showStatus`; `setWorkingPhase` não chamado. `pending_check` já recria loader em um path — assimetria confirma o gap em verify. |
| Doom-loop feedback no transcript | **NARROW** | Tier 1 `display: false` é **by design** (steer silencioso). Tier 2/3 já mostram CustomMessage. Gap = copy/chip, não “usuário nunca vê”. |
| Affordance Plan mode | **KEEP** | Borda colorida só em bash; plan = footer dim. |
| Slow-elapsed NavGroup/BashGroup | **KEEP** | Activity-line tem `· Ns`; grupos não. |
| Progresso subagent na ActivityLine | **KEEP** | `subagent_progress` → só `showStatus` efêmero. |
| Persistir orchestration no resume | **KEEP** | Comentário explícito v1 reset; spec §8.5 promete persistência. |
| Retry throttle correlacionado Fusion | **KEEP** | Spec §12 pede branch distinta; código só `both-failed`. |
| repairJson no Judge | **KEEP** | `parseJudgeOutput` = `JSON.parse` cru; spawn subagent já usa `repairJson`. |
| Roles baratas brief/verify | **NARROW** | Válido, mas depende de `modelRoles` configurados; judge deve ficar no synthesizer. |
| Default `allowed_tools` seguro | **NARROW** | Types curados (`explore`/`plan`/…) já fixam tools. Gap = `general` + omit sem type → full catalog. Não é “todo spawn herda tudo”. |
| Diff-limit pause / hard-block destrutivo / CardFrame / motion retune / Fusion·Auto / panel in-process | **DROP** | Anti-recomendações corretas — manter fora. |

---

## Síntese executiva (pós-revisão)

Temas que **sobrevivem**:

| Tema | Áreas | Ação |
|------|-------|------|
| **Custo mensurável de tool output** | 3 | Grep auto-locate; thinking reserve no estimate |
| **Assimetria subagent (tier médio)** | 5 | Propagar *só* destructive speed-bump (+ opcional learned-error) |
| **Estado ambíguo na UI** | 10 | Loader verify; elapsed em grupos; chip Plan |
| **Fusion confiabilidade / resume** | 6 | Persist facet; repairJson Judge; retry 429 correlacionado |

### Top 8 global (revisado)

| Pri | Item | Área | Esforço | Risco | Veredito |
|----:|------|------|---------|-------|----------|
| 1 | Grep auto-switch `files_with_matches` | 3 | S | low | KEEP |
| 2 | Fase pós-turno no working loader (verify) | 10 | S | low | KEEP |
| 3 | Persistir facet `orchestration` no resume | 6 | S | low | KEEP |
| 4 | repairJson + fallback no Judge Fusion | 6 | S | low | KEEP |
| 5 | Slow-elapsed em NavGroup / BashGroup | 10 | S | low | KEEP |
| 6 | Affordance persistente de Plan mode | 10 | S | low | KEEP |
| 7 | Thinking reserve no `estimateWireTokens` | 3 | S | low–med | KEEP |
| 8 | Destructive speed-bump em subagents (não “todos os guards”) | 5 | M | med | NARROW |

**Removidos do Top 8 anterior:**

- ~~Presend mid-turn como #1~~ — conflita com decisão de produto; overflow recovery + live prune já cobrem o caso catastrófico.
- ~~Coerção JSON→array “em todos”~~ — descer para backlog estreito (arrays fora de edit).
- Subagent progress / throttle retry / roles baratas — mantidos no Top 5 da área, fora do Top 8 global (mais risco ou dependência de config).

---

## Área 3 — Context economy

**Estado:** maduro (K1–K11). Live prune pós-tool (K3) e overflow compact+retry já existem.

### KEEP / NARROW

| # | Melhoria | Veredito | Notas |
|---|----------|----------|-------|
| 1 | **Grep auto `files_with_matches`** | KEEP | Default ainda `content`; hint na description é ignorado. |
| 2 | **Reservar thinking budget no estimate** | KEEP | B8; compacta mais cedo em reasoning-heavy — calibrar. |
| 3 | **Paridade summarizer compaction↔branch** | NARROW | C7; só com fidelity gate; não primeiro PR. |
| 4 | **`prepareNextTurn` para economia leve** | NARROW | Hook existe, não wired. **Não** reintroduzir abort/compact mid-turn (CHANGELOG). Candidato: supersede/elision extra entre rounds, se bench mostrar pressão. |

### DROP / TRADEOFF

| Item | Veredito | Por quê |
|------|----------|---------|
| Presend mid-turn = compactar/abortar no meio do tool loop | **DROP** | Removido de propósito; recovery em overflow + prune live cobrem |
| Auto-tighten prune em `instabilityTurn` | **TRADEOFF (H1)** | Medir A/B; não “implementar política” às cegas |
| Remover `readDedupeStore.clear()` | **DROP** | H4 |
| Reabrir K5 prefix economy | **DROP** | Shipped |

---

## Área 5 — Guards / prevention

**Estado:** bandas sólidas; backlog 2026-07-02 em grande parte **done**.

### KEEP / NARROW

| # | Melhoria | Veredito | Notas |
|---|----------|----------|-------|
| 1 | **Destructive speed-bump no subagent** | NARROW | Catastrófico já no deny-floor do parent checker. Falta block-once do tier médio. Learned-error: opcional (precisa store path no child). |
| 2 | **Coerção array em built-ins *sem* prepare próprio** | NARROW | Foco: `plan`/`ask`/`ast_*`/etc. — não re-trabalhar `edit`. |
| 3 | **Hints `lsp` / `ast_edit`** | NARROW | `symbol` já sugere candidatos inline. |
| 4 | **Consumir guard-efficacy** | KEEP (L) | Telemetria órfã; depois dos quick wins. |
| 5 | **Intent-gate + LSP símbolos** | KEEP (M) | Fail-open v1 deliberado; fechar com timeout. |

### DROP

| Item | Por quê |
|------|---------|
| “Subagent sem proteção destrutiva” (forma ampla) | Deny-floor já bloqueia `rm -rf /`, drive roots, etc. |
| Diff-limit pause (ADR-0002) | Nunca shipped; ADR recomenda diagnóstico |
| Hard-block universal (sem speed-bump) | Viola ADR-0006 |

---

## Área 10 — TUI / experience

**Estado:** motion maduro; micro-moves recentes shipped. Gaps = clareza de estado.

### KEEP / NARROW

| # | Melhoria | Veredito | Notas |
|---|----------|----------|-------|
| 1 | **Loader phase em `verification`** | KEEP | Espelhar Fusion “Synthesizing…”. |
| 2 | **Elapsed em NavGroup/BashGroup** | KEEP | Paridade com activity-line. |
| 3 | **Affordance Plan mode** | KEEP | Chip/borda; padrão bash. |
| 4 | **Progresso `task` na ActivityLine** | KEEP | Eventos já existem; wiring falta. |
| 5 | **Copy de doom-loop tier 2+ / recovery chip** | NARROW | Não tornar tier 1 visível (steer silencioso é feature). |

### DROP

| Item | Por quê |
|------|---------|
| CardFrame em massa | Cosmético, esforço L |
| Retuning motion/spinners | Maduro; risco de regressão |

---

## Área 6 — Orchestration

**Estado:** mecânica madura; frontier = falha/resume/custo.

### KEEP / NARROW

| # | Melhoria | Veredito | Notas |
|---|----------|----------|-------|
| 1 | **Persistir `orchestration` no resume** | KEEP | Reset solo documentado como v1. |
| 2 | **repairJson no Judge** | KEEP | Paridade com spawn. |
| 3 | **Retry ambos-throttled** | KEEP | Spec §12; calibrar 1 retry. |
| 4 | **Default tools quando omit + type `general`/ausente** | NARROW | Types curados já OK; fechar o omit perigoso. |
| 5 | **Brief/verify em role `smol`** | NARROW | Judge permanece no synthesizer. |

### DROP

| Item | Por quê |
|------|---------|
| Fusion · Auto dual-edit/worktree | Spec §15 adia |
| Panel in-process | Colide com design shell-out |

---

## Onda 2 — Task cognition · Tools · Harness · Providers

Audits: [Task cognition](49168d02-0939-468a-89d4-157cdd58facc),
[Tools](9ae712f6-5a67-4587-b528-2f58fb1f207a),
[Harness](0f0c5aec-aa23-4a5a-8e28-1b6cd09d63b0),
[Providers](11762c82-894e-4e6d-9c0b-fc84e5aa4dae).

Revisão anti-FP feita pelo coordenador contra código (não confiar no audit cru).

### Tabela de vereditos (onda 2)

| Sugestão original | Área | Veredito | Motivo |
|-------------------|------|----------|--------|
| Arquivar Plan DAG após `exit_plan` | 7 | **KEEP** | Sem `clear`/`archive`; `<plan>` re-injeta todo turno |
| Handoff Plan ↔ Todo | 7 | **NARROW** | Dual injection real; não exige conversão automática — basta precedência no prompt |
| Refinar triage/sync (excluir read-only do nudge) | 7 | **DROP do Top 8** | Gap de ruído existe, mas ADR-0007 D1/D2 *quer* investigação no trilho; excluir read/grep/ls reabre o furo que o ADR fechou. |
| Plan cadence + `step_done` rigoroso | 7 | **NARROW** | Cadence espelhando todo = OK; rejeitar `step_done` sem verify = atrito alto — só advisory |
| Goal budget UX (split + 80%) | 7 | **KEEP** | Split persiste; overlay só mostra total (`goal-overlay.ts:104`) |
| Caps adaptativos por **ocupação** runtime | 4 | **KEEP** | Boot-scale existe (`configureTruncationCaps`); A6 = ocupação, distinto |
| Perfis MCP por servidor | 4 | **KEEP** | Cap uniforme; A8 VALID |
| BM25 zero-result fallback | 4 | **KEEP** | Mensagem seca em `search-tool-bm25.ts:93-94` |
| Repair Tier-1 grep/find aliases | 4 | **KEEP** | Tier-1 só read+bash; grep `outputMode` sem snake alias |
| Badge truncamento no header TUI | 4 | **NARROW** | Gap real; overlap área 10 — pode ir com elapsed/grupos |
| Precompile `.ts`→`.js` extensões | 1 | **KEEP** | Bench ~2.5s; fast-path só `.js`; precompile npm não cobre `.pit/extensions` |
| Wire `prepareNextTurn` + fix adaptador | 1 | **NARROW** | Gap E11 + adaptador descarta context (`agent.ts:536`) — só economia leve, sem compact mid-turn |
| TTFT: baixar timeout `before_agent_start` | 1 | **NARROW** | Default 5s é kill-switch, não otimização; telemetria por-ext = KEEP estreito; baixar default = TRADEOFF |
| Abort pré-stream / BPR sem `settleOrAbort` | 1 | **KEEP** | `onPayload` L443–448 sem settleOrAbort; `_promptOnce` pode seguir pós-Esc |
| Credential pool ↔ retry 429 | 1 | **NARROW** | `awaitFreeSlot` existe, 0 uso prod — só vale com multi-key; edge case |
| `smol` → spawn subagent | 2 | **KEEP** | `resolveSubModel` nunca chama `resolveRole("smol")` |
| Fallback chain no role ativo | 2 | **KEEP** | `_resolveFallbackChain` hardcoded `role: "default"` |
| Restaurar role pré-Plan | 2 | **KEEP** | `decideRoleForPermissionMode` → sempre `"default"` |
| Login OpenAI-compat: import `/models` + compat | 2 | **NARROW** | Probe lista modelos; UX wizard = M–L; inferir compat = risco FP |
| Repair Node por model id | 2 | **KEEP** | Policy só por provider; OpenRouter+Claude fica ON à toa |
| Role `commit` unused | 2 | **DROP** (pri) | Doc gap; não é bug de runtime urgente |
| Gate bloqueante todo / auto-complete todo | 7 | **DROP** | ADR-0007 rejeitou |
| Grep auto-switch como item Tools | 4 | **DROP** | Já KEEP área 3 |
| Reativar Tier-2 bash→grep | 4 | **DROP** | Off by design (FP rate) |
| Compact mid-turn / prewarm jiti | 1 | **DROP** | Anti-FP onda 1 + main.ts documenta |
| scoped-models / thermostat-as-provider | 2 | **DROP** | already-built / área errada |

### Top 8 global — re-certificado 2026-07-09

Cada item revalidado no código nesta data. Só entra se: gap existe, não conflita
com ADR/CHANGELOG, esforço S, evidência de arquivo.

| Pri | Item | Área | Evidência re-checada | Status |
|----:|------|------|----------------------|--------|
| 1 | Grep auto-switch `files_with_matches` | 3 | Threshold 25 + `PIT_NO_GREP_AUTO_FILES`; só se `outputMode` omitido | **SHIPPED** 2026-07-09 |
| 2 | Loader phase em `verification` | 10 | `setWorkingPhase` + loader create no case `verification` | **SHIPPED** 2026-07-09 |
| 3 | Persistir `orchestration` no resume | 6 | `appendCustomEntry("orchestration")` + restore; default `"solo"` | **SHIPPED** 2026-07-09 |
| 4 | `repairJson` no Judge Fusion | 6 | `parseJudgeOutput` → `repairJson` fallback (paridade spawn) | **SHIPPED** 2026-07-09 |
| 5 | Restaurar role pré-Plan ao sair | 2 | `roleBeforePlan` + `decideRoleForPermissionMode(..., roleBeforePlan?)` | **SHIPPED** 2026-07-09 |
| 6 | Abort pré-`_runAgentPrompt` + `settleOrAbort` em BPR | 1 | Guard em `_promptOnce`; BPR via `settleOrAbort(agent.signal)` | **SHIPPED** 2026-07-09 |
| 7 | BM25 zero-result → fuzzy hint | 4 | `suggestClosest` em zero-result | **SHIPPED** 2026-07-09 |
| 8 | Slow-elapsed em NavGroup / BashGroup | 10 | `SLOW_ACTION_ELAPSED_SEC` + `· Ns` nos headers pending | **SHIPPED** 2026-07-09 |

**Removido do Top 8 nesta re-certificação:**

| Item | Antes | Agora | Motivo |
|------|-------|-------|--------|
| Excluir `read`/`grep`/`ls` do work-action (triage) | Pri 5 KEEP | **DROP do Top 8** | Conflita com ADR-0007 **D1/D2**: todo cobre investigação; ≥2 ações *inclui* descoberta/leitura. Contar nav tools é intencional. Refino fino (ex. só 2× `read` do *mesmo* path) = NARROW futuro, não Top 8. |

**Próximos M (após Top 8) — zero-config SHIPPED 2026-07-09:**

| Item | Status |
|------|--------|
| Plan affordance (borda + chip) | **SHIPPED** |
| Thinking reserve no presend | **SHIPPED** |
| Destructive speed-bump subagent | **SHIPPED** |
| Caps ∝ ocupação | **SHIPPED** (`PIT_NO_OCCUPANCY_CAPS` opt-out) |
| Precompile `.pit/extensions` + agent extensions | **SHIPPED** |
| Archive Plan quando `done === total` | **SHIPPED** (não no `exit_plan`) |

**Ainda abertos (precisam config / não zero-config):** `smol` no spawn · fallback por role ativo.

---

## Área 7 — Task cognition

**Estado:** ADR-0007 + Plan loop + Goals governor shipped.

### KEEP / NARROW

| # | Melhoria | Veredito | Notas |
|---|----------|----------|-------|
| 1 | **Arquivar Plan após exit/conclusão** | KEEP | Para de pagar tokens de `<plan>` órfão |
| 2 | **Triage: excluir nav read-only do work-action** | **DROP (Top 8)** | Conflita ADR-0007 D1/D2. Manter contagem atual. |
| 3 | **Precedência Plan > Todo no prompt pós-aprovação** | NARROW | Handoff textual; sem auto-converter steps→todos |
| 4 | **Goal overlay: split main/sub/fusion + aviso ~80%** | SHIPPED | Onda 4 Top 8 #8 |
| 5 | **Plan cadence reminder (soft)** | NARROW | Espelhar todo-cadence; **não** hard-block `step_done` |

### DROP

| Item | Por quê |
|------|---------|
| Gate bloqueante todo-first | ADR-0007 |
| Auto-completar todo em edit/write | ADR-0007 D7 |
| Unificar Todo×Plan num sistema | Fora de escopo ADR |

---

## Área 4 — Tools

**Estado:** registry + repair parcial + caps boot-scale shipped.

### KEEP / NARROW

| # | Melhoria | Veredito | Notas |
|---|----------|----------|-------|
| 1 | **Caps ∝ ocupação do contexto** | KEEP | Distinto de `configureTruncationCaps` (janela no boot) |
| 2 | **MCP output profiles por servidor** | KEEP | A8 |
| 3 | **BM25 fallback em zero-result** | KEEP | Discovery já existe; falta recall em falha |
| 4 | **Aliases Tier-1 grep/find** | KEEP | `output_mode`→`outputMode`, `query`→`pattern`, etc. |
| 5 | **Badge truncated no header agrupado** | NARROW | Preferir PR junto com TUI elapsed (área 10) |

### DROP

| Item | Por quê |
|------|---------|
| Grep auto-switch | Área 3 KEEP |
| Reativar bash→grep Tier-2 | Off by design |

---

## Área 1 — Harness / runtime

**Estado:** abort-race base, idle-timeout, retry+fallback, live prune shipped.

### KEEP / NARROW

| # | Melhoria | Veredito | Notas |
|---|----------|----------|-------|
| 1 | **Abort pré-stream** | KEEP | Esc durante compaction/hooks ainda pode chamar agent |
| 2 | **Precompile extensões locais** | KEEP | Maior ganho wall medido (~2.5s load) |
| 3 | **`prepareNextTurn` economia leve** | NARROW | Fix adaptador + prune/supersede; **proibido** compact abort |
| 4 | **Telemetria TTFT por extensão** | NARROW | Antes de baixar default 5s |
| 5 | **Pool de keys no retry 429** | NARROW | Só se `pool.count>1`; senão DROP prático |

### DROP / TRADEOFF

| Item | Veredito | Por quê |
|------|----------|---------|
| Compact mid-turn | DROP | CHANGELOG |
| Prewarm jiti / parallel `.ts` | DROP | Documentado como pior |
| Baixar default hook timeout sem dados | TRADEOFF | Medir breakdown primeiro |

---

## Área 2 — Providers / models

**Estado:** multi-provider, login, Repair Node, compact role shipped. Gaps = **wiring**.

### KEEP / NARROW

| # | Melhoria | Veredito | Notas |
|---|----------|----------|-------|
| 1 | **`smol` default no `task` spawn** | KEEP | Doc promete; código herda parent |
| 2 | **Fallback chain = role ativo** | KEEP | Hardcoded `default` |
| 3 | **Restaurar role pré-Plan** | KEEP | Hoje sempre `default` |
| 4 | **Repair Node por model id** | KEEP | OpenRouter+Claude não precisa note |
| 5 | **Login: import N models + hint compat** | NARROW | Wizard completo = L; MVP = persist lista + doc compat |

### DROP

| Item | Por quê |
|------|---------|
| scoped-models | Remover, não estender |
| Thermostat como feature de provider | Área 5 |
| Implementar role `commit` agora | Só doc; sem callers |

---

## Cruzamentos (ondas 1+2)

| Cruzamento | Status |
|------------|--------|
| Destructive subagent ↔ default `allowed_tools` | Válido se spawn `general` com bash |
| Loader verify ↔ verification gate | UX, não cosmético |
| `prepareNextTurn` ↔ harness | Só economia leve; não compact mid-turn |
| Roles Fusion ↔ Providers | Depende de `modelRoles` configurados |
| `smol` spawn ↔ default `allowed_tools` | Custo de fan-out: modelo barato + tools estreitos |
| Caps ocupação ↔ thinking reserve ↔ prepareNextTurn | Três alavancas — coordenar benches |
| Plan archive ↔ loader verify ↔ Plan affordance TUI | Mesmo fluxo plan→auto |
| Fallback por role ↔ Fusion roles baratas | Ambos precisam `modelRoles` |
| Badge truncamento Tools ↔ elapsed NavGroup | Mesmo PR TUI possível |
| Branch summarizer ↔ compact role ↔ fidelity gate | Onda 3: MIN_ENTRIES + compact; Onda 5: verify+ground (C7) SHIPPED |
| Flat `.ts` discovery ↔ precompile local | Onda 3: prefer `.js` sibling SHIPPED |
| `check:fast` ↔ `test:unit` ↔ Windows CI | Onda 3: unit SHIPPED; Windows CI = Onda 4 NARROW |
| RPC import/tree ↔ SIGINT headless | Onda 3: SIGINT SHIPPED; import/tree = Onda 4 Top 8 |

---

## Onda 3 — Memory · Extensibility · Channels · Platform

Audits: Memory, Extensibility, Channels/embed, Platform/quality (2026-07-09).  
Revisão anti-FP do coordenador contra código.

### Tabela de vereditos (onda 3)

| Sugestão original | Área | Veredito | Motivo |
|-------------------|------|----------|--------|
| Branch summary via `resolveCompactModel` | 8 | **SHIPPED** | fail-open via `resolveCompactModel` antes de `generateBranchSummary` |
| Skip LLM em branch path minúsculo | 8 | **SHIPPED** | `BRANCH_SUMMARY_MIN_ENTRIES = 3` |
| Learned-error em subagents | 8 | **NARROW** | Exclusão explícita em `subagent-guards.ts`; store/parent já shipped |
| Branch summarizer = delta/structured/verify | 8 | **NARROW** | C7; só com fidelity gate — não first PR |
| `enforceLimit` em todo `bank.add()` | 8 | **SHIPPED** | `add()` aplica `enforceLimit` / `enforcePerScopeLimit` |
| Flat `.pit/extensions/*.ts` → prefer `.js` | 9 | **SHIPPED** | `discoverExtensionsInDir` + `preferPrecompiledSibling` + dedupe |
| Bootstrap `pit install` vs local-only PM | 9 | **NARROW** | `install` rejeita npm/git; bootstrap ainda chama — alinhar script, não reabrir remote no core |
| MCP boot-skip notice tom informativo | 9 | **NARROW** | Defer correto; copy “did not connect” parece fatal |
| Baixar `SKILLS_FULL_LIMIT` | 9 | **NARROW** / TRADEOFF | Precisa bench; constante hardcoded |
| Gate bench-extension-load | 9 | **NARROW** | Medir ROI precompile; não feature |
| RPC `import` + `navigate_tree` | 11 | **KEEP** | Runtime tem APIs; `RpcCommand` não expõe |
| SIGINT → dispose em print/json/RPC | 11 | **SHIPPED** | print + rpc: SIGINT → 130 |
| Export `buildDryRunReport` no barrel | 11 | **SHIPPED** | re-export no `@pit/coding-agent` |
| RPC `get_state` + orchestration/permissionMode | 11 | **KEEP** | Estado incompleto vs session |
| Sync docs eventos JSON/RPC/SDK | 11 | **NARROW** | Docs atrasados; `message_update` drop intencional |
| `check:fast` roda zero Vitest | 12 | **SHIPPED** | `--vitest-unit` via `check:fast` |
| Windows CI smoke | 12 | **NARROW** | CI só `ubuntu-latest`; testes win32 skipIf |
| `test.ps1` hermético | 12 | **SHIPPED** | `test.ps1` + `clear-test-env.ps1` |
| `bench/selftest.mts` no smoke | 12 | **KEEP** | Documentado, fora de `check-parallel` |
| Persistir cache-prefix diagnostics | 12 | **NARROW** | Só TUI live; session-summary sem campo |

### Top 8 global — Onda 3 (zero-config preferido)

Cada item revalidado no código. Preferência: gap real, S–M, sem `modelRoles` obrigatório.

| Pri | Item | Área | Evidência | Status |
|----:|------|------|-----------|--------|
| 1 | `check:fast` → rodar `test:unit` | 12 | `--vitest-unit` no check-parallel | **SHIPPED** 2026-07-09 |
| 2 | Flat extension prefer `.js` sibling | 9 | `discoverExtensionsInDir` + dedupe | **SHIPPED** 2026-07-09 |
| 3 | SIGINT graceful dispose headless | 11 | print + rpc registram SIGINT → 130 | **SHIPPED** 2026-07-09 |
| 4 | Export `buildDryRunReport` | 11 | barrel `@pit/coding-agent` | **SHIPPED** 2026-07-09 |
| 5 | Hindsight `enforceLimit` on `add()` | 8 | `openBank` opts no closure de `add` | **SHIPPED** 2026-07-09 |
| 6 | Branch summary skip se path minúsculo | 8 | `BRANCH_SUMMARY_MIN_ENTRIES = 3` | **SHIPPED** 2026-07-09 |
| 7 | Branch summary → `resolveCompactModel` | 8 | fail-open sem `modelRoles.compact` | **SHIPPED** 2026-07-09 |
| 8 | `test.ps1` + env list compartilhada | 12 | `test.ps1` + `clear-test-env.ps1` | **SHIPPED** 2026-07-09 |

**Próximos M (após Top 8 onda 3):** → ver **Onda 4** abaixo.

**DROP onda 3:** re-enable `message_update` no json · prewarm jiti · parallel `.ts` load · remote npm install no core · dry-run live network · full Windows Vitest matrix · consolidar triple summary sink.

---

## Onda 4 — Embed parity · platform · memory (investigação + anti-FP 2026-07-09)

Audits revalidados no código após Onda 3 SHIPPED. **Segunda checagem anti-FP** do coordenador (não confiar no audit cru): cada candidato do “Próximos M” onda 3 + KEEP órfãos foi confrontado com arquivo:linha e com “o gap dói hoje?”.

### Anti-FP — o que caiu / desceu

| Candidato | 1ª leitura | Anti-FP | Veredito final |
|-----------|------------|---------|----------------|
| Bootstrap ↔ PM | Script chama `pit install npm:…` que core rejeita | **Repo não tem `.pit/packages.json`** → `readPackageList()` retorna `[]` e **skipa** (`bootstrap.mjs:160-162`). Fresh clone **não quebra**. Drift só se alguém adicionar o manifest. | **NARROW / latent** — fora Top 8; alinhar docs/script quando houver packages |
| MCP skip notice UX | “did not connect” parece fatal | Mesma linha já diz **“will connect on demand · /mcp”** (`mcp-extension.ts:380`). Multi-server copy já é on-demand. Polish cosmético, não gap de produto. | **NARROW polish** — fora Top 8 |
| Tier-1 grep/find aliases | `output_mode`→`outputMode` etc. | Path aliases **já** em grep/find (`prepareWithPathAliases`). **Zero** hits de `output_mode` / falhas snake em tests/bench/docs. Schema `additionalProperties: false` faria falhar *se* o modelo emitisse — sem evidência de frequência. | **NARROW pending evidence** — fora Top 8 (insurance, não Top 8) |
| Learned-error → subagents | Exclusão + “precisa full runtime” | Exclusão **real** (`subagent-guards.ts:18-21`, registry parent-only). Mas factory só precisa `dir` + `tool_call` — **mesmo padrão do shim** que já roda grounding. Rationale “full runtime” é overstated; gap de assimetria parent/subagent permanece. | **NARROW KEEP** — fica no Top 8 |
| RPC import / navigate_tree / get_state | KEEP | Confirmado: sem `RpcCommand`; `RpcSessionState` sem facets; `mcp-cli` `import` é MCP config, **não** session JSONL. | **KEEP** |
| `bench/selftest` smoke | KEEP | Confirmado: hermético, fora de `smokeTasks`. | **KEEP** |
| Windows CI / cache-prefix | NARROW | Confirmados; sobem no Top 8 após demotions. | **NARROW → Top 8** |
| Goal overlay split+80% | KEEP órfão | Confirmado: overlay só total (`goal-overlay.ts:101-106`); dados no governor. Zero-config S. | **KEEP → Top 8 filler** |

### Tabela de vereditos (onda 4, pós anti-FP)

| Sugestão | Área | Veredito | Evidência |
|----------|------|----------|-----------|
| RPC `import` | 11 | **KEEP** | `importFromJsonl` existe; ausente de `RpcCommand` |
| RPC `navigate_tree` | 11 | **KEEP** | Só extension ctx em RPC; sem comando top-level |
| RPC `get_state` facets | 11 | **KEEP** | Sem `orchestration` / `permissionMode` em `RpcSessionState` |
| `bench/selftest` no smoke | 12 | **KEEP** | Fora de `smokeTasks` |
| Learned-error → subagents | 8 | **NARROW** | Exclusão intencional; factory é shim-compatível |
| Windows CI smoke | 12 | **NARROW** | `bash-close-hang-windows.test.ts` nunca no CI |
| Cache-prefix → session-summary | 12 | **NARROW** | Live TUI sim; persist no dispose não |
| Goal overlay split + ~80% | 7 | **SHIPPED** | Overlay mostra split + aviso ~80% |
| Bootstrap ↔ PM | 9 | **NARROW latent** | Skip path hoje; mismatch só com manifest futuro |
| MCP skip notice UX | 9 | **NARROW polish** | Copy já menciona on-demand |
| Tier-1 grep/find aliases | 4 | **NARROW pending evidence** | Path aliases ok; snake sem telemetria |
| Branch fidelity C7 | 8 | **SHIPPED** | Onda 5 #16 — verify+ground |
| `smol` / fallback-by-role | 2 | **KEEP** (fora) | Precisa / beneficia de `modelRoles` |
| Caps / SIGINT / dry-run | — | **SHIPPED** | Não refazer |

### Top 8 global — Onda 4 (re-certificado anti-FP)

Só entra se: gap dói hoje, evidência de arquivo, S–M, zero-config (sem `modelRoles` obrigatório).

| Pri | Item | Área | Esforço | Evidência anti-FP | Status |
|----:|------|------|---------|-------------------|--------|
| 1 | RPC `import` | 11 | S | Runtime órfão; embedders sem path | **SHIPPED** 2026-07-09 |
| 2 | RPC `navigate_tree` | 11 | S | Extension tem; JSON-RPC não | **SHIPPED** 2026-07-09 |
| 3 | RPC `get_state` facets | 11 | S–M | `orchestration` + `permissionChecker` em services | **SHIPPED** 2026-07-09 |
| 4 | `bench/selftest` → smoke | 12 | S | Docs vs gate; 0 API keys | **SHIPPED** 2026-07-09 |
| 5 | Learned-error → subagents | 8 | M | Assimetria parent/subagent real | **SHIPPED** 2026-07-09 |
| 6 | Windows CI smoke (win32-only) | 12 | M | 2 testes nunca rodam no ubuntu CI | **SHIPPED** 2026-07-09 |
| 7 | Cache-prefix → session-summary | 12 | S | Persist gap; TUI já mostra | **SHIPPED** 2026-07-09 |
| 8 | Goal overlay split + ~80% | 7 | S | Governor tem split; overlay só total | **SHIPPED** 2026-07-09 |

**Próximos M (após Top 8 onda 4):** → ver **Onda 5** abaixo (lista completa zero-config, sem limite Top 8).

**DROP / não Top 8:** full Windows Vitest matrix · remote npm no core · re-enable `message_update` · branch fidelity sem gate · promover bootstrap/MCP-copy/grep-aliases sem evidência de dor.

### Fatias de PR sugeridas

```text
PR-A  get_state facets (orchestration + permissionMode)
PR-B  RPC import
PR-C  RPC navigate_tree
PR-D  bench/selftest → smokeTasks
PR-E  learned-error on subagent guard chain
PR-F  Windows CI job (só bash-close-hang-windows)
PR-G  cache-prefix em SessionSummaryRecord + dispose
PR-H  goal overlay: split main/sub/fusion + aviso ~80%
```

---

## Onda 5 — Leftover sweep · zero-config completo (**SHIPPED** 2026-07-09)

Após Onda 4 SHIPPED. **Sem limite Top 8:** inventário de **todos** os zero-config úteis (KEEP/NARROW com evidência). Critério zero-config = após shippar, funciona sem `modelRoles` / settings novos obrigatórios; opt-out `PIT_*` ok.

**Status:** 18/18 implementados (Waves A–E). Gate: `npm run check:fast` green.

Itens que **precisam config** (`smol` spawn, fallback = role ativo, Fusion brief/verify em roles baratas) ficam em seção separada — **não** entraram na lista zero-config.

### Anti-FP — SHIPPED (não reabrir)

| Item | Onda |
|------|------|
| Grep auto-switch, thinking reserve, caps ocupação, BM25 hint | 1–2 |
| Abort/settleOrAbort, precompile local, plan archive, roleBeforePlan | 2 |
| Flat prefer `.js`, SIGINT, dry-run barrel, hindsight limits, branch min+compact | 3 |
| RPC import/nav/get_state, selftest smoke, learned-error subagent, Win CI, cache-prefix, goal overlay | 4 |
| Loader verify, Plan affordance, NavGroup/BashGroup elapsed, orchestration persist, repairJson Judge | 1→shipped em waves |
| export_jsonl, MCP caps, Fusion both-throttled, Repair Node model-id, prepareNextTurn, general tools, doom-loop UI, find occupancy, read-dedupe, docs events, TTFT per-ext, plan/ask coerce, lsp/ast hints, intent LSP, efficacy→thermostat, branch C7, hindsight floor, ext-load smoke | 5 |

### Anti-FP — demotions / fora da lista zero-config

| Candidato | Veredito | Por quê |
|-----------|----------|---------|
| Grep/find snake aliases | **pending evidence** | Path aliases ok; zero hits de falha |
| MCP skip notice polish | **polish** | Copy já diz on-demand |
| Bootstrap ↔ PM | **latent** | Skip sem `packages.json` |
| Subagent progress na ActivityLine | **ADR tension** | ADR-0008 = status-line only; progresso por turno **já** em `showStatus` |
| `smol` / fallback-by-role | **config-gated** | Wiring útil, mas valor exige `modelRoles` |
| Re-enable `message_update` json | **DROP** | O(tokens²) guard |
| Full Windows Vitest / remote npm | **DROP/TRADEOFF** | Já decidido |

### Lista completa — zero-config (SHIPPED)

| # | Item | Área | Esforço | Valor | Evidência | Veredito |
|--:|------|------|---------|-------|-----------|----------|
| 1 | **RPC `export_jsonl`** (+ docs; TUI slash opcional) | 11 | S | Alto | RPC parity com `export_html` → `session.exportToJsonl` | **SHIPPED** 2026-07-09 |
| 2 | **MCP output caps por servidor** (heurística zero-config) | 4 | M | Alto | Cap menor browser/devtools; maior fs/memory/sqlite | **SHIPPED** 2026-07-09 |
| 3 | **Fusion both-throttled** (spec §12) | 6 | M | Alto | 1 retry coordenado + `degraded: "both-throttled"` | **SHIPPED** 2026-07-09 |
| 4 | **Repair Node por model id** | 2 | S | Med | OFF se id casa claude/gpt-4/5/gemini/oN | **SHIPPED** 2026-07-09 |
| 5 | **`prepareNextTurn` wire + fix adaptador** (economia leve; **sem** compact mid-turn) | 1 | M | Med–Alto | Adapter passa context; live prune/supersede only | **SHIPPED** 2026-07-09 |
| 6 | **`general` builtin default `tools` whitelist** | 6 | S | Med | read/grep/find/ls/bash/edit/write/ast_grep/symbol | **SHIPPED** 2026-07-09 |
| 7 | **Doom-loop tier 2/3 compact renderer** | 10 | S | Med | `pi.doom-loop-pause` / `recovery` compact UI | **SHIPPED** 2026-07-09 |
| 8 | **`find` DEFAULT_LIMIT / scale ∝ ocupação** | 4 | S | Med | `Math.max(100, round(1000 * occupancy))` | **SHIPPED** 2026-07-09 |
| 9 | **Read-dedupe clear só quando necessário** (não a cada compact) | 1/4 | S | Med | Removido clear incondicional; mtime/stamp | **SHIPPED** 2026-07-09 |
| 10 | **Docs catálogo eventos RPC/JSON/SDK** | 11 | S | Med | `rpc.md`: json dropa `message_update`; subagent/fusion | **SHIPPED** 2026-07-09 |
| 11 | **TTFT: telemetria por-extensão** (`PIT_TIMING`) | 1 | S–M | Med | Breakdown por handler no `before_agent_start` | **SHIPPED** 2026-07-09 |
| 12 | **JSON→array coercion** em `plan.steps` / `ask.options` | 4/7 | S | Low–Med | `coerceJsonArrayField` em prepareArguments | **SHIPPED** 2026-07-09 |
| 13 | **Tier-4 hints** `lsp` / `ast_edit` | 5 | S–M | Low | path/symbol miss → Did you mean / install | **SHIPPED** 2026-07-09 |
| 14 | **Intent-gate `symbolResolve` via LSP** (timeout, fail-open) | 5 | M | Med | ~400ms timeout; `PIT_NO_INTENT_GATE` opt-out | **SHIPPED** 2026-07-09 |
| 15 | **Consumir guard-efficacy** (dosing / thermostat) | 5 | L | Low–Med | Reader JSONL → thermostat skip-tighten prior | **SHIPPED** 2026-07-09 |
| 16 | **Branch summarizer = compaction pipeline** | 8 | L | Med | `verifySummary` + `groundSummaryPaths` no branch path | **SHIPPED** 2026-07-09 |
| 17 | **Hindsight recall score floor** (>0 aceita qualquer hit) | 8 | S | Low–Med | `HINDSIGHT_MIN_SCORE = 0.15` | **SHIPPED** 2026-07-09 |
| 18 | **Extension-load bench no smoke/CI** | 9/12 | S | Low | `scripts/check-extension-load.mjs` em smokeTasks | **SHIPPED** 2026-07-09 |

### Config-gated (úteis, mas **não** zero-config de outcome) — ainda abertos

| Item | Área | Nota |
|------|------|------|
| `smol` → `resolveSubModel` quando `model` omitido | 2 | Fail-open parent; valor só com `modelRoles.smol` |
| Fallback chain = role ativo (+ plumb `activeRole` em `AgentSession`) | 2 | TUI cycle já usa role; retry hardcoded `default` |
| Fusion brief/verify em roles baratas | 6 | Precisa `modelRoles` |

### Waves executadas (A–E)

```text
Wave A (S, alto sinal):   export_jsonl RPC · Repair Node model-id · find limit · docs eventos · hindsight floor · ext-load smoke
Wave B (S–M, produto):    Fusion both-throttled · MCP caps · general tools whitelist · doom-loop compact UI
Wave C (M, harness):      prepareNextTurn+adapter · read-dedupe policy · TTFT per-ext telemetry
Wave D (NARROW batch):    plan/ask array coerce · lsp/ast_edit hints
Wave E (L / gate):        intent-gate LSP · guard-efficacy consumer · branch C7+fidelity gate
```

---

## Área 8 — Memory & learning

**Estado:** on-demand memory/hindsight + tools retain/recall + learned-error store shipped.

### KEEP / NARROW

| # | Melhoria | Veredito | Notas |
|---|----------|----------|-------|
| 1 | **Branch summary → compact role** | SHIPPED | Onda 3 |
| 2 | **Skip LLM branch path pequeno** | SHIPPED | Onda 3 |
| 3 | **`enforceLimit` em `add()`** | SHIPPED | Onda 3 |
| 4 | **Learned-error → subagent** | SHIPPED | Onda 4 Top 8 #5 |
| 5 | **Branch = compaction pipeline** | SHIPPED | Onda 5 #16 — verify+ground |

### DROP

| Item | Por quê |
|------|---------|
| Re-injetar MEMORY full no prefix | Opt-out existe; regressão |
| Auto-distill subagent → parent memory | Spec scoped-hindsight fora de escopo |

---

## Área 9 — Extensibility

**Estado:** loader + hooks + skills + MCP + packages + precompile local SHIPPED.

### KEEP / NARROW

| # | Melhoria | Veredito | Notas |
|---|----------|----------|-------|
| 1 | **Flat file prefer `.js`** | SHIPPED | Onda 3 |
| 2 | **Bootstrap ↔ local-only install** | NARROW latent | Anti-FP: skip sem packages.json; fora Top 8 |
| 3 | **MCP skip notice UX** | NARROW polish | Anti-FP: copy já diz on-demand; fora Top 8 |
| 4 | **Skills limit / settings** | NARROW | Medir antes |
| 5 | **Extension-load gate** | SHIPPED | Onda 5 #18 — smoke wrapper |

### DROP

| Item | Por quê |
|------|---------|
| `prewarmExtensionLoader` | Medido sem ganho |
| Parallel `.ts` load | Contenção jiti |
| Remote install no core | Local-only deliberado |

---

## Área 11 — Channels / embed

**Estado:** text/json/rpc/SDK/dry-run estáveis; gaps = parity headless.

### KEEP / NARROW

| # | Melhoria | Veredito | Notas |
|---|----------|----------|-------|
| 1 | **RPC import + navigate_tree** | SHIPPED | Onda 4 Top 8 #1–#2 |
| 2 | **SIGINT dispose** | SHIPPED | Onda 3 |
| 3 | **Export dry-run report** | SHIPPED | Onda 3 |
| 4 | **get_state facets** | SHIPPED | Onda 4 Top 8 #3 |
| 5 | **Docs event catalogs** | SHIPPED | Onda 5 #10 |

### DROP / TRADEOFF

| Item | Veredito | Por quê |
|------|----------|---------|
| Re-emit `message_update` no json | DROP | O(tokens²) guard |
| Dry-run live MCP probe | TRADEOFF | No-network by design |

---

## Área 12 — Platform & quality

**Estado:** token gate shipped; CI Linux-only; Windows = OS do usuário.

### KEEP / NARROW

| # | Melhoria | Veredito | Notas |
|---|----------|----------|-------|
| 1 | **`check:fast` + unit vitest** | SHIPPED | Onda 3 |
| 2 | **`test.ps1` hermético** | SHIPPED | Onda 3 |
| 3 | **Windows CI smoke** | SHIPPED | Onda 4 Top 8 #6 |
| 4 | **`bench/selftest` no smoke** | SHIPPED | Onda 4 Top 8 #4 |
| 5 | **Persist prefix diagnostics** | SHIPPED | Onda 4 Top 8 #7 |

### DROP / TRADEOFF

| Item | Veredito | Por quê |
|------|----------|---------|
| Reescrever check-parallel | DROP | Já tuned p/ Windows hang |
| Full Windows Vitest matrix | TRADEOFF | Custo/flake |
| Gate `bench/run-all` | TRADEOFF | Precisa API keys |

---

## Como usar

1. Implementar só itens **KEEP** (ou **NARROW** com o escopo estreito desta revisão).
2. Ignorar **DROP**; tratar **TRADEOFF** como experimento medido.
3. Confirmar de novo em `already-built.md` no dia do PR.
4. Sucesso = métrica/teste, não “parece melhor”.
5. Onda 5 = leftover sweep: **18/18 zero-config SHIPPED** 2026-07-09; config-gated (`smol`, fallback-by-role) ainda abertos.
