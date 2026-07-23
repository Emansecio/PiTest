# Oportunidades de melhoria no Pit — evidências do OpenBench (2026-07-22)

Documento-irmão de [OPENBENCH-CLAUDE-CODE.md](OPENBENCH-CLAUDE-CODE.md) (metodologia e números completos lá).
Aqui: **o que os testes revelaram de melhorável no Pit, por quê, com que evidência, e que direção de correção sugiro.**

Contexto em uma linha: 8 tasks core do openbench, `claude-opus-4-8` pinado nos dois harnesses, checker objetivo externo, timeout igual de 900s. Resultado: empate em qualidade nas 7 tasks pequenas/médias (7/7 ambos), pit ~7× mais econômico em tokens frescos e com menos turnos — mas **derrota na única task grande (`webcore`): claude fechou em 519s, pit foi morto aos 900s ainda no meio da implementação**.

Todas as evidências vêm do transcript integral da célula perdida:
`C:\Users\User\openbench\results\transcripts\results\pit_webcore_claude-opus-4-8_trial1.txt` (483 KB, stream JSONL do `--mode json`).

---

## Anatomia da derrota no webcore (linha do tempo reconstruída)

| Fase | Janela | O que aconteceu |
|---|---|---|
| Exploração | ~0–136s | **Todos** os 11 turnos completos e as 24 execuções de tool: 20 reads, 8 finds, 2 ls, 6 bash, 10 todos, **2 writes**. Cada arquivo do projeto lido 2×; `converters.py` lido 4×. Contexto estável em ~50k (compaction segurando). Output acumulado: 9.108 tokens. |
| Turno silencioso | ~136–900s | Após a 4ª leitura de `converters.py`, um `turn_start` abre o turno 12 e **nenhum evento é emitido por ~12,7 minutos** até o runner matar o processo. Sem `turn_end`, sem tool call, sem usage final. |

Comparativo do mesmo período no claude: 34 turnos, 37.853 tokens de output (código escrito), sucesso no checker aos 519s.

Um falso positivo colateral: a heurística de failure-class do openbench rotulou a célula como `rate_limited` só porque ela morreu sem evento de usage — o transcript mostra trabalho ativo. Isso vira a oportunidade nº 2 (observabilidade).

---

## Oportunidade 1 — Churn de releitura: prune/supersede descarta o que o plano ainda precisa

**Evidência.** Em 11 turnos: `webcore/converters.py` lido 4×; `app.py`, `routing.py`, `request.py`, `response.py`, `middleware.py`, `testclient.py`, `__init__.py` e `README.md` lidos 2× cada. O contexto (cacheRead por turno: 25k→49k) ficou praticamente plano — ou seja, as leituras antigas **saíram** do contexto na mesma velocidade em que novas entravam.

**Por que isso é um problema.** A instrução do webcore avisa explicitamente: "converters, routing precedence, mounting e method handling **interagem**; implemente coerentemente, não em patches isolados". O modelo precisava de vários arquivos simultaneamente em contexto para escrever a solução conectada. A compaction (prune/supersede) descartou corpos de arquivo que o plano ainda referenciava; o modelo pagou **turno + latência de API + tool call** para reler cada um. Numa task com orçamento de tempo, esse imposto se compõe: ~30 dos 62 tool calls foram exploração/releitura, e só 2 foram writes.

**Por que é irônico (e por isso importante).** É exatamente a tese de context economy do Pit ([Taxonomia.md §3](Taxonomia.md#3-context-economy)) funcionando *forte demais*: a economia de tokens frescos (~7× melhor que o Claude Code nas tasks pareadas!) vem dessa poda — mas o custo aparece em turnos e wall-time quando a task exige contexto amplo simultâneo. É um trade-off mal calibrado no extremo superior de tamanho de task, não um defeito da ideia.

**Direções de correção.**
- *Pin por referência ativa:* antes de podar/superseder um read, verificar se o arquivo é citado no plano/todo ativo ou em edits pendentes; se sim, manter (ou manter um resumo estruturado + hashline em vez do corpo inteiro). Pontos de código: `packages/coding-agent/src/core/compaction/compaction.ts`, `file-digests.ts` (a infraestrutura de digest **já existe** — é questão de usá-la como critério de retenção).
- *Read barato de "inalterado":* o read-guard (`packages/coding-agent/src/core/built-ins/read-guard-extension.ts`) hoje protege edit-sem-read; ele poderia também interceptar re-read de arquivo com mtime/hash inalterado e responder curto ("inalterado desde o turno N; digest X"), poupando o corpo repetido — o modelo decide se quer o conteúdo integral mesmo assim.
- *Métrica de regressão:* contar re-reads de arquivos inalterados por sessão no telemetry; o bench interno (`bench/`, cenário 08 large-context-nav) pode ganhar um oráculo de "re-reads ≤ N".

**Impacto esperado.** No webcore, ~10 das 20 leituras eram releituras de arquivo inalterado. Eliminá-las devolveria ~half dos turnos de exploração para implementação — plausivelmente a diferença entre morrer aos 900s e fechar dentro do orçamento.

---

## Oportunidade 2 — Turno silencioso de 12,7 min: nenhum guard reage e o stream não explica

**Evidência.** O turno 12 ficou ~764s sem emitir nenhum evento no `--mode json` até ser morto de fora. Dentro da janela ativa também houve um gap de 83,9s entre eventos. Não dá para distinguir, pelo stream, três causas radicalmente diferentes: (a) thinking/geração longa legítima, (b) retry de 429 com backoff (plausível: a célula rodou logo após 15 células consumirem a mesma assinatura opus), (c) travamento real.

**Por que isso é um problema — duas camadas.**
1. *Prevenção:* o Pit tem uma pilha de guards orgulhosa dela mesma ([prevention-layers](docs/agents/prevention-layers.md)): doom-loop (`core/doom-loop-cycle.ts`), grounding, verificação, learned-error (que aliás disparou 1× nesta run — funcionou). Mas **nenhum guard cobre o eixo tempo-de-rodada**. O doom-loop detecta ciclos de ações repetidas; um turno único que nunca termina passa ileso. Em modo interativo o humano nota e interrompe; em `-p` headless (CI, benchmarks, orquestração) ninguém está olhando — justamente onde o Pit quer ser forte (fusion, coordinator, subagents).
2. *Observabilidade:* o `--mode json` não emite eventos de retry/backoff/heartbeat. Consequência concreta já observada: o classificador do openbench rotulou a célula errada (`rate_limited` sem evidência), e eu mesmo precisei de arqueologia de timestamps para reconstruir o que houve. Qualquer ferramenta externa que consuma o stream tem o mesmo problema.

**Direções de correção.**
- *Watchdog de rodada:* limite configurável de wall-clock por rodada de modelo (ex.: 5 min default em `-p`); ao estourar → cancelar o stream e re-perguntar com instrução de resposta mais curta, ou checkpointar e dividir. Encaixa como mais uma prevention layer, ao lado do doom-loop.
- *Eventos de infra no stream:* `{"type":"retry","cause":"rate_limit","attempt":n,"backoff_ms":x}` e um heartbeat periódico durante geração longa (`{"type":"generation_progress","output_tokens_so_far":n}` — o streaming da API já fornece os deltas; é só resumi-los em vez de descartá-los no modo json).
- *Timeout interno < timeout externo:* em modo headless, aceitar um budget de tempo (`--max-wall 850` quando o orquestrador mata aos 900) para o agente **fechar com estado parcial coerente** em vez de morrer no meio — um commit parcial verificável vale mais que um workspace pela metade.

**Impacto esperado.** Mesmo sem resolver a causa-raiz do turno lento, o watchdog converte "morte silenciosa aos 900s" em "resposta degradada aos ~300s + retomada" — e os eventos de infra tornam qualquer diagnóstico futuro (inclusive rate-limit real) trivial em vez de forense.

---

## Oportunidade 3 — Todo-first triage cobra caro em task grande e conectada

**Evidência.** 10 dos 62 tool calls (16%) foram operações de todo, concentradas nos primeiros minutos — antes de existirem writes de verdade (2 no total). Contraste interno: no `taskflow` (task média), o todo-first foi neutro-positivo — 27 turnos idênticos ao claude, wall empatado (109,9s vs 107,4s). Contraste externo: no mesmo período em que o pit produziu 9,1k tokens de output no webcore, o claude produziu 37,8k.

**Por que isso é um problema.** O custo do todo não é só o tool call — é que cada atualização é um turno de modelo (latência de request + thinking). Numa spec grande e *conectada* (que o próprio enunciado pede para não fatiar), triagem fina vira overhead puro: o plano ideal tinha 4-5 itens grossos, não uma máquina de estados atualizada a cada passo. A [Taxonomia §7](Taxonomia.md#7-task-cognition) já enxerga isso ("Todo-first triage, Plan DAG **com verify**"); o que falta é calibração por tamanho.

**Direções de correção.**
- *Granularidade proporcional à spec:* heurística no `core/todo/todo-manager.ts` — spec longa/única feature conectada → todos grossos (fases), não passos; spec com N sub-tarefas independentes → todo por sub-tarefa.
- *Batch de transições:* permitir marcar concluído + abrir próximo na mesma mensagem que contém o próximo tool call real (piggyback), em vez de turno dedicado de bookkeeping.
- *Orçamento:* o Pit já tem Goals com token budgets; aplicar um budget análogo ao overhead de todo (ex.: ≤8% dos tool calls) e registrar no telemetry.

**Impacto esperado.** ~8 turnos de bookkeeping economizados no perfil webcore ≈ 1-2 min de wall e, mais importante, o commit à implementação acontecendo minutos antes.

---

## Oportunidade 4 — DX do shim Windows (menor, mas atrito real de automação)

**Evidência.** Durante o setup do benchmark: (a) `bin/pit.ps1` escreve o aviso de startup ("src mais novo que o bundle — rodando do src via tsx") em **stderr**, e o PowerShell 5.1 converte qualquer stderr de comando nativo em `NativeCommandError` quando há redirecionamento — `pit --list-models 2>$null` literalmente retorna exit 1 com stack de erro por causa de um *aviso*; (b) o fallback para tsx penaliza o startup de toda invocação silenciosamente até alguém rodar `npm run build` (precisei rebuildar para o benchmark ser justo no wall-time); (c) o adapter do openbench teve que invocar `node bin/pit.mjs` diretamente porque argumentos multi-linha via `.cmd` são corrompidos pelo quoting do cmd.exe.

**Por que isso é um problema.** Cada um é pequeno, mas todos atingem o mesmo público: **automação headless no Windows** — benchmarks, CI, orquestradores, outros agentes chamando o pit. É o público que não tem um humano para interpretar o ruído.

**Direções de correção.** Aviso de startup em stdout (ou suprimido em `-p`/`--mode json`); auto-rebuild ou aviso persistente com contagem regressiva quando rodando de src; documentar `node bin/pit.mjs` como entrypoint canônico para automação Windows.

---

## O que o benchmark confirmou como força — não mexer

| Força | Evidência |
|---|---|
| Economia de tokens frescos | 13,3k vs 96,4k do claude nas 7 tasks pareadas (~7×), com output idêntico (13,2k vs 13,6k) — o system prompt/toolset enxuto paga |
| Menos turnos para o mesmo resultado | 9,0 vs 13,6 em média | 
| Wall-time | levemente melhor (261s vs 295s no total pareado) |
| Learned-error guard | disparou 1× no webcore e aplicou hint corretamente (`tool_error_hint_applied`) |
| Compaction manteve contexto plano | cacheRead estável ~25–49k a run inteira (o problema da Op. 1 é *o que* poda, não *se* poda) |

As oportunidades 1–3 são o mesmo fenômeno visto de ângulos diferentes: **o Pit é otimizado para eficiência por turno, e o perfil de falha aparece quando a task exige profundidade sustentada** — contexto amplo simultâneo, geração longa, commit precoce. É o canto do espaço de tasks onde o harness "gastador" do Claude Code compra vantagem com os tokens que o Pit economiza.

## Caveats de honestidade estatística

- **n=1 trial por célula.** Wilson 95% sobrepostos (`[0.68,1.00]` vs `[0.65,1.00]`); nada aqui separa os harnesses estatisticamente em *qualidade*. As conclusões de token/turno são robustas (diferenças de ordem de magnitude); a do webcore é um caso único bem documentado, não uma taxa.
- **Throttling de assinatura como confounder.** A célula webcore do pit rodou por último, após 15 células na mesma conta. Rate limit pode ter contribuído para o turno silencioso (não dá para provar pelo stream — ver Op. 2). Uma célula exploratória com teto de 30 min está rodando; resultado será anexado ao comparativo.
- **Plano de validação:** re-rodar só o webcore 3× por harness em horário frio, alternando ordem; depois de qualquer fix das Ops. 1–3, re-rodar a suíte core com `--trials 3` e comparar `results.jsonl` antes/depois (comandos de reprodução no doc-irmão).

---
*Gerado a partir da run openbench de 2026-07-22 (Windows 11 local, opus-4-8 medium nos dois lados). Nenhuma das sugestões foi implementada — este documento é análise, não patch.*
