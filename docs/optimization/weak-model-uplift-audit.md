# Relatório de uplift de qualidade para modelos fracos no harness do Pit

**Leitor-alvo:** mantenedor do Pit que vai priorizar e implementar melhorias no
harness sem reler esta análise.

**Tese (do usuário):** o Pit já tem camadas que reduzem erro do modelo. O objetivo
agora é transformar o harness numa estrutura que **extraia qualidade de Opus de
modelos mais fracos** (Sonnet, Haiku, GPT-class, modelos abertos) — de forma ampla
e model-agnostic, de modo que o próprio Claude também se beneficie. O foco principal
segue sendo Claude; o desenho é genérico.

**Método:** leitura direta do código-fonte + 3 subagentes paralelos (camada
preventiva / camada corretiva-aprendizado / camada de steering-adaptatividade).

> **Status de verificação (rev. 2026-06-16).** Todos os 23 itens foram re-vetados
> contra o código por 4 agentes de leitura direta + spot-check manual dos achados
> decisivos (PV2, QW2, CR3). Conclusão: o relatório é **factualmente sólido** — todos
> os símbolos/APIs citados existem; nenhuma proposta depende de algo inventado (a
> única "feature fantasma", o Diff Limit, é corretamente denunciada como ausente em
> PV2). Duas ressalvas transversais foram corrigidas nesta revisão:
>
> 1. **Drift de `file:line`.** O texto original apontava sistematicamente o
>    bloco/import do adapter em vez da declaração/função real. Os números abaixo foram
>    **corrigidos**; ainda assim, **ancore a implementação pelo nome do símbolo**, não
>    pela linha (as linhas são estimativas e o `agent-session.ts` tem ~5,2 k linhas).
> 2. **6 imprecisões de mecanismo** (ST2, ST3, ST5, CR3, PV4, PV7c) que **inflavam o
>    valor aparente** desses itens. Cada uma está marcada inline com
>    **⚠ Correção (rev. 2026-06-16)** e resumida no §10 (changelog).
>
> Cada item agora carrega um **Veredito** explícito: `Confere` (estado atual bate com o
> código) · `Implementável` · `Vale a pena` · `Prioridade` (Tier 1 fazer / Tier 2
> ressalva / Tier 3 benchmark-first ou descartar).

> **Atualização (2026-06-29) — Session Recovery shipped.** Uplift reativo por sessão
> (`packages/coding-agent/src/core/session-recovery.ts`) substitui a fundação
> **EE1/QW3** (`capabilityTier` + prompt por modelo). Sem classificar modelo: `lean`
> default, escala `guided`/`strict` em thrash, desce em streak limpa. Itens **EE1**,
> **QW3**, **ST4**, **QW1** (parcial — reflection via steer em guided+) rebaixados;
> ver [`prevention-layers.md`](../agents/prevention-layers.md) Band D.

---

## Sumário executivo (visão por categoria + prioridade)

Régua de prioridade: **T1** = alto valor, baixo risco, fazer; **T2** = vale com
ressalva (gated por tier / medir antes / só um subconjunto); **T3** = benchmark-first
ou descartar.

Coluna **Alcance** marca o recorte do §0-bis: **Universal** = beneficia qualquer
modelo (Opus/Claude-grade incluído) por ser guard/gate/correção; **Infra** = neutro
(habilita/protege o caminho lean do forte); **Weak** = scaffolding gated ao tier fraco
(ligado no forte vira ruído/custo).

|Categoria|Item|Confere|Impl|Vale|Prioridade|Alcance|
|-|-|-|-|-|-|-|
|Espinha dorsal|EE1 capability tier|sim|sim|sim|**T1** (fundação)|Infra|
|Quick win|QW3 threading do tier no prompt|sim|sim|sim|**T1** (fundação)|Infra|
|Quick win|QW2 deny-floor + path aliases|sim|sim|sim|**T1** (segurança, independe do tier)|**Universal**|
|Quick win|QW1 errorReflection como steer|sim|sim|talvez|T2 (gated weak)|Weak|
|Steering|ST4 narração por tier|sim|sim|sim|**T1**|Weak|
|Steering|ST1 engineering-style por tier|sim|sim|talvez|T2|Weak|
|Steering|ST3 thresholds doom-loop por tier|parcial|sim|talvez|T2|Weak|
|Steering|ST5 frequent-files/skills por tier|parcial|sim|talvez|T2|Weak|
|Steering|ST2 self-critique in-process|parcial|parcial|talvez|T3 (benchmark-first)|**Universal** (+6,7 medido em Opus)|
|Preventiva|PV1 fire-once exige reconsideração|sim|sim|talvez|T2 (medir override antes)|Weak (telemetria é universal)|
|Preventiva|PV2 Diff Limit (vaporware)|sim|sim|talvez|T2 (reconciliar ADR, não "pause")|**Universal** (só a reconciliação)|
|Preventiva|PV3 imports bare + alias tsconfig|sim|parcial|talvez|T2 (só bare-only)|**Universal**|
|Preventiva|PV6 grounding de bash|parcial|parcial|talvez|T2 (só npm-script)|**Universal** (só npm-script)|
|Preventiva|PV4 candidato fuzzy repo-wide|parcial|parcial|não|**T3 descartar**|—|
|Preventiva|PV5 usage-grounding de símbolos|sim|parcial|não|**T3 descartar**|—|
|Preventiva|PV7 menores (a/b/c)|parcial|parcial|não|**T3 descartar**|—|
|Corretiva|CR1 fechar "done on red"|parcial|sim|sim|**T1**|**Universal**|
|Corretiva|CR5 loop por result-fingerprint|sim|sim|sim|**T1**|**Universal**|
|Corretiva|CR4 persistir incremental + tier|sim|sim|sim|**T1**|**Universal** (persistência); Weak (threshold)|
|Corretiva|CR6 recuperação estruturada Tier-3|sim|sim|sim|**T1**|**Universal** (recuperação); Weak (guard persistente)|
|Corretiva|CR2 hindsight automático|sim|sim|talvez|T2 (off-default)|**Universal** (off-default)|
|Corretiva|CR3 triagem do output de verificação|parcial|parcial|talvez|T2 (delta menor)|**Universal**|
|Corretiva|CR7 debug-verify p/ TS/JS|sim|parcial|talvez|T2/T3|**Universal**|

**Contagem:** 8 itens T1 (fazer) · 11 itens T2 (ressalva) · 4 itens T3 (3 descartar +
ST2 benchmark-first).

---

## 0-bis. Recorte: ganho universal vs. uplift weak-only

A tese do relatório é uplift de modelo fraco, mas **nem todo item é scaffolding p/
weak** — vários são correções que valem para **qualquer** modelo, inclusive
Opus/Claude-grade. O critério que separa os dois:

- **Guard / gate / correção de bug** → dispara **só quando há erro real** (fail-open,
  custo zero quando o modelo acerta). Pega o erro de **qualquer** modelo — inclusive o
  forte quando ele escorrega. → **Universal.**
- **Scaffolding de prompt** (reflexão forçada, narração, bullets extras, thresholds
  estritos, mais âncora) → **custo/ruído fixo em todo turno**. Só compensa no weak; no
  forte degrada (tokens, latência, redundância). → **Weak-only.**

### Grupo Universal — vale para Opus/Claude também (priorizar se o foco for ganho amplo)
- **QW2** — furo de **segurança** universal (`file_path`/alias fura o deny-floor de
  segredos em qualquer modelo, não só weak).
- **CR1** — "done on red" é bug de **processo**: sem goal ativo (caso default) nenhum
  modelo tem gate.
- **CR5** — lacuna do detector de loop (args tweakados resetam a streak) atinge
  qualquer modelo em não-progresso.
- **CR6** — o único hard-stop hoje **lança Error nu**; recuperação estruturada é melhor
  p/ qualquer modelo que chegue ao Tier-3.
- **CR3** — alinhar `goal-complete:68` ao summarizer melhora o que **todo** modelo
  recebe.
- **CR7** — "check verde que não cobre a linha corrigida" é gap de cobertura universal.
- **CR4** (parte) — persistir incremental esquenta o store p/ todos (o *threshold por
  tier* é a parte weak).
- **CR2** — auto-retain/recall valem p/ qualquer modelo (ressalva: off-default).
- **PV3-bare** / **PV6-npm** — guards block-only que pegam import/​script inexistente de
  **qualquer** modelo, antes do typecheck.
- **PV2** (parte) — reconciliar o ADR-0002 mentiroso + CONTEXT.md é higiene de doc,
  independe de modelo (a *feature* pause é weak e fora do fluxo do usuário).
- **ST2** — caso mais forte: o **+6,7 pts foi medido em Opus 4.8 self-fusion**, não em
  weak. Self-crítica ajuda até o modelo top. *Ressalva:* medido em plan read-only, não
  edição → benchmark próprio antes.

### Grupo Infra — neutro p/ o forte (na prática, o *protege*)
- **EE1** + **QW3** — não melhoram o forte, mas são o switch que **garante que o Opus
  segue lean** (não recebe o scaffolding do weak). Sem eles, qualquer melhoria de prompt
  cairia em todo modelo.

### Grupo Weak-only — ligado no forte vira ruído/custo
- **QW1** (o código diz *"modern models already read the error"*), **ST1** (+300 tok),
  **ST3** (abortar cedo arrisca cortar convergência do forte), **ST4** (o forte já
  opera melhor terso), **ST5** (inflar contexto não ajuda o forte; custa cache em
  skills), **PV1-bloqueio** (o doc é explícito: "Opus re-emite o **corrigido**; weak o
  **idêntico**").

### Sequência "ganho universal primeiro"
Se o objetivo for melhorar **todos** os modelos (não só uplift weak):
**QW2 → CR1 → CR5 → CR3 → PV3-bare / PV6-npm**, depois CR6/CR4-persistência/CR7/CR2 e
**ST2** (benchmark-first). EE1/QW3 + todo o Grupo Weak ficam para a frente de uplift
weak dedicada (a ordem do §9).

---

## 0. O achado-mãe (o eixo que une tudo)

**O harness não tem NENHUMA adaptatividade por capacidade de modelo.** Todo lever de
steering — system prompt, guidelines, o pacote engineering-style (Karpathy), os gates
de doom-loop, frequent-files, skills — é montado **identicamente** para Opus ou para
um modelo fraco. Pior: várias camadas preventivas são *advisory / fire-once* —
desenhadas para um modelo que **lê o aviso e se corrige**. Um modelo forte aproveita;
um modelo fraco trata o bloqueio como erro transitório, **re-emite a chamada
idêntica**, bate no `fired.has(key)` e a chamada errada passa direto.

> Consequência: as camadas que mais deveriam ajudar modelos fracos **se auto-anulam
> exatamente na população de modelos fracos** que a tese quer beneficiar. A estrutura
> existe; ela só não se adapta à força do modelo.

Confirmação visual: `CONTEXT.md` cristaliza a filosofia — *"The harness determines
model quality more than the model itself"*. O refino central é fazer o harness
**medir a força do modelo e escalonar o scaffolding inversamente a ela**: mais
grounding/reflexão/decomposição/gates para modelos fracos, lean para Opus.

Quase metade dos achados depende de **uma peça de espinha dorsal**: um *capability
tier* (`weak | mid | strong`) com fonte única de verdade (EE1). Ela é o pré-requisito
que destrava os demais.

---

## TIER 1 — Implementar (alto valor, baixo risco)

### EE1 — `capabilityTier` no model registry + `inferModelTier()` (fundação)
- **Estado atual (verificado):** `@pit/ai types.ts:551-581` o `Model<TApi>` carrega
  `reasoning` (:557), `thinkingLevelMap?` (:562), `input[]` (:563), `cost{}`
  (:564-569), `contextWindow` (:570), `maxTokens` (:571) — proxies de força — mas
  **nenhum tier/classe**. `model-registry.ts:139-159` (`ModelDefinitionSchema`) e
  `:162-179` (`ModelOverrideSchema`) não têm campo de capacidade. `class ModelRegistry`
  existe em `:330` (getter `modelsList` em `:360`). Grep por `capabilityTier`/`tier`
  não retorna nada existente.
- **Ação:** adicionar `capabilityTier` **opcional** aos 2 schemas (override do usuário
  em `models.json`) e ao tipo `Model` + um heurístico puro `inferModelTier(model)` +
  `ModelRegistry.tierFor(model)`. **Esta é a fonte única de verdade** que todos os
  guards/prompt-builders/gates leem. Defaults vão no gerador
  (`packages/ai/scripts/generate-models.ts`, onde `reasoning`/`thinkingLevelMap` já são
  derivados), nunca em `models.generated.ts` (regra do AGENTS.md).
- **Caveat de verificação:** `inferModelTier` é **heurística pura** — não há sinal de
  "tier" upstream sobre os ~720 modelos do registry, então inferir por
  `cost`/`contextWindow`/`reasoning` é aproximado e classifica errado modelos
  novos/baratos-mas-fortes. **Caminho confiável:** cravar defaults explícitos por id no
  gerador para os modelos conhecidos (Sonnet/Haiku/Opus/GPT-class) e usar a heurística
  só como fallback; o override do usuário cobre o resto.
- **Veredito:** Confere: sim (zero discrepância) · Implementável: sim (aditivo, campo
  opcional, não quebra nada) · Vale: sim · **Prioridade: T1 (fundação — sem isto cada
  consumidor re-deriva força do modelo de forma divergente)**.

### QW3 — Threading do modelo/tier no `buildSystemPrompt` (plumbing que destrava tudo)
- **Estado atual (verificado):** `system-prompt.ts:26-80` `BuildSystemPromptOptions`
  **não tem campo `model`/`modelTier`**; o corpo do prompt ramifica só em
  `process.platform` (`:310-314`, usado em `:319`) e presença de tools. Mas o modelo
  **está em escopo** no ponto de montagem: `agent-session.ts:2406-2407` (`get model()`
  → `this.agent.state.model`), `_rebuildSystemPrompt` em `:2768` (chama
  `getEngineeringStyleGuidelines` em `:2787`, monta as options em `:2823-2846`),
  `_trackPrefixStability` em `:2858`.
- **Ação:** adicionar `modelTier?: "weak"|"mid"|"strong"` a `BuildSystemPromptOptions`
  e passá-lo a partir de `_rebuildSystemPrompt`, fanout para
  `getEngineeringStyleGuidelines(style, tier)` e `buildSystemPrompt({…, modelTier})`.
- **Disciplina de cache:** o conteúdo derivado de tier cai no **prefixo cacheável**
  (é guideline, não vai no sufixo dinâmico), então o tier precisa ser **estável por
  sessão**. Um `/model` que cruze tier conta como 1 rebuild de prefixo em
  `_trackPrefixStability` — exatamente o mesmo perfil que o engineering-style atual já
  tem no switch de modelo, logo é seguro.
- **Veredito:** Confere: sim · Implementável: sim (trivial; valor já em escopo) ·
  Vale: sim · **Prioridade: T1 (habilita QW1/ST1/ST3/ST4/ST5 e parte da corretiva)**.

### QW2 — Unificar coleta de path da deny-floor com os aliases dos guards (segurança model-agnostic)
- **Estado atual (verificado — spot-check manual):** `permissions/checker.ts:195` —
  `edit` coleta só `["file"]` (**nem o `path` canônico**); `write` coleta
  `["file","path"]` (`:199`). `collectPathFields` (`:239-259`) itera apenas os campos
  literais + `edits[].file` — **ignora** `file_path`/`filepath`/`filename`. Roda no
  evento `tool_call` (`permissions-extension.ts:80-82`) com input **cru**, **antes** do
  `prepareArguments` normalizar o alias. Os guards de read/grounding já usam
  `extractPathArg` (`tools/argument-prep.ts:169-171`) + `PATH_KEY_ALIASES`
  (`:95-100`, inclui `file_path`/`filepath`/`filename`/`file`); a *deny-floor de
  segurança* não.
- **Por que importa:** modelos GPT/Gemini/abertos emitem `file_path` (estilo OpenAI —
  o próprio `prepareEditArguments` existe por isso). Em modo auto, um
  `edit file_path: ".env"` → `collectPathFields → []` → o loop de
  `BUILTIN_SENSITIVE_PATHS` (`**/.env`, `types.ts:79-88`) nunca casa → cai em
  `{decision:"allow"}`. **É um furo de segurança reproduzível**, e atinge mais o
  público-alvo do relatório (modelos não-Anthropic usam o alias).
- **Ação:** trocar as listas ad-hoc por `extractPathArg`/`PATH_KEY_ALIASES`
  (+ varredura de `edits[]` com os mesmos aliases) como fonte única; no mínimo
  adicionar `file_path`/`filepath`/`filename` em todas as listas e `path` na lista do
  `edit`. `argument-prep.ts` não importa de `permissions` (sem ciclo).
- **Veredito:** Confere: sim · Implementável: sim (~10 linhas, reusa export pronto) ·
  Vale: sim · **Prioridade: T1 — correção de invariante de segurança; independe do
  tier, pode ir antes de EE1**.

### ST4 — Narração/concisão por tier (grounding implícito)
- **Estado atual (verificado):** `system-prompt.ts:299-301` — `addGuideline("Respond
  only when the task is done… No preamble, no narration between tool calls, no
  end-of-turn summary unless requested.")`, calibrado para comportamento de modelo
  forte. **Já é um bloco isolável e gateado**: `narrationEnabled = process.env
  .PIT_NARRATION === "1"` (`:295`); se ON → `"Be concise…"` (`:297`), senão → o steer
  terso (`:299-301`). O corpo do prompt é **model-agnostic** (grep por "you are Claude"
  → 0 hits); o risco não é texto Claude-specific, são **suposições comportamentais
  Claude-grade**.
- **Ação:** trocar o gate de env-flag por **tier** — weak mantém narração/reflexão por
  passo ON (duplica como grounding); strong fica terso. É substituir a condição do `if`
  em `:296`. `addGuideline` passa pela dedup por `Set`, sem duplicação.
- **Veredito:** Confere: sim (zero discrepância) · Implementável: sim (cirúrgico —
  toggle já provado) · Vale: sim (narração explícita é grounding conhecido p/ weak;
  custo ~0 de código) · **Prioridade: T1**. *Atenção:* narração ON aumenta tokens de
  output (5× custo de input) — só compensa no weak; e não pode vazar estado interno no
  output (regra do projeto). Interage com ST1 (verbosidade dobrada) — coordenar.

### CR1 — Fechar o bypass "declarar pronto com check vermelho"
- **Estado atual (verificado):** `goal-complete.ts:54-80` — a recusa por check-vermelho
  (probe `:64-80`) só roda **depois** do early-return `:56` (`No active goal` se
  `!mgr || !goal || status === "complete"`); **sem goal → sem gate**. O gate de
  fim-de-turno (`agent-session.ts:3112-3200`) só dispara se há arquivo tocado
  (`:3113` `if (this._inVerification || !this._turnTouchedFiles) return`), roda
  `maxAttempts` default **2** (`settings-manager.ts:86` comentário + `:1253`
  `Math.max(1, v?.maxAttempts ?? 2)`).
- **⚠ Correção (rev. 2026-06-16):** o "return silencioso" do original é **semi-falso**.
  Ao esgotar (`:3188 if (!willRetry) return`), ele **antes** emite um evento
  `{type:"verification", phase:"failed", willRetry:false}` (`:3179-3187`) — ou seja,
  **não é mudo para a TUI**. O que de fato falta é **steer para o modelo**: ele desiste
  sem dizer ao modelo "o check segue vermelho".
- **Ação:** (1) rodar o verification probe no **fim de qualquer turno que modifica
  código, independente de goal** (reusar `runConfiguredCheck()` em `:3207-3213` +
  `getCurrentVerificationProbe`; a flag `_turnTouchedFiles` já existe e é resetada em
  `:2992`); (2) `maxAttempts` por tier (subir p/ ~4-5 em weak); (3) ao esgotar,
  **injetar steer explícito** ("o check SEGUE VERMELHO — você não pode reportar pronto;
  resuma o bloqueio") em vez do `return`; (4) se o turno termina vermelho e o modelo
  usou linguagem de conclusão (inspecionar a última `AssistantMessage` via
  `this.agent.state.messages`), devolver a contradição como steer.
- **Veredito:** Confere: parcial (correção acima) · Implementável: sim · Vale: sim
  (furo real no caso default sem goal) · **Prioridade: T1**. *Atenção:* evitar dupla
  execução do check (gate + probe de fim — compartilhar o resultado do mesmo turno);
  cuidar repo com check vermelho **pré-existente** não-relacionado (`verificationFix
  Prompt:383` já reconhece o caso em texto, mas um bloqueio duro o ignoraria).

### CR5 — Detector de loop por fingerprint-de-resultado (pega o "thrash" do modelo fraco)
- **Estado atual (verificado):** `tool-call-stats.ts:214-227`
  (`getConsecutiveSimilarResultCount`) quebra a streak em `:222` (`toolName` **ou**
  `argsFingerprint` diferente) **antes** de checar `resultHash` em `:223`. Logo
  **qualquer mudança de arg zera a contagem**. Esse contador dirige o doom-loop
  (`agent-session.ts:1926`). Já existem `fingerprintToolResult` (`:395-414`, FNV-1a do
  erro+texto) e `recordInvocationResult` (`:199-204`) — o `resultHash` já é capturado
  por chamada.
- **Por que importa:** modelo fraco loopa **tweakando** (offset deslocado, `oldText`
  levemente diferente) → reseta a streak → o escalonamento Tier-1/2/3 (que culmina no
  abort em `:1946`) **nunca sobe**; só o cross-error reminder pega, e tarde.
- **Ação:** novo método `getConsecutiveSimilarResultOnlyCount()` (~10 linhas, sem tocar
  o existente) que conta entradas com o **mesmo `resultHash`** independente de
  `toolName`/args, alimentando o mesmo ladder; restringir a `isError` (o
  `fingerprintToolResult` inclui o flag) para reduzir ruído; baixar o threshold
  cross-error para tiers fracos.
- **Veredito:** Confere: sim (zero discrepância) · Implementável: sim (infra toda
  existe) · Vale: sim (ataca o modo de falha clássico do weak) · **Prioridade: T1**.
  *Atenção:* excluir resultados vazios/sucesso e usar threshold mais alto que o
  args-keyed, p/ não somar dois passos legítimos que retornam o mesmo texto.

### CR4 — Learning cross-session: persistir incremental (sobreviver a kills) + thresholds por tier
- **Estado atual (verificado):** o guard só dispara com `totalCount ≥ minOccurrences`
  **E** `sessionCount ≥ minSessions` (`learned-error-guard-extension.ts:72-73`:
  `minOccurrences = Math.max(2, ?? 3)`, `minSessions = Math.max(1, ?? 2)`; gate em
  `:98`). Default efetivo = **3 ocorrências e 2 sessões**. Persistência **só no
  teardown**: `agent-session.ts:1831-1851` `_persistLearnedErrors()` chama
  `persistSessionLearnedErrors(...)` (guard `:1837 if (!this.sessionManager
  .isPersisted()) return`). Checkout fresco / 2 primeiras sessões = **zero** proteção
  cross-session; sessão de modelo fraco que trava e é **morta nunca chega ao dispose**
  → nada persiste → o store nunca esquenta.
- **⚠ Correção (rev. 2026-06-16):** o `writeFileSync` síncrono **não está inline** em
  `:1831-1850` — está encapsulado em `persistSessionLearnedErrors`
  (`learned-error-store.ts`), que faz **append JSONL** por sessão. O método de `:1831`
  só monta os args e chama.
- **Ação:** (1) persistir **incremental/append** a cada novo fingerprint (ou no fim de
  turno) para sessões mortas contribuírem — reusando `persistSessionLearnedErrors`,
  com **upsert/dedupe por `(sessionId, fingerprint)`** (hoje é 1 registro por sessão no
  dispose); (2) `minSessions`/`minOccurrences` por tier — para weak, `minSessions:1,
  minOccurrences:2` (campos já existem como `options.minOccurrences/minSessions` em
  `:58-61` — só plumbar o tier até a factory).
- **Veredito:** Confere: sim · Implementável: sim · Vale: sim (cold-start é justamente
  onde weak repete o erro) · **Prioridade: T1**. *Atenção:* baixar threshold arrisca
  falso-guard (mitigado pelo fire-once: re-emitir roda mesmo assim); append incremental
  aumenta I/O e exige o dedupe.

### CR6 — Recuperação estruturada no Tier-3 + guard learned-error persistente para weak
- **Estado atual (verificado):** o único hard-stop (Tier-3) **lança Error nu**
  mid-turn (`agent-session.ts:1946-1953`: `throw new Error("Doom loop abort: …")`),
  encerra o turno por exceção, sem re-plano. O learned-error guard dispara **uma vez**
  e deixa a re-emissão idêntica passar (`learned-error-guard-extension.ts:119-137` — o
  próprio `reason` diz *"This guard fires once; re-issue the identical call to run it
  anyway"*).
- **Ação:** (1) trocar o `throw` por **injeção de recuperação estruturada** via
  `_fireReminder(..., {deliverAs:"steer"})` ("você loopou N vezes; pare; descreva a
  subtarefa 1 e execute só ela") — os Tier-1/2 já usam exatamente esse padrão de steer
  (`:1973`, `:1987`); manter um abort de segurança após K steers; (2) para tiers
  fracos, tornar o learned-error guard **persistente** (bloqueia até o modelo mudar a
  chamada materialmente) em vez de fire-once — ligado ao EE1.
- **Veredito:** Confere: sim (off-by-one: fire-once é `:119-137`, doc dizia 120) ·
  Implementável: sim (padrão de steer já existe no mesmo método) · Vale: sim (o Tier-3
  atual é o pior resultado p/ weak — morre sem orientação e reabre o loop no próximo
  turno) · **Prioridade: T1**. *Atenção:* block persistente pode wedge um retry
  legítimo — usar bloqueio N-vezes, não infinito.

---

## TIER 2 — Vale com ressalva (gated por tier / medir antes / subconjunto)

### QW1 — Ligar a reflexão estruturada de erro, entregue como `steer` (não `followUp`)
- **Estado atual (verificado):** `settings-manager.ts:115` `errorReflection.enabled`
  default **false**; `:1189` só liga com `=== true`; `tool-call-feedback.ts:228-230`
  (`decideErrorReflection`) retorna false sem isso. O comentário `settings-manager
  .ts:1150-1160` documenta o porquê: era entregue como `followUp` (turno separado,
  chegava stale e vazava um "phantom reply"), e *"modern models already read the
  error"*. `buildToolErrorReflection` (`tool-call-feedback.ts:52-89`, monta o-que /
  por-quê / correção em `:78-83`) força o chain-of-thought que um modelo fraco **não
  gera sozinho**.
- **Ação:** ligar por **tier** (ON para weak/mid, manter o default lean para strong) e
  trocar `deliverAs: "followUp"` (`agent-session.ts:2189`) por `steer` — o mesmo canal
  que doom-loop (`:1973`/`:1988`) e failure-budget (`:2229`) já usam, roteado por
  `sendCustomMessage(..., {deliverAs:"steer"})` → `this.agent.steer()` (`:3610`).
  Resolve o "stale phantom" que motivou o desligamento.
- **Veredito:** Confere: sim (drift trivial: comentário começa em `:1150`, não 1152) ·
  Implementável: sim (troca de 1 token + gate de tier) · Vale: **talvez** ·
  **Prioridade: T2** — **ligar só no tier weak**; ligar global re-poluiria modelos
  fortes que já leem o erro inline (foi o motivo exato do desligamento).

### ST1 — Pacote engineering-style expandido por tier
- **Estado atual (verificado):** `engineering-styles.ts:40-45` — `KARPATHY_GUIDELINE
  _BULLETS`, **4 bullets** (Think before coding / Simplicity first / Surgical changes /
  Goal-driven, em `:41-44`); `getEngineeringStyleGuidelines(style)` (`:22`) recebe só a
  string de estilo. ADR-0004 (`docs/adr/0004-karpathy-engineering-style.md:29`)
  **deferiu explicitamente** "Configurable profiles" como *"YAGNI until proven
  otherwise"* — exatamente o mecanismo que a tese agora justifica. A dedup em
  `buildSystemPrompt:190-197` (`Set` + `addGuideline`) protege repetição.
- **⚠ Correção (rev. 2026-06-16):** o original diz "4 bullets fixos **sempre-on**". Na
  prática são **gated por settings**: `EngineeringStyle = "default" | "karpathy"`
  (`:13`); o default é `"default"`, que retorna `[]`. Não são sempre-on.
- **Ação:** terceiro pacote `KARPATHY_WEAK_BULLETS` (os 4 expandidos com decomposição
  explícita, "reafirme o objetivo", "liste os arquivos que vai tocar antes de editar",
  "após cada edit, releia e verifique", ~+300 tokens) selecionado quando
  `tier === "weak"`; lean para strong.
- **Veredito:** Confere: sim · Implementável: sim · Vale: **talvez** ·
  **Prioridade: T2**. *Atenção:* a dedup é **só string-exata** — não pega paráfrase, e
  os bullets weak podem **colidir semanticamente** com "Surgical changes"/"Goal-driven"
  se o usuário rodar `karpathy` + weak juntos. Interage com ST4 (verbosidade) —
  combinados podem inflar demais.

### ST3 — Thresholds de doom-loop escalonados por tier
- **Estado atual (verificado):** `agent-session.ts:1932-1934` thresholds fixos
  (`TIER1 = cfg.threshold ?? 2`, `TIER2 = Math.max(4, TIER1+2)`, `TIER3 = Math.max(6,
  TIER1+4)`) iguais para todo modelo. São **result-aware** (`:1922-1926`: só contam
  name+args+resultCount idênticos).
- **⚠ Correção (rev. 2026-06-16):** o título original diz "doom-loop / **diff-limit /
  gates**", mas `:1932-1934` é **exclusivamente o doom-loop** (`cfg =
  getToolFeedbackSettings().doomLoopReminder`, `:1920`). O diff-limit não existe (ver
  PV2) e os gates de verificação são outro sistema (CR1) — o doc não os ancora aqui.
- **Ação:** o tier vira multiplicador — weak recebe gates **mais estritos** (lembra e
  aborta antes); strong mantém a cadência atual. O clamp `Math.max` já garante a ordem.
- **Veredito:** Confere: parcial (escopo só doom-loop) · Implementável: sim (1-2
  linhas) · Vale: **talvez** (result-aware reduz falso-positivo) · **Prioridade: T2**.
  *Atenção:* threshold weak muito estrito (ex. TIER1=1) pode abortar turno que ainda ia
  convergir (weak às vezes precisa de 2-3 tentativas idênticas).

### ST5 — frequent-files e skills com âncora mais pesada para weak
- **Estado atual (verificado):** `skills.ts:403` `SKILLS_FULL_LIMIT = 15` (usado em
  `:459` — acima do limite a skill encolhe para nome+summary+location).
- **⚠ Correção (rev. 2026-06-16):** `frequent-files.ts:364-379` do original **está
  errado** — `:364` é o **renderer** `formatFrequentFilesForPrompt`, **sem** top-N. O
  top-N real está em **dois** lugares: (a) tracker de sessão — `topN`/`minHits` **já são
  parâmetros opcionais** (`GetTopOptions:37-42`, defaults `DEFAULT_TOP_N=10` /
  `DEFAULT_MIN_HITS=1` em `:45-46`, lidos em `:112`/`:114`); (b) scan repo-wide —
  `FREQ_DEFAULT_LIMIT` em `:441`/`:570`.
- **⚠ Correção 2:** a premissa "tudo no sufixo dinâmico, sem custo de cache-prefix"
  vale para frequent-files, **mas falha para skills** — o comentário `skills.ts:452-453`
  trata os primeiros `SKILLS_FULL_LIMIT` como **"the cacheable prefix"**. Escalar
  `SKILLS_FULL_LIMIT` por tier **invalida o prefixo cacheável** (custo de cache-write
  1,25× recorrente quando o tier oscila) — trade-off token-negativo. **Medir antes.**
- **Ação:** escalar `topN`/`minHits`/prosa por tier (já parametrizados — só passar
  valores no call-site). Para skills, tratar o aumento de `SKILLS_FULL_LIMIT` com
  cautela pelo custo de cache.
- **Veredito:** Confere: parcial (file:line errado + premissa de cache) ·
  Implementável: sim (ainda mais fácil que o pintado — params já existem) · Vale:
  **talvez** · **Prioridade: T2**. *Atenção:* inflar contexto de modelo fraco tem
  retorno decrescente e pode **afogar** (weak lida pior com contexto longo).

### PV1 — Fire-once deve exigir reconsideração, não re-emissão idêntica
- **Estado atual (verificado):** os 4 grounding adapters + o write-warn do read-guard
  bloqueiam **uma vez** (padrão `const fired = new Set<string>()` + key estável
  `${toolName}:${JSON.stringify(input, keys.sort())}` + `if (fired.has(key)) return;
  fired.add(key)`) e deixam a **re-emissão verbatim** passar:
  `grounding-guard-extension.ts:48`/`:120-133`, `import-grounding-extension.ts:77`/
  `:109-136`, `path-grounding-extension.ts:27`/`:51-64`, `pattern-grounding
  -extension.ts:24`/`:33-46`, `read-guard-extension.ts:82` (`firedWriteWarnings`)/
  `:126-159` + `:201-231`. (No read-guard, `neverRead`:`:255` e `postCompactEdit
  Mismatch`:`:194` **não** são fire-once — bloqueiam sempre, correto.)
- **⚠ Correção (rev. 2026-06-16):** "a infra de fingerprint já existe" é **parcial** —
  cada extensão tem seu **próprio `Set` local** com a fórmula inline; **não há helper
  compartilhado**. E **metade da telemetria de override já existe**: `import-grounding
  -extension` e `read-guard` já gravam `recordDiagnostic(outcome:"overridden")` na
  re-emissão (o original não menciona).
- **Ação:** liberar o escape só com **evidência de reconsideração**: (a) `Map<string,
  number>` liberando em `count ≥ N` (2-3) em vez de `Set`; ou (b) só liberar quando os
  args **mudam** (já é o comportamento — key nova = novo bloqueio); ou (c) candidato
  único → **auto-aplicar** o rewrite (só viável no símbolo grounding; import/path/pattern
  são block-only por invariante deliberada — `path-grounding.ts:25-28` diz que retargetar
  é *"strictly worse than an error"*).
- **Veredito:** Confere: sim (drift de linha trivial) · Implementável: sim · Vale:
  **talvez** · **Prioridade: T2 — instrumentar o override-rate ANTES** (estender a
  telemetria `outcome:"overridden"` aos 4 guards; alinha com "telemetria dos guards" já
  no backlog do projeto). *Atenção:* subir N transforma "advisory" em **wedge** num
  guard fuzzy/heurístico — colide com o fail-open load-bearing de todos.

### PV2 — Diff Limit: doc e ADR afirmam shipado, mas é vaporware
- **Estado atual (verificado — spot-check manual):** **confirmado que NÃO existe.**
  Grep `diffLimit|changedLines|DiffLimit|createDiffLimit` em todo
  `packages/coding-agent/src` = **0 matches**. `built-ins/index.ts:85-133` registra **13
  factories** e nenhum é de diff/limit (permissions, read-guard, edit-precondition,
  learned-error-guard, grounding-guard, import-grounding, path-grounding,
  pattern-grounding, hooks, memory, mcp, coordinator). Porém `docs/adr/0002-diff-limit
  -pause.md:3` está `Status: Accepted` (`:17` descreve `afterToolCall` acumulando
  linhas, threshold 300) e `docs/CONTEXT.md:27-28` descreve como **shipado**. Doc e
  código divergem.
- **⚠ Nota:** a afirmação vale para `docs/CONTEXT.md:27-28` — o `CONTEXT.md` da **raiz**
  é um glossário e não menciona Diff Limit.
- **Por que importa:** over-engineering (10 linhas viram 200) é o modo de falha
  dominante de modelo fraco. Nada o pega hoje. Mas o **"pause + confirm"** do ADR
  conflita frontalmente com o fluxo autônomo `/goal` do usuário ("token nunca é
  bloqueio; executar até concluir sem pausar").
- **Ação (ajustada):** **reconciliar primeiro** — rebaixar o ADR-0002 para
  `Proposed`/`Superseded` e corrigir `docs/CONTEXT.md` (a documentação está mentindo).
  Se implementar, fazer como **telemetria/diag-only** (`recordDiagnostic` em > 300
  linhas líquidas, acumuladas em `afterToolCall` — que existe em `agent-session.ts:1247`
  — reusando `computeEditsDiff` de `edit-diff.ts` + `content.split("\n")` do write),
  **não** como pause interativo.
- **Veredito:** Confere: sim (vaporware confirmado) · Implementável: sim (padrão pronto
  p/ copiar) · Vale: **talvez** · **Prioridade: T2** — o valor real é reconciliar o
  doc/ADR; o pause literal não cabe no fluxo deste usuário.

### PV3 — Grounding de imports bare (package.json) + alias do tsconfig
- **Estado atual (verificado):** `isRelativeSpecifier` (`import-grounding.ts:189-191`,
  só `./`/`../`) e `groundImports` (`:549`); bare (`react`, `@scope/x`) e alias (`@/x`)
  ficam **fora de escopo v1** por docstring **literal** (`:30-33` e `:188`:
  *"resolving those needs node_modules / tsconfig paths, out of scope for v1"*).
- **Por que importa:** modelo fraco **alucina dependências** e erra alias de path —
  pego só no typecheck, vários round-trips depois.
- **Ação:** terceiro passo em `groundImports`: (a) **bare** → resolver contra
  `dependencies`/`devDependencies`/`peerDependencies` + builtins do Node
  (`node:` + lista), bloquear com o nome mais próximo; (b) **alias** → ler
  `compilerOptions.paths`/`baseUrl` do `tsconfig.json` mais próximo.
- **Veredito:** Confere: sim · Implementável: **parcial** · Vale: **talvez** ·
  **Prioridade: T2 — fazer só o subconjunto bare-only.** O bare é barato e de baixo
  risco; o **alias-tsconfig é onde mora o perigo**: em monorepo (vários tsconfig,
  `extends` chains) resolver o tsconfig errado **falso-bloqueia import válido**,
  violando o fail-open. *Atenção:* workspace deps (`@pit/ai`) podem não estar em
  `node_modules` como nome literal — olhar `workspaces` também, senão falso-bloqueia
  import interno válido.

### PV6 — Grounding de referências do `bash` (npm scripts, file args)
- **Estado atual (verificado):** guards cobrem read/edit/write/grep/find/debug/lsp;
  `bash` só recebe rewrites de sintaxe Windows + sugestões tier-2. Nenhum grounding de
  existência. `parseSimpleArgv` (`tool-rewrite-rules.ts:51-90`) **já existe e já rejeita
  metacaractere de shell** (`:54-55`).
- **⚠ Correção (rev. 2026-06-16):** a faixa `:229-497` do original está **errada** —
  `:229` é o início de `tier1Rules` (regras de `read`, não bash) e o arquivo tem **687
  linhas**. As regras bash usam `parseSimpleArgv` nos call-sites `:376, :384, :402,
  :409, :461, :477, :491, :501`.
- **Ação:** passo de bash-grounding (nova extensão no evento `tool_call`, gated a
  `toolName === "bash"`): aterrar `npm/pnpm/yarn run <script>` contra os scripts do
  `package.json` e file-args óbvios contra disco; pular qualquer coisa com metacaractere
  (o `parseSimpleArgv` já faz). Requer **exportar/extrair** `parseSimpleArgv` do módulo
  de rewrite (hoje não é exportado para extensões).
- **Veredito:** Confere: parcial (faixa errada; metachar já tratado) · Implementável:
  **parcial** · Vale: **talvez** · **Prioridade: T2 — fazer só npm-script grounding**
  (lista fechada, alta confiança, "did you mean <script>"). File-arg genérico é ruidoso
  (flags, URLs, globs, paths gerados em runtime) e arrisca falso-bloqueio.

### CR2 — Hindsight bank como memória corretiva automática (hoje é peso morto)
- **Estado atual (verificado):** auto-write só de `kind:"session-summary"` na
  compaction (`agent-session.ts:4066-4077`); `retain`/`recall`/`reflect`/`forget` são
  tools **dirigidas pelo modelo** (`:959`); no boot só o prefixo de session-summary é
  auto-injetado (`formatSessionSummariesForPrompt` filtra `kind === "session-summary"`,
  `hindsight/index.ts:47`; chamado em `:2812-2816`). O BM25 (`hindsight/bank.ts
  :237-265`) só roda se algo chamar `bank.search()` — i.e. a tool `recall`. O kind
  `"pattern"` existe no union (`hindsight/types.ts:10`) mas **nunca é auto-escrito**.
- **Ação:** auto-`bank.add({kind:"pattern", …})` toda vez que o verification gate vai
  **vermelho→verde** ("erro X resolvido editando Y"); auto-`bank.search(errorText)` a
  cada falha de verificação, injetando o top-hit como steer via `_fireReminder`.
- **Veredito:** Confere: sim (zero discrepância) · Implementável: sim (API pronta) ·
  Vale: **talvez** · **Prioridade: T2**. *Atenção:* hindsight é **off-default** (ganho
  só p/ quem liga); recall de baixa precisão polui contexto; já há pipeline anti-erro
  denso (learned-error + Tier-4 hints + doom-loop) — risco de sobreposição. Medir
  aceitação antes.

### CR3 — Triagem/enquadramento da saída de verificação antes de re-injetar
- **Estado atual (verificado — spot-check manual):**
- **⚠ Correção (rev. 2026-06-16):** o original diz que `:3190` re-injeta o "output
  **cru** do check" — **é falso.** `:3190` chama `verificationFixPrompt(command,
  result)` (def `:371`), que em `:375` chama `summarizeCheckFailure(result.output,
  command)` (`verification/failure-summary.ts:19`) — este **já extrai** as linhas de
  falha dominantes via `FAILURE_PATTERNS` (`:5-11`: tsc, biome/eslint `file:line:col`,
  vitest, FAIL, thrown errors) e só cai p/ tail-4000 quando nada casa. O corte **cru**
  de 2000 chars existe **só** em `goal-complete.ts:68` (`result.output.slice(-2000)`).
  As hint-rules tier-4 são keyed em `call.name` (`tool-error-hint-registry.ts:111-115`,
  pacote `@pit/agent`) e só rodam em `isError` de **tool** (`bridge.ts:340-341`).
- **Ação (reduzida):** o ganho concreto e barato é (1) **alinhar `goal-complete.ts:68`**
  ao `summarizeCheckFailure` (1 linha, hoje corta cru); (2) opcionalmente anexar 1 hint
  heurístico por classe de erro de toolchain (ex.: "TS2322 → tipo incompatível, confira
  a assinatura"). **Não** forçar um `call` sintético pelo registry de tool-hints — as
  regras são tool-específicas (bash/read/edit) e quase nada dispararia no texto de um
  `tsc`/`vitest` (e poderia disparar errado, ex. "exited with code 1").
- **Veredito:** Confere: parcial (gate **já** summariza) · Implementável: parcial ·
  Vale: **talvez** (delta bem menor que o original sugere) · **Prioridade: T2**.

### CR7 — Verificação de execução real (debug-verify) além de pytest/go
- **Estado atual (verificado):** `verification.ts` — `DebuggableEcosystem = "pytest" |
  "go-test"` (`:179`); `isDebuggableRepro` (`:261-314`) só reconhece pytest+debugpy
  (`:271-293`) e go-test+dlv (`:297-308`), e **só no verde** (`:267 if (!checkResult.ok)
  return null`; caller em `agent-session.ts:3158-3175` só dentro do branch `result.ok`).
  Este monorepo TS e a maioria dos projetos JS/TS/Rust **não recebem nada** — o modo de
  falha "check verde que não cobre a linha corrigida" fica invisível.
- **Ação:** checagem leve não-DAP para TS/JS — cruzar `_turnTouchedFilePaths` (`:710`)
  com cobertura, **ou** steer heurístico "suas linhas alteradas não têm teste tocando".
- **Veredito:** Confere: sim · Implementável: **parcial** · Vale: **talvez** ·
  **Prioridade: T2/T3** (priorizar abaixo de CR1/CR4/CR5/CR6). *Atenção:* a versão
  robusta (coverage de linha) exige c8/nyc instalado e roda a suíte inteira — colide com
  a régua **zero-config/NATIVO** e com a lição "rodar a suíte repetidamente degrada a
  máquina"; a versão barata (steer heurístico) é fraca (falso-positivo em refactor sem
  novo teste mas coberto → ensina o weak a escrever teste-fantasma p/ calar o gate).

---

## TIER 3 — Benchmark-first ou descartar

### ST2 — Self-critique in-process generalizando o judge→writer do Fusion (benchmark-first)
- **Estado atual (verificado):** `fusion/orchestrator.ts:59-86` (`runFusionTurn` =
  fan-out → judge → verify → writer); `_runFusionTurn` em `agent-session.ts:4371`
  (retorna false se `panel.length < 2`, `:4377`); `fusion-mode.md:62-63` confirma o
  **+6.7 pts** (Opus self-fusion 65,5% vs solo 58,8%).
- **⚠ Correção (rev. 2026-06-16):** o **mecanismo** do original está impreciso. Só o
  **judge** roda via `completeSimple` (`:4503`); o **verifier** roda via `spawnSubagent`
  (`:4344`, **não** completeSimple) e o **writer** via `_streamFusionWriter`
  (`:4291`/`:4584`, streaming). E `:4431-4435` é o **advisor-brief** de degradação
  single-survivor, **não** o judge (judge é `:4503-4508`). Além disso o **+6.7 é em
  plan/research read-only** (`fusion-mode.md:75-76` restringe o ganho a análise) —
  **extrapolar para self-critique de edit de código é hipótese, não medição.**
  (`VERIFIER_SYSTEM`/`JUDGE_SYSTEM` existem em `fusion/judge.ts:72`/`:123`.)
- **Ação:** loop de auto-crítica de um modelo só, gated a `tier==="weak"` + turnos
  não-triviais. **Bloqueio real:** o Fusion atual é Plan-only/read-only e o writer só
  devolve **string** — aplicar a revisão de volta como **edit** (não texto) num turno de
  auto exige **wiring novo** no loop de `_promptOnce`, não é reuso do `runFusionTurn`.
- **Veredito:** Confere: parcial · Implementável: parcial (wiring novo) · Vale:
  **talvez** (especulativo sem número) · **Prioridade: T3 — benchmark-first.**
  *Atenção:* self-fusion de **um** modelo fraco herda o próprio viés (o ganho do
  benchmark vem de **diversidade** de caminhos, ausente aqui); latência/custo 2-3× no
  modelo já mais lento; precisa de cap anti-revisão-infinita.

### PV4 — Candidato fuzzy repo-wide quando o dir-alvo não tem match — **DESCARTAR**
- **Estado atual (verificado):** `rankCandidates` (`import-grounding.ts:278`,
  `path-grounding.ts:110`) usa `maxDistance=3` (`DEFAULT_MAX_DISTANCE`: import `:136`,
  path `:78`), affix off (`prefixMinOverlap=64`), busca **escopada ao dir-alvo**
  (import `:290-296`, path `:119-126`) → dir errado → `[]` → fail-open.
- **⚠ Correção (rev. 2026-06-16):** `living-index.ts:477-486` é `livingRepoMapToDigests`
  (path → símbolos), **NÃO** um enumerador de basenames. **Não há API pronta** para
  match de basename repo-wide — só o array `map.entries[].path` (`RepoMapEntry.path
  :66-68`), do qual se teria de derivar basenames.
- **Veredito:** Confere: parcial (API errada) · Implementável: parcial · Vale: **não** ·
  **Prioridade: T3 descartar.** O caso "dir certo, nome errado" (typo) **já é coberto**;
  "dir inteiro errado" geralmente significa estrutura errada, e sugerir um basename
  homônimo de outro dir aponta o arquivo **errado** — exatamente o que o path-grounding
  evita por design (block-only, nunca retarget). Baixa alavancagem, alto risco de ruído.

### PV5 — Usage-grounding escopado de símbolos importados — **DESCARTAR**
- **Estado atual (verificado):** symbol grounding só dispara para `debug`/`lsp`
  (`grounding-guard.ts:179`/`:190`, `extractReferenceTarget :176-202`); import grounding
  valida só **bindings de import nomeado** (`validateNamedExports`, `import-grounding
  .ts:496-532`). Não há checagem de identificador *usado/chamado*.
- **Veredito:** Confere: sim · Implementável: parcial · Vale: **não** ·
  **Prioridade: T3 descartar.** Sobreposição alta com o pass-2 de export já existente
  (que já pega "importou nome que o módulo não exporta" — a falha mais comum); o
  incremento (chamar símbolo nunca importado) é raro em codegen e mais barato de pegar
  no LSP-on-write que **já existe** (`setEnforceDiagnosticsOnWrite`). Pre-write LSP
  exige `didOpen` sintético de buffer não-salvo (custo alto, estado LSP sujo) e
  reintroduz o falso-bloqueio de locals/params que o symbol-guard exclui de propósito.

### PV7 — Menores (a/b/c) — **DESCARTAR**
- **(a) Import named-export listar exports reais** (`import-grounding.ts:513-528`):
  `validateNamedExports` já monta `exportList` (`:513`); o ALLOW quando nome ausente
  **sem** candidato fuzzy (`:520-521`) é **invariante deliberada** (fail-open p/
  re-export exótico que o parser regex perde). Mudar = reverter invariante. Marginal.
- **(b) Edit-precondition multi-call** (`edit-precondition-extension.ts:37`/`:54`/`:88`:
  só a 1ª edit por path/turno é dry-run-ada): o skip é **decisão consciente**
  anti-custo; manter working-copy in-memory diverge do disco. Baixa frequência.
- **(c) Ordem rewrite-vs-grounding** — **⚠ Correção (rev. 2026-06-16): INVERTIDA no
  original.** A ordem real no `agent-loop.ts` é **rewrite ANTES de grounding**
  (`:1030 toolRewriteRegistry.apply` → `:1059-1060 beforeToolCall`/tool_call). A regra
  `read-path-range-suffix` (`tool-rewrite-rules.ts:288`, `appliesTo:"read"`) **já
  normaliza** `foo.ts:10-20` antes do path-grounding ver — **não há falso-bloqueio no
  read**. Resíduo real é **edit-only** (não existe regra `:A-B` p/ edit), mas tão raro
  que não justifica regra nova.
- **Veredito:** Confere: parcial · Implementável: parcial · Vale: **não** ·
  **Prioridade: T3 descartar** (os três).

---

## Considerado e rebaixado/descartado na análise original (não retrabalhar)

|Item|Decisão|Motivo|
|-|-|-|
|Matchers tier-4 são English/format-coupled e quebram em outros LLMs|descartado|Os matchers casam o **output do próprio Pit** (estável), não do provider. Robusto cross-LLM. (`tool-error-hint-rules.ts`)|
|Corpo do system prompt tem texto Claude-specific|descartado|O corpo é model-agnostic (grep "you are Claude" → 0 hits). O risco real são suposições comportamentais Claude-grade → tratado em ST4.|
|Short-name floor (<4 chars) do grounding pula typos|descartado|O floor existe por bom motivo (ambiguidade); baixá-lo reintroduz ruído.|
|Pattern grounding só checa brackets|rebaixado|Glob malformado já é o hazard real (match-zero-silencioso); regex malformado erra alto. Poucos checks extras dialect-agnostic, baixa urgência.|

---

## 9. Ordem prática recomendada (ajustada à realidade do projeto)

1. **EE1** (capability tier) + **QW3** (threading no prompt) — fundação. Sem elas, o
   resto re-deriva força do modelo de forma divergente.
2. **QW2** (deny-floor path aliases) — **independe do tier, pode ir já**: furo de
   segurança real e barato.
3. **ST4** (narração por tier) + **QW1** (errorReflection ON+steer, gated a weak) — S,
   ganho imediato de recuperação/grounding.
4. **CR1** (fechar "done on red") + **CR5** (loop por resultado) + **CR4** (persist
   incremental + tier) + **CR6** (recuperação Tier-3) — núcleo corretivo, maior
   alavancagem real para weak.
5. **PV1** (fire-once exige reconsideração) — **mas instrumentar override-rate antes**.
6. **ST1/ST3/ST5** + **PV3-bare** + **PV6-npm** — segunda onda, gated a weak,
   benchmark-first.
7. **PV2** como reconciliação de ADR/telemetria (não pause); **CR2/CR3/CR7** só se o
   benchmark justificar.
8. **ST2** benchmark-first (especulativo). **Descartar:** PV4, PV5, PV7.

## 10. Imprecisões corrigidas nesta revisão (changelog)

|#|Item|Imprecisão do original|Correção verificada|
|-|-|-|-|
|1|todos|`file:line` apontavam o bloco/import do adapter|números corrigidos por leitura direta; ancorar por **símbolo**|
|2|ST2|judge/verify/writer "via `completeSimple`"; +6.7 justifica self-critique de edit|só o **judge** usa `completeSimple` (`:4503`); verifier=`spawnSubagent` (`:4344`), writer=`_streamFusionWriter` (`:4291`/`:4584`); `:4431` é advisor-brief, não judge; +6.7 é de **plan read-only**, não edição|
|3|ST3|thresholds "doom-loop/diff-limit/gates"|`:1932-1934` é **só doom-loop**; diff-limit não existe (PV2), gates são CR1|
|4|ST5|`frequent-files:364-379` = top-N; "sem custo cache-prefix"|`:364` é **renderer**; top-N em `:45-46`/`:112-114`/`:441`. Skills: `SKILLS_FULL_LIMIT` está no **prefixo cacheável** (`:452-453`) — escalar custa cache|
|5|CR3|`:3190` re-injeta "output cru"|`:3190`→`verificationFixPrompt:371`→`summarizeCheckFailure:375` **já summariza**; o corte cru existe só em `goal-complete:68`|
|6|PV4|`living-index:477-486` "enumera basenames"|é `livingRepoMapToDigests` (path→símbolos); **não há** API de basename repo-wide|
|7|PV7c|grounding falso-bloqueia sufixo que o rewrite normalizaria "antes"|ordem **invertida**: rewrite (`agent-loop:1030`) roda **antes** do grounding (`:1059`); read já prevenido|
|8|ST1|4 bullets Karpathy "sempre-on"|gated por `engineeringStyle` (default `"default"` → `[]`)|
|9|CR1|gate esgota com "return silencioso"|emite evento `phase:"failed"` p/ a TUI; o que falta é **steer p/ o modelo**|
|10|CR4|`writeFileSync` inline em `:1831-1850`|encapsulado em `persistSessionLearnedErrors` (append JSONL)|

## 11. Critério de conclusão por item

Cada melhoria deve ter: (1) teste focado quando muda comportamento (suíte faux-provider
para gates; `node --test` para `@pit/tui`); (2) `npm run check` verde; (3) para itens
por tier, um teste que prove que strong (Opus) mantém o caminho lean e weak recebe o
scaffolding extra; (4) opt-out via env var ou settings (padrão do harness); (5) rollback
claro se uma métrica de qualidade/latência piorar.

## 12. O que NÃO foi inspecionado

- Internals de `computeEditsDiff`/`edit-diff.ts` (tolerância fuzzy do match de edit).
- Camada provider/streaming `@pit/ai` (`completeSimple`/`stream.ts`) — só a assinatura.
- `agent-session.ts` na íntegra (~5,2 k linhas) — alvo dirigido por grep/leitura nas
  regiões relevantes.
- `models.generated.ts` (conteúdo do registry) — só schema e loader.
- Qualidade da sumarização de compaction; suíte de testes não foi executada
  (auditoria read-only).
