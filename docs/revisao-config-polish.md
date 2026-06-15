# Revisão de Config & Polish do Pit — relatório ranqueado e conferido

Eixo: zero-config, gates corretos, naming/env/flags coerentes, ergonomia, descoberta, mensagens acionáveis, consistência visual/terminológica. **Não** latência/perf.

Método: workflow de 14 finders Opus 4.8 (2 por lane × 7 lanes, partição por arquivo disjunta) + 1 verificador adversarial por finding. 85 agentes, 71 findings brutos. Conferência final pelo agente principal: cada item de impacto alto/médio e os 3 sem-veredicto foram reabertos contra o código real antes de promover a `fato`.

Saldo: **62 confirmados+em-escopo, 6 refutados, 0 fora-de-escopo, 3 sem-veredicto** (rate-limit do servidor; validados à mão depois). Após dedup cross-lane: ~50 itens distintos. Nenhum P0/P1 — a base está saudável; são arestas de polish/config.

Convenções: cada item traz `arquivo:símbolo`, problema→proposta, impacto (fricção/polish, não ms), risco, esforço (P/M/G), `fato`/`hipótese`.

---

## TIER 1 — Implementar primeiro (contrato doc-vs-código + zero-config + 1 crash latente; todas P, maior leverage)

### 1. envMap não cobre providers documentados (zero-config quebrado) — médio-alto, P, fato
- `packages/ai/src/env-api-keys.ts:42` → `getApiKeyEnvVars` (envMap)
- A doc (`packages/coding-agent/docs/providers.md:54-72` e `packages/ai/README.md:1098-1114`) promete auto-detecção de env var ("the library automatically uses these keys") e aponta o envMap como fonte de verdade, mas o mapa só cobre openai/google/openrouter/minimax/opencode/opencode-go/kimi-coding/xiaomi (+anthropic). `deepseek`, `mistral`, `groq`, `cerebras`, `fireworks`, `together`, `huggingface` ficam de fora — e têm handling real (`openai-completions.ts:1058-1103` para deepseek/cerebras/together). Quem seta `DEEPSEEK_API_KEY` conforme a doc leva `No API key for provider: deepseek`.
- Proposta: adicionar as entradas faltantes ao envMap, OU (se forem deliberadamente só auth.json/`--api-key`) remover a promessa de auto-detecção das duas docs. A 1ª é a coerente com zero-config.
- Risco: aditivo — só adiciona chaves; `getEnvApiKey` é fallback (só consultado sem `options.apiKey`). Atenuação: auth.json/`--api-key` ainda funcionam hoje para esses providers.
- **Validado à mão** (handling em openai-completions + ambas as docs).

### 2. `PIT_NO_GROUNDING` documentado é opt-out morto — médio, P, fato  *(dup: tool-guards + env-flags-docs)*
- `packages/coding-agent/README.md:641` documenta `PIT_NO_GROUNDING`; o código só lê `PIT_NO_GROUNDING_GUARD` (`grounding-guard.ts:401` → `isGroundingGuardDisabled`, `built-ins/index.ts:99`). `grep` confirma: `PIT_NO_GROUNDING` sem `_GUARD` só aparece no README.
- Quem seguir o README e setar `PIT_NO_GROUNDING=1` não desliga nada. É a única linha da tabela de kill-switches cujo nome diverge do código (as 3 irmãs import/path/pattern batem). A descrição do mesmo row fala em `symbol` de navegação, mas o guard só intercepta `debug`/`lsp` (`grounding-guard-extension.ts:95`).
- Proposta: corrigir o README para `PIT_NO_GROUNDING_GUARD` (1 char, zero risco) ou aceitar `PIT_NO_GROUNDING` como alias aditivo. Ajustar a descrição para o escopo real (`debug` breakpoint name + `lsp` workspace-symbol).
- **Validado à mão** (grep).

### 3. Doc aponta o settings global para o caminho errado — médio, P, fato
- `docs/agents/tools-and-config.md:10` diz `~/.pit/settings.json`; o real é `~/.pit/agent/settings.json` (`settings-manager.ts:541` `join(agentDir,"settings.json")`, `agentDir = ~/.pit/agent` via `config.ts`).
- Quem criar `~/.pit/settings.json` conforme a doc edita um arquivo que o SettingsManager nunca lê — overrides globais silenciosamente ignorados.
- Proposta: corrigir o caminho na doc. Risco: nenhum (texto). README/CHANGELOG já usam o correto.

### 4. Default Anthropic uma geração atrás (Opus 4.7 → 4.8) — médio, P, fato
- `packages/coding-agent/src/core/model-resolver.ts:37` → `defaultModelPerProvider.anthropic = "claude-opus-4-7"`. O registry (`models.generated.ts:130-147`) já tem `claude-opus-4-8` com custo/janela **idênticos** (mesma API, mesmo thinkingLevelMap). Consumido em `findDefaultModel` (anthropic é provider #1) e na auto-seleção pós-`/login` (`interactive-mode.ts:5192`).
- Usuário Anthropic zero-config (fresh `/login`) recebe o flagship anterior sem trade-off de custo.
- Proposta: bump para `claude-opus-4-8` (drop-in). Idealmente um teste garantindo que cada default existe no registry e é o id mais alto da família.
- Risco: baixo. **Conferido**: nenhum teste fixa `claude-opus-4-7` (o "risco de quebrar testes" do finding é falso).

### 5. Parsing de kill-switch inconsistente — `PIT_NO_FUSION=0` desliga (pegadinha) — médio, P, fato  *(absorve #45 edit-precondition)*
- `README.md:637` promete `1`/`true`/`yes` para toda a tabela. Mas: `PIT_NO_CODE_MODE`/`PIT_NO_REPEATING_PATTERN` exigem exatamente `=== "1"` (rejeitam `true`/`yes`); `PIT_NO_FUSION` (`agent-session.ts:4276`), `PIT_NO_EDIT_PRECONDITION` (`edit-precondition-extension.ts:43`) e `PIT_NO_OMISSION_CHECK` (`lazy-omission.ts:152`) aceitam **qualquer** valor não-vazio — então `PIT_NO_FUSION=0` **desliga** fusion (o oposto do esperado).
- Proposta: padronizar todos via o helper canônico `isTruthyEnvFlag` (`utils/env-flags.ts`, já usado pela maioria). 1 linha por call-site.
- Risco: baixo — só `=0`/`=false`/`=no` deixam de desligar (comportamento correto). Nota: `PIT_NO_FUSION`/`PIT_NO_OMISSION_CHECK` não estão na tabela documentada — a violação estrita de contrato vale para CODE_MODE/REPEATING_PATTERN/EDIT_PRECONDITION.

### 6. Failure-budget e visual-DoD "por-turno" viram "por-goal inteiro" no modo autônomo — médio, P, fato
- `agent-session.ts` `prompt()` (~2970-2983) reseta `_turnToolFailures`/`_turnFailureBudgetFired`/`_turnTouchedVisual`/`_turnUsedPreview` uma vez; o loop de goal chama `_promptOnce` repetidamente (~2996-3005) **sem** reset. As docstrings dizem "strict per-turn reset".
- No `/goal`, o orçamento de 3 falhas/turno vira ~3 falhas para o goal inteiro; o steer de failure-budget dispara 1× e nunca re-arma; o nudge visual de um passo é suprimido por `_turnUsedPreview` de um passo anterior. O guard fica sub-dosado exatamente no uso autônomo — o caso de uso principal do dono (`/goal`).
- Proposta: resetar esses 4 contadores no topo de cada `_promptOnce`/continuação do goal (manter `_turnTouchedFiles` acumulando para o gate de verificação final).
- Risco: baixo — single-shot fica idêntico; só re-arma guards existentes com mais frequência em goals longos (efeito desejado).

### 7. Borda inferior do editor pode exceder a largura (crash latente) — robustez, P, fato
- `packages/tui/src/components/editor.ts:773-775` — borda `─── ↓ N more ` faz só `"─".repeat(Math.max(0,remaining))`, sem truncar o indicador. As bordas superiores (`:684-688`, `:692-696`) já protegem com `truncateToWidth` quando `remaining < 0`.
- Em terminal estreito com conteúdo rolado abaixo, a linha emitida fica mais larga que o viewport → dispara o render-assert em CI/teste (a classe de crash "Rendered line exceeds terminal width" que o projeto trata como dura) e clipa em prod.
- Proposta: espelhar o guard das linhas 684-688: `else result.push(borderColor(truncateToWidth(indicator, width)))`.
- Risco: nenhum em larguras normais. **Validado à mão** (sem-veredicto promovido).

---

## TIER 2 — Ergonomia / DX / robustez (médio impacto, todas P salvo nota)

### 8. Mensagem 'No API key' não diz qual env var setar — médio, P, fato  *(dup: ai-providers + model-auth)*
- 6 throws genéricos `No API key for provider: ${provider}` (`anthropic.ts:748`, `google.ts:247`, `openai-completions.ts:425`, `openai-codex-responses.ts:159/340`, `openai-responses.ts:138`) e `formatNoApiKeyFoundMessage` (`auth-guidance.ts:22`) só dizem o nome do provider. O mapa provider→env var existe (`getApiKeyEnvVars`) mas é module-private.
- Proposta: exportar `getApiKeyEnvVarNames(provider)` e usar nas mensagens: `No API key for "google". Set GEMINI_API_KEY (or GOOGLE_API_KEY), pass apiKey, or run /login.` Para OAuth-only (openai-codex) apontar `/login`.
- Risco: baixo — só texto; nenhum teste fixa as strings. **Conferido** (`findEnvKeys` só lista vars já setadas — precisa exportar `getApiKeyEnvVars`, não `findEnvKeys`).

### 9. Primeira execução sem auth/modelo não orienta no TUI — médio, P, fato
- `interactive-mode.ts` `run()` (~869-947) mostra vários warnings mas não há check de "nenhum modelo". `main.ts:783` só orienta em modo não-interativo; no TUI o usuário só recebe `formatNoModelSelectedMessage` ao enviar o 1º prompt (reativo).
- Proposta: após `updateAvailableProviderCount()`, se não há `session.model`, mostrar 1× um aviso proativo reaproveitando `getProviderLoginHelp()` ("Nenhum modelo configurado. Use /login, depois /model."). Mesmo padrão `shown-once` já usado para o aviso Anthropic.
- Risco: baixo, aditivo. **Conferido**: o erro reativo já inclui guidance completa → defeito é timing/proatividade, não ausência.

### 10. Sugestão de typo de slash-command usa matcher fraco — médio, P, fato
- `interactive-mode.ts:2588` usa `fuzzyFilter` (subsequência) em vez do canônico `suggestClosest` (Levenshtein, `@pit/ai validation.ts:332`, já usado em unknown-tool e nos grounding-guards). Typos por transposição (`/modle`, `/comapct`) não são subsequência → nenhum "Did you mean".
- Proposta: trocar por `suggestClosest(name, [...this._knownCommandNames], {maxDistance, prefixMinOverlap})` com o mesmo tuning de unknown-tool + caso de teste de transposição.
- Risco: baixo, 1 linha + import. **Conferido empiricamente** pelo verificador (repro `/modle`→undefined no fuzzy, acerta no suggestClosest).

### 11. `web_search` anuncia Exa mas o chain `auto` (recomendado) nunca tenta Exa — médio, P, fato
- `core/tools/web-search.ts`: description e `PROVIDER_NAMES` incluem `exa`, guideline empurra `provider="auto"`, mas o erro "no providers configured" lista só Brave/Tavily/Jina/Perplexity e `getDefaultProviderChain` (`core/web-search/index.ts:35`) não inclui exa. Quem só tem `EXA_API_KEY` + `auto` cai em "no providers configured".
- Proposta (na partição web-search.ts): incluir `EXA_API_KEY` na msg de erro e esclarecer na description que `auto` cobre brave/tavily/jina/perplexity e exa exige `provider="exa"`. (Adicionar exa ao chain default é mudança comportamental em `core/web-search/index.ts` — fora desta partição.)
- Risco: baixo (texto).

### 12. Fallback-chain não faz failover em HTTP 500 — médio, P, fato
- `retry-with-fallback.ts:31` `RETRYABLE_STATUSES = {429,502,503,504}` (sem 500); `retry-headers.ts:23` inclui 500 e o codex provider trata 500 como retryable — 3 políticas divergentes no mesmo pacote. Um 500 nu no modelo primário não dispara failover.
- Proposta: incluir 500 em `RETRYABLE_STATUSES` de retry-with-fallback (alinhar a 429/500/502/503/504). 1 linha.
- Risco: baixo — `NON_RETRYABLE` (401/403/404) segue barrando auth. **Conferido**: nenhum teste fixa não-failover em 500.

### 13. Provider Codex ignora `maxRetries`/`timeoutMs` — médio, P, fato
- `StreamOptions` expõe `maxRetries`/`timeoutMs` e Anthropic/OpenAI os repassam ao SDK; `openai-codex-responses.ts` usa loop próprio com `MAX_RETRIES=3` (`:63`) e connect timeout hardcoded `60_000` (`:244`), nunca lendo `options`. `maxRetries=0` para fail-fast em fan-out não funciona no Codex.
- Proposta: `options?.maxRetries ?? MAX_RETRIES` e `options?.timeoutMs ?? 60_000`. Defaults inalterados.
- Risco: baixo.

### 14. `retry`: schema partido em duas interfaces divergentes — médio, P, fato
- `RetrySettings` (`settings-manager.ts:64-69`) declara só enabled/maxRetries/baseDelayMs/provider, mas `getModelRoleSettings` (`:1580`) lê `fallbackChains`/`cooldownMs` por **cast** `as {...}` (consumidos de verdade em `model-resolver.ts:328` e `agent-session.ts:5391`, cooldown default 300_000).
- Proposta: declarar `fallbackChains`/`cooldownMs` direto em `RetrySettings` e remover os casts; `ModelRoleSettings.retry` deriva dela.
- Risco: baixo — só tipo + remoção de cast; valores já lidos hoje.

### 15. Hooks `SessionStart`/`PreCompact` indescobríveis + dry-run conta errado — médio, P, fato
- `hooks-extension.ts:188-238` instala os 6 eventos; `docs/hooks.md:9-14` e `docs/settings.md:256-260` listam só 4, e o dry-run (`cli/dry-run/index.ts:159-176`) soma só PreToolUse/PostToolUse/UserPromptSubmit/Stop → quem configura só um `SessionStart`/`PreCompact` vê "none configured" mesmo com hook ativo.
- Proposta: documentar os 2 eventos (o JSDoc do código já os descreve bem) e incluir os 6 na contagem do dry-run.
- Risco: nenhum (doc + 1 linha no dry-run).

### 16. Erros de hook vão a `console.error` mesmo no TUI — médio, P, fato
- `hooks-extension.ts:43` `logErrors` faz `console.error` direto (chamado em 6 handlers), enquanto o resto da extensão usa `ctx.ui.notify`. **Conferido**: TUI renderiza inline em stdout sem alternate-screen → stderr cru intercala no frame. (A citação ao crash "Rendered line exceeds terminal width" é overreach do finding; o valor real é consistência de canal + garantir que o usuário veja a falha.)
- Proposta: passar `ctx` a `logErrors`; quando `ctx.hasUI`, rotear via `ctx.ui.notify(msg,"warning")`; manter `console.error` só headless.
- Risco: baixo — headless idêntico.

### 17. Model roles (smol/slow/plan/commit) indocumentados — médio, P, fato  *(absorve #55 role `commit`)*
- `MODEL_ROLES` (`model-resolver.ts:15`), flags `--smol/--slow/--plan` e `/model <role>` existem, mas `docs/models.md`/`settings.md` não explicam os roles nem `settings.modelRoles[role].{model,thinkingLevel,fallbackChain,paths}`. O role `commit` não tem atalho nem explicação (é fiado, consumido por `resolveRole`, não está órfão).
- Proposta: seção "Model roles" em `docs/models.md` (tabela role→intenção + exemplo de `settings.modelRoles` + atalhos); opcionalmente `--commit` por simetria.
- Risco: nenhum (doc).

### 18. `search_skills` enxerga um conjunto diferente do prompt — médio, M, fato
- O prompt usa `resourceLoader.getSkills().skills` (CLI + legacy + extensão + `~/.claude/skills`); a tool `search_skills` (`search-skills.ts:42`) recarrega com `includeDefaults:true` (só agentDir/project/`~/.claude`). Uma skill via `--skill`/legacy/extensão aparece no índice do prompt mas não é achada pelo `search_skills` que o próprio prompt manda usar.
- Proposta: injetar o getter da sessão (`agent-session-services.ts:175 getSkills`) na factory da tool; fallback para o `loadSkills` atual.
- Risco: baixo. **Conferido**: o caption também diz "Read the <location>" → há fallback funcional; o que quebra é só a conveniência do search.

### 19. `/hotkeys` é hidden e não há `/help` — médio, P, fato
- `slash-commands.ts`: 9/24 builtins `hidden:true`, incluindo `/hotkeys` (a referência completa de teclas) e `/goal`,`/todos`,`/diagnostics`,`/chrome`. Não existe `/help`. O único caminho de descoberta é digitar `/` (mostra 15).
- Proposta mínima: desesconder `/hotkeys` (1 booleano). Opcional: adicionar `/help` visível que lista os comandos não-hidden + descrições (já em `BUILTIN_SLASH_COMMANDS`) e aponta `/hotkeys`.
- Risco: baixo, aditivo (guard de órfãos já cobre comando novo).

### 20. `PIT_DISABLE_CLAUDE_CODE_SKILLS` foge da convenção `PIT_NO_*` — médio, P, fato
- `skills.ts:528` usa `PIT_DISABLE_CLAUDE_CODE_SKILLS === "1"` — único opt-out com prefixo `DISABLE` (todos os outros são `PIT_NO_*`). **Conferido**: o desvio realmente único é o prefixo (o `=== "1"` estrito também é usado por outros).
- Proposta: aceitar `PIT_NO_CLAUDE_CODE_SKILLS` via `isTruthyEnvFlag`, mantendo o antigo como alias por um ciclo.
- Risco: baixo com alias.

### 21. Nenhum guard registra `recordDiagnostic` — médio, M, fato  *(alinhado com "telemetria dos guards" do backlog)*
- `grep recordDiagnostic` em `core/built-ins/` = 0; presente em 19 arquivos de `core/`. Os guards (grounding ×4, edit-precondition, read-guard, learned-error) só retornam `{block,reason}` sem telemetria → invisíveis a `/diagnostics`, impossível medir aceitação/ruído.
- Proposta: `recordDiagnostic('<guard>:block'/'<guard>:rewrite')` no ponto de decisão, dentro do try/catch fail-open. Aditivo, fora do caminho de decisão.
- Risco: baixo (`recordDiagnostic` é O(1)/never-throws).

### 22. `[Skill conflicts]` aparece por padrão no caso comum sem dizer como resolver — baixo-médio, P, fato
- O Pit carrega `~/.claude/skills` + legacy (`.codex/.cursor/.gemini`) por padrão; para o público-alvo (que tem essas ferramentas), colisões de nome são o estado **esperado**, não erro. `interactive-mode.ts:1244` rotula "[Skill conflicts]". **Conferido**: `diagnostics-block.ts:29-37` já de-noisa (gutter muted, colapsado "ctrl+o to expand") — não domina o frame; sobra a palavra "conflicts" + ausência de linha de ação + aparecer no quiet-startup.
- Proposta: renomear para algo não-alarmante ("Skills: N duplicadas ignoradas"), adicionar linha de ação ("maior precedência venceu; --verbose para fontes") e/ou rebaixar colisões de fonte conhecida para `--verbose`.
- Risco: baixo (apresentação; precedência não muda).

---

## TIER 3 — Polish / consistência / docs (baixo impacto; agrupados por tema)

### A. Convenção de reticência `…` (regra dura do projeto)
- **#24** `Loader` default `"Loading..."` + JSDoc/README (`tui/src/components/loader.ts:91`, `cancellable-loader.ts:9`, `README.md:386/389/402`). P, fato. (default é quase código morto; valor = fidelidade de copy-paste.)
- **#27** 6 strings visíveis `"..."`→`"…"` em `bash-execution.ts:78/230`, `tool-execution.ts:240`, `session-selector.ts:133`, `tree-selector.ts:856/875` (contraste: `tool-activity.ts:25` já usa `…`). P, fato.

### B. Padding até a largura sem background (diverge de Text/TruncatedText)
- **#21** `markdown.ts:412-416` (+`:226`) padroniza toda linha sem-bg até a largura — o caminho dominante de prosa, exatamente o que Text/TruncatedText evitam de propósito. M, fato. (artefato de elipse-órfã é estreito dentro do renderer do Pit; morde em hosts que prefixam/re-wrap.)
- **#26** `box.ts:134-143` mesmo padrão; latente (todos os callers atuais passam `bgFn`). P, fato. Empacotar com #21.

### C. Resquícios de naming `pi`→`pit`
- **#33** `docs/agents/tools-and-config.md:5/32` ainda diz `pi-mono` (doc loaded-on-demand → vaza no contexto). P, fato.
- **#41** `cli/args.ts:316`, `cli/dry-run/index.ts:234`, `cli/config-selector.ts:2` usam `pi` hardcoded em vez de `APP_NAME`. P, fato. (2 testes fixam `pi dry-run` — atualizar junto. Bônus: `package-manager-cli.ts:256` tem `=== "pit" || === "pit"` duplicado.)
- **#28** `custom-message.ts:14/21` + `agent-session.ts:4152/4175` usam `customType:"pi.fusion-flow"/"pi.fusion-summary"`. P, fato. **Mudar os 4 pontos no mesmo commit** (string-match acopla emissor↔renderer).
- **#54** Codex `originator`/user-agent usam `pi` (`openai-codex-responses.ts:1374-1376`, `oauth/openai-codex.ts:190`); CHANGELOG já afirma `pit`. P, fato. **Não mexer no `originator` sem validar login real** (acopla wire-identity ao OAuth); seguro trocar só o user-agent.

### D. Família de getters do settings-manager
- **#30** `getBranchSummarySkipPrompt` (`:1194`) redundante com `getBranchSummarySettings().skipPrompt` (`:1095`) — default duplicado. P, fato.
- **#31** `getDoubleEscapeAction`/`getToolActivity` não validam o enum (só `?? default`) enquanto `getTreeFilterMode` valida — extrair `oneOf(raw, allowed, fallback)`. P, fato.
- **#32** `imageWidthCells` sem teto (`clampInt(...,Infinity)`) ao contrário da família ([1,400] sugerido). P, fato. (consumo final já faz `Math.min(width-2,...)` → efeito prático mínimo.)

### E. Calibração de conduta (defaults bem feitos; ajustes finos)
- **#37** Doom-loop: `TIER1_THRESHOLD` é configurável mas `TIER2=4`/`TIER3=6` são fixos → `threshold>3` inverte a ordem (pause antes do soft). Derivar 2/3 do threshold (o sibling stagnation já faz esse clamp). P, fato.
- **#35**+**#59** Goal: `GOAL_MAX_AUTO_ITERATIONS=50` e os tiers agressivos do doom-loop são constantes — sem mensagem acionável no pause-por-cap e sem override por setting. Promover a `settings` (defaults idênticos) + mensagem de pause acionável. P/M, fato.
- **#36** `errorReflection` OFF por default — **registro de saúde, não mexer** (calibração correta e documentada).

### F. Agent-core: contrato de eventos terminais
- **#38** Turno sintético do turn-budget emite `turn_end`/`agent_end` sem `turn_start` pareado (`agent-loop.ts:269-277`). Emitir `turn_start` antes do notice. P, fato.
- **#39** Stop deliberado por budget/TTSR usa `stopReason:"error"` (`:334/:447`), igualando a falha de provider. Não mudar o enum (cross-package); prefixar `errorMessage` com marcador estável (`[stop: turn-budget]`). P, fato.

### G. Gates de tool / surface
- **#43** Gate de `code` diverge: `codingGateOpen('code')` não exige eval, mas `_defaultActiveToolNames` exige (`tools/index.ts:760` vs `agent-session.ts:963`) → consumidor SDK com `eval.enabled:false` recebe `code` ativa sem kernel. Alinhar o gate. P, fato. (zero usuários TUI afetados.)
- **#44** `calc` sempre-on sugere "use eval" em 3 erros + guideline, mas eval é desligável (`calc.ts:143/297/313/356`). Suavizar para texto agnóstico. P, fato.
- **NOVERD[2]** Erro das `chrome_devtools_*` (`chrome-devtools.ts:61`) manda habilitar `chromeDevtools.enabled`, mas o manager é criado incondicionalmente e o gate é default-on → instrução não-acionável. Espelhar a msg de `preview.ts`. P, fato. **Validado à mão.**
- **NOVERD[3]** Comentário "Single source of truth" do `TOOL_REGISTRY` (`tools/index.ts:329`) não governa a surface da TUI (`_defaultActiveToolNames` decide) — induz a erro de manutenção. Documentar a relação real. P, fato. **Validado à mão.**
- **#60** `promptGuidelines` de code-mode nascem sem a lista `tools.*` (built EAGERLY antes da surface existir; `code-mode.ts:124`) → modelo perde a pista de quais tools usar via code-mode. Resolver a lista lazy no (re)build do system prompt. M, fato.
- **#34** `code` tem `PIT_NO_CODE_MODE`+`code.enabled`; `debug`/`lsp` só settings — documentar a convenção env-vs-settings. P, fato.

### H. Guards: opt-out / observabilidade
- **#46** `learned-error-guard` é o único guard bloqueante sem kill-switch por env. Adicionar `PIT_NO_LEARNED_ERROR_GUARD` + linha no README. P, fato. (auto-mitiga: fire-once por (tool,args).)
- **#61** `/mcp` não distingue tools eager vs deferred (`mcp-extension.ts:245`) — server grande deferido aparece como "20 tools" disponíveis. Anotar `(deferred — discovered on demand)`. M, fato.
- **#62** Sem opt-out de fonte legacy específica de skills (`legacy-discovery.ts:136`) — só `--no-skills` (tudo) ou editar frontmatter alheio. Adicionar `PIT_NO_LEGACY_SKILLS`. M, fato.
- **#48** Colisão de skill não mostra a regra de precedência (`winnerSource`/`loserSource` existem no tipo mas ficam vazios; `skills.ts:565`). Preencher + exibir. P, fato.

### I. Docs de env-var/knobs indocumentados
- **#57** `usage.md` não lista nenhum `PIT_NO_*` (só o README do pacote). Espelhar a tabela. M, fato.
- **#58** Knobs de comportamento indocumentados: `PIT_SUBAGENT_MAX_DEPTH/MAX_BYTES`, `PIT_BASH_AUTO_BACKGROUND_SECONDS`, `PIT_CODE_MODE_MAX_RESULT_BYTES`, `PIT_FREQ_OUTLINE`, `PIT_NARRATION`, `PIT_PROACTIVE_PRUNE(+_FLOOR)`. Seção "Advanced tuning". M, fato.
- **#53** `PIT_KEY_COOLDOWN_MS` (`credential-pool.ts:43`) não está nas tabelas de env-var do usuário. 1 linha. P, fato.
- **#52** Cooldown do fallback-chain (`retry-with-fallback.ts:26`, 5min) não é ajustável por env (o do credential-pool é via `PIT_KEY_COOLDOWN_MS`). Ler a mesma var (ou settings). P, fato. (já é tunável por `settings.retry.cooldownMs`.)

### J. CLI help
- **#40** `args.ts:322` `--provider ... (default: google)` — o default real é a cadeia `auto`. Remover `(default: google)`. P, fato.
- **#42** `pit -p` sem mensagem e sem stdin sai em silêncio (exit 0; `main.ts:824`+`print-mode.ts:125`). Guard: `console.error("No prompt provided...")` + exit 1. P, fato.

### K. Outros
- **#25** `settings-list.ts:99` empty-state não truncado (irmão em `:108` é). P, fato. (só estoura abaixo de ~22 cols.)
- **#29** Loader do bash não usa `workingPulsePalette` (`bash-execution.ts:74`) — cadência de cor diferente. P, **hipótese** (verde do bash é identidade deliberada; provável no-op — registro).
- **#49** JSDoc de hook diz `decision:"deny"` mas o código só aceita `"block"` (`hooks/types.ts:5`). 1 palavra. P, fato.
- **#50** Description de `memory_append` tem placeholder `<config>` não-interpolado (`memory-extension.ts:21`) — interpolar `configDirName` (cuidado: já inclui o ponto → `~/${configDirName}/...`). P, fato.
- **#51** `/memory` descreve "Show paths" mas despeja o conteúdo inteiro (`memory-extension.ts:71`). Alinhar a descrição ou gatear o dump atrás de `/memory show`. P, fato.
- **#56** `openai-codex` sem entrada em `BUILT_IN_PROVIDER_DISPLAY_NAMES` (`provider-display-names.ts`) — mascarado pelo name do OAuth. 1 linha. P, fato.

---

## APÊNDICE A — Refutados (não implementar)

|#|item|por quê|
|-|-|-|
|R1|`thinkingBudgets` passa valores crus ao provider sem coerção|valor já validado/clampado upstream; não se sustentou|
|R2|`PIT_NO_FUSION` kill-switch indocumentado|é real mas a substância caiu no veredicto (intencional/coberto)|
|R3|Listagem de unknown-tool alfabética e truncada em 16|comportamento deliberado e razoável; não é defeito|
|R4|`--help`/`--list-models`/`--dry-run` rodam após construir o runtime|é **latência de boot** — fora do eixo desta revisão|
|R5|Google ignora `GOOGLE_API_KEY`|`GEMINI_API_KEY` é o correto; o SDK `@google/genai` reconhece nativamente|
|R6|Default OpenAI gpt-5.4 vs gpt-5.5|escolha de custo×capacidade intencional, não defasagem (auto-rotulado hipótese pelo próprio finder)|

## APÊNDICE B — Fora de escopo (latência/perf)
Nenhum finding confirmado caiu aqui (R4 acima é o único de perf, listado como refutado por escopo).

## APÊNDICE C — Cobertura
3 verificadores caíram por rate-limit do servidor (`verify:tools-defs` ×2, `verify:tui-core` ×1). Os 3 findings afetados (editor bottom border, chrome msg, registry comment) foram **validados à mão** contra o código e promovidos — ver Tier 1 #7, Tier 3 G NOVERD[2]/[3].

---

## Recomendação de execução (melhor impacto/esforço)
Começar pelo **Tier 1 inteiro** (7 itens, todos P, sem downside): corrige 1 zero-config quebrado, 2 contratos doc-vs-código que enganam silenciosamente, 1 pegadinha de env, 1 default estagnado, 1 sub-dosagem de guard no modo `/goal` e 1 crash latente de largura. Depois Tier 2 em lote (DX/ergonomia). Tier 3 é oportunístico — agrupar por tema (reticências, naming pi→pit, docs de env-var) num commit cada.
