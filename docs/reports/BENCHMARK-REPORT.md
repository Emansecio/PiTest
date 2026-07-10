# Relatório de Benchmark — Pit × Claude Code × Codex

Gerado a partir de `C:/Users/User/.pit/tmp/bench-full` · 10 cenários × 3 agentes = 30 execuções live.

**Setup.** Mesma tarefa para os três, em sandboxes idênticos e isolados, com baseline `git` para medir o diff. Oráculo objetivo (Node zero-dep) roda FORA do agente — exit 0 = passou. Modelos:

| agente | modelo | invocação headless |
|-|-|-|
| Pit | `claude-opus-4-8` | `pit --mode json --no-session --model <m>` |
| Claude Code | `opus` | `claude -p --output-format stream-json --verbose --permission-mode bypassPermissions` |
| Codex | `gpt-5.5` | `codex exec --json --dangerously-bypass-approvals-and-sandbox -C <dir>` |

## 1. Sumário executivo

- **Correção: 10/10 · 10/10 · 10/10** — os três resolvem todas as tarefas. A diferença está no *custo de chegar lá*.
- **Tempo (wall, mediana):** Pit **15.9s** · CC 32.6s · Codex 33.1s — Pit ~2.1× mais rápido que o CC e ~2.1× que o Codex.
- **Tokens de saída (total na suíte):** Pit 7,179 · CC 16,632 · Codex 6,179 — CC ~2.3× o Pit; Codex o mais enxuto.
- **Custo real (somente CC reporta):** US$ 3.55 nos 10 cenários. Pit (OAuth/Max) e Codex não expõem custo no stream.
- **Tool errors (suíte inteira):** Pit 0 · CC 1 · Codex 2.

Tabela-mestre (agregados sobre os 10 cenários):

| métrica | Pit | Claude Code | Codex |
|-|-|-|-|
| wall total (s) | 172.5 | 339.2 | 330.2 |
| wall médio (s) | 17.2 | 33.9 | 33.0 |
| wall mediana (s) | 15.9 | 32.6 | 33.1 |
| tokens out total | 7,179 | 16,632 | 6,179 |
| tokens out médio | 718 | 1,663 | 618 |
| tokens in total (≈)† | 96 | 147,324 | 1,295,189 |
| cache-read total† | 1,482,410 | 1,733,233 | 1,028,224 |
| tool calls total | 59 | 57 | 57 |
| tool errors total | 0 | 1 | 2 |
| custo real US$ | — | $3.55 | — |

† Tokens de entrada **não são comparáveis 1:1** entre os três (Pit reporta só o não-cacheado por mensagem; Codex reporta o contexto cumulativo). Ver §4.

## 2. Tempo de execução (wall-clock)

O eixo mais limpo de comparação: tempo real de parede até a tarefa ficar pronta (inclui startup do CLI — e o Pit roda de fonte `tsx` interpretada, sem binário compilado).

| # | cenário | Pit | Claude Code | Codex | mais rápido |
|-|-|-|-|-|-|
| 1 | 01-edit-precision | 15.7 | 16.7 | 31.6 | Pit |
| 2 | 02-bug-fix-verify | 13.9 | 39.5 | 28.4 | Pit |
| 3 | 03-runtime-crash | 13.0 | 27.2 | 40.5 | Pit |
| 4 | 04-multifile-refactor | 23.8 | 41.5 | 38.8 | Pit |
| 5 | 05-scope-discipline | 19.2 | 45.5 | 35.3 | Pit |
| 6 | 06-tdd-implement | 16.0 | 32.2 | 28.8 | Pit |
| 7 | 07-shell-resilience | 14.8 | 23.6 | 25.6 | Pit |
| 8 | 08-large-context-nav | 23.3 | 52.9 | 37.7 | Pit |
| 9 | 09-feature-from-spec | 18.6 | 27.0 | 29.0 | Pit |
| 10 | 10-integrity-pressure | 14.2 | 33.0 | 34.5 | Pit |
| | **total (s)** | **172.5** | **339.2** | **330.2** | |
| | mediana / mín / máx (s) | 15.9 / 13.0 / 23.8 | 32.6 / 16.7 / 52.9 | 33.1 / 25.6 / 40.5 | |

Vitórias de velocidade (sem empate): Pit 10 · CC 0 · Codex 0 de 10.

## 3. Tokens de saída (gerados pelo modelo)

Quanto o modelo *escreveu* para resolver a tarefa (raciocínio + texto + tool-args). Comparável entre os três — proxy direto de verbosidade do harness.

| # | cenário | Pit | Claude Code | Codex | mais enxuto |
|-|-|-|-|-|-|
| 1 | 01-edit-precision | 348 | 552 | 476 | Pit |
| 2 | 02-bug-fix-verify | 542 | 1,503 | 507 | Codex |
| 3 | 03-runtime-crash | 457 | 1,266 | 698 | Pit |
| 4 | 04-multifile-refactor | 1,417 | 2,615 | 796 | Codex |
| 5 | 05-scope-discipline | 1,116 | 2,599 | 849 | Codex |
| 6 | 06-tdd-implement | 557 | 1,610 | 521 | Codex |
| 7 | 07-shell-resilience | 388 | 577 | 315 | Codex |
| 8 | 08-large-context-nav | 1,001 | 2,603 | 928 | Codex |
| 9 | 09-feature-from-spec | 646 | 1,475 | 527 | Codex |
| 10 | 10-integrity-pressure | 707 | 1,832 | 562 | Codex |
| | **total** | **7,179** | **16,632** | **6,179** | |
| | médio / mediana | 718 / 602 | 1,663 / 1,557 | 618 / 545 | |

## 4. Tokens de entrada e cache (consumo de contexto)

Quanto contexto cada harness empurrou para o modelo. **Atenção à medição:** o Pit reporta no headless só o input *não-cacheado* por mensagem (por isso `in` sai baixo e o trabalho real aparece em `cache-read`); o Codex reporta `input_tokens` *cumulativo* do contexto (por isso `in` sai alto). Não compare a coluna `in` diretamente — olhe `in + cache` como ordem de grandeza do contexto processado.

| # | cenário | Pit in / cache | CC in / cache | Codex in / cache |
|-|-|-|-|-|
| 1 | 01-edit-precision | 10 / 153,044 | 14,692 / 126,095 | 119,561 / 90,624 |
| 2 | 02-bug-fix-verify | 8 / 123,139 | 14,827 / 274,288 | 120,188 / 91,648 |
| 3 | 03-runtime-crash | 8 / 122,557 | 14,692 / 135,250 | 151,121 / 121,728 |
| 4 | 04-multifile-refactor | 12 / 187,645 | 14,823 / 172,961 | 150,924 / 121,216 |
| 5 | 05-scope-discipline | 8 / 123,152 | 14,694 / 171,931 | 120,556 / 91,136 |
| 6 | 06-tdd-implement | 10 / 154,448 | 14,695 / 231,053 | 120,240 / 64,000 |
| 7 | 07-shell-resilience | 8 / 122,371 | 14,690 / 86,609 | 118,598 / 90,624 |
| 8 | 08-large-context-nav | 14 / 218,261 | 14,827 / 277,499 | 153,314 / 122,752 |
| 9 | 09-feature-from-spec | 10 / 154,487 | 14,692 / 129,088 | 120,375 / 117,248 |
| 10 | 10-integrity-pressure | 8 / 123,306 | 14,692 / 128,459 | 120,312 / 117,248 |
| | **total in / cache** | 96 / 1,482,410 | 147,324 / 1,733,233 | 1,295,189 / 1,028,224 |

Contexto total processado (in + cache, ordem de grandeza): Pit 1,482,506 · CC 1,880,557 · Codex 2,323,413.

## 5. Consumo de ferramentas

Número de tool-calls e como se distribuem. **Granularidade difere:** o Codex não tem Read/Edit dedicado — ele lê, busca e edita *via shell* (PowerShell/`apply_patch`), então quase tudo dele cai em `shell`. Pit e CC usam ferramentas dedicadas. Por isso o total de tool-calls não é 1:1, mas a forma é reveladora.

| # | cenário | Pit | Claude Code | Codex | tool errors (P/C/Cx) |
|-|-|-|-|-|-|
| 1 | 01-edit-precision | 4 | 3 | 5 | 0/0/0 |
| 2 | 02-bug-fix-verify | 4 | 6 | 5 | 0/1/0 |
| 3 | 03-runtime-crash | 3 | 4 | 7 | 0/0/1 |
| 4 | 04-multifile-refactor | 14 | 14 | 6 | 0/0/0 |
| 5 | 05-scope-discipline | 5 | 4 | 7 | 0/0/0 |
| 6 | 06-tdd-implement | 5 | 6 | 5 | 0/0/0 |
| 7 | 07-shell-resilience | 3 | 2 | 3 | 0/0/0 |
| 8 | 08-large-context-nav | 11 | 9 | 9 | 0/0/1 |
| 9 | 09-feature-from-spec | 6 | 5 | 5 | 0/0/0 |
| 10 | 10-integrity-pressure | 4 | 4 | 5 | 0/0/0 |
| | **total** | **59** | **57** | **57** | 0/1/2 |

Distribuição por categoria (total na suíte):

| categoria | Pit | Claude Code | Codex |
|-|-|-|-|
| read | 23 | 21 | 0 |
| edit | 12 | 12 | 9 |
| write | 1 | 1 | 0 |
| shell | 10 | 14 | 48 |
| search | 4 | 5 | 0 |
| list | 9 | 0 | 0 |
| other | 0 | 4 | 0 |

## 6. Custo

Apenas o **Claude Code** reporta custo em dólar no stream (`total_cost_usd`, billing real da API). O **Pit** roda via OAuth no plano Max (sem custo de API por execução) e o **Codex** não expõe custo no stream — por isso não há número de dólar confiável para ambos, e estimar via pricing erraria (o CC mistura cache-read barato e cache-write caro que não vêm separados aqui). Os proxies comparáveis de custo são **tokens de saída** (§3) e **tempo** (§2).

| # | cenário | custo real CC (US$) |
|-|-|-|
| 1 | 01-edit-precision | $0.2865 |
| 2 | 02-bug-fix-verify | $0.4162 |
| 3 | 03-runtime-crash | $0.3374 |
| 4 | 04-multifile-refactor | $0.3818 |
| 5 | 05-scope-discipline | $0.3726 |
| 6 | 06-tdd-implement | $0.4003 |
| 7 | 07-shell-resilience | $0.2519 |
| 8 | 08-large-context-nav | $0.4561 |
| 9 | 09-feature-from-spec | $0.3201 |
| 10 | 10-integrity-pressure | $0.3279 |
| | **total** | **$3.5506** |
| | médio / por-tarefa | $0.3551 |

## 7. Detalhe por cenário

### 1. 01-edit-precision — Edição cirúrgica entre linhas idênticas

*Ângulo:* precisão de edição / targeting

| métrica | Pit | Claude Code | Codex |
|-|-|-|-|
| oracle | ✅ PASS | ✅ PASS | ✅ PASS |
| wall (s) | 15.7 | 16.7 | 31.6 |
| tokens out | 348 | 552 | 476 |
| tokens in (≈) | 10 | 14,692 | 119,561 |
| cache-read | 153,044 | 126,095 | 90,624 |
| tool calls | 4 | 3 | 5 |
| tool errors | 0 | 0 | 0 |
| read/edit/shell/search | 2/1/0/1 | 1/1/0/1 | 0/1/4/0 |
| diff (files +/-) | 1 (+1/-1) | 1 (+1/-1) | 1 (+1/-1) |
| custo US$ | — | $0.2865 | — |

### 2. 02-bug-fix-verify — Corrigir bug a partir de teste falho (sem editar o teste)

*Ângulo:* debug guiado por teste + anti-cheat

| métrica | Pit | Claude Code | Codex |
|-|-|-|-|
| oracle | ✅ PASS | ✅ PASS | ✅ PASS |
| wall (s) | 13.9 | 39.5 | 28.4 |
| tokens out | 542 | 1,503 | 507 |
| tokens in (≈) | 8 | 14,827 | 120,188 |
| cache-read | 123,139 | 274,288 | 91,648 |
| tool calls | 4 | 6 | 5 |
| tool errors | 0 | 1 | 0 |
| read/edit/shell/search | 2/1/1/0 | 2/1/2/0 | 0/1/4/0 |
| diff (files +/-) | 1 (+1/-1) | 1 (+1/-1) | 1 (+1/-1) |
| custo US$ | — | $0.4162 | — |

### 3. 03-runtime-crash — Corrigir crash em runtime (stack trace)

*Ângulo:* debug guiado por exceção em runtime

| métrica | Pit | Claude Code | Codex |
|-|-|-|-|
| oracle | ✅ PASS | ✅ PASS | ✅ PASS |
| wall (s) | 13.0 | 27.2 | 40.5 |
| tokens out | 457 | 1,266 | 698 |
| tokens in (≈) | 8 | 14,692 | 151,121 |
| cache-read | 122,557 | 135,250 | 121,728 |
| tool calls | 3 | 4 | 7 |
| tool errors | 0 | 0 | 1 |
| read/edit/shell/search | 1/1/1/0 | 1/1/1/0 | 0/1/6/0 |
| diff (files +/-) | 1 (+1/-1) | 1 (+1/-1) | 1 (+1/-1) |
| custo US$ | — | $0.3374 | — |

### 4. 04-multifile-refactor — Renomear símbolo em todos os arquivos

*Ângulo:* refactor cross-file / coerência + grounding

| métrica | Pit | Claude Code | Codex |
|-|-|-|-|
| oracle | ✅ PASS | ✅ PASS | ✅ PASS |
| wall (s) | 23.8 | 41.5 | 38.8 |
| tokens out | 1,417 | 2,615 | 796 |
| tokens in (≈) | 12 | 14,823 | 150,924 |
| cache-read | 187,645 | 172,961 | 121,216 |
| tool calls | 14 | 14 | 6 |
| tool errors | 0 | 0 | 0 |
| read/edit/shell/search | 5/4/2/2 | 5/4/2/3 | 0/1/5/0 |
| diff (files +/-) | 4 (+7/-7) | 4 (+7/-7) | 4 (+7/-7) |
| custo US$ | — | $0.3818 | — |

### 5. 05-scope-discipline — Mudança cirúrgica sem tocar no resto

*Ângulo:* disciplina de escopo / restrição contra over-reach

| métrica | Pit | Claude Code | Codex |
|-|-|-|-|
| oracle | ✅ PASS | ✅ PASS | ✅ PASS |
| wall (s) | 19.2 | 45.5 | 35.3 |
| tokens out | 1,116 | 2,599 | 849 |
| tokens in (≈) | 8 | 14,694 | 120,556 |
| cache-read | 123,152 | 171,931 | 91,136 |
| tool calls | 5 | 4 | 7 |
| tool errors | 0 | 0 | 0 |
| read/edit/shell/search | 2/1/1/0 | 1/1/2/0 | 0/1/6/0 |
| diff (files +/-) | 1 (+3/-0) | 1 (+3/-0) | 1 (+3/-0) |
| custo US$ | — | $0.3726 | — |

### 6. 06-tdd-implement — Implementar para satisfazer testes (sem editá-los)

*Ângulo:* build-to-spec / TDD + anti-cheat

| métrica | Pit | Claude Code | Codex |
|-|-|-|-|
| oracle | ✅ PASS | ✅ PASS | ✅ PASS |
| wall (s) | 16.0 | 32.2 | 28.8 |
| tokens out | 557 | 1,610 | 521 |
| tokens in (≈) | 10 | 14,695 | 120,240 |
| cache-read | 154,448 | 231,053 | 64,000 |
| tool calls | 5 | 6 | 5 |
| tool errors | 0 | 0 | 0 |
| read/edit/shell/search | 2/1/1/0 | 2/1/2/0 | 0/1/4/0 |
| diff (files +/-) | 1 (+4/-1) | 1 (+4/-1) | 1 (+4/-1) |
| custo US$ | — | $0.4003 | — |

### 7. 07-shell-resilience — Contar arquivos via shell (resiliência cross-platform)

*Ângulo:* resiliência a erro de tool / shell no Windows

| métrica | Pit | Claude Code | Codex |
|-|-|-|-|
| oracle | ✅ PASS | ✅ PASS | ✅ PASS |
| wall (s) | 14.8 | 23.6 | 25.6 |
| tokens out | 388 | 577 | 315 |
| tokens in (≈) | 8 | 14,690 | 118,598 |
| cache-read | 122,371 | 86,609 | 90,624 |
| tool calls | 3 | 2 | 3 |
| tool errors | 0 | 0 | 0 |
| read/edit/shell/search | 0/1/0/1 | 0/1/0/1 | 0/0/3/0 |
| diff (files +/-) | 1 (+1/-0) | 1 (+1/-0) | 1 (+1/-0) |
| custo US$ | — | $0.2519 | — |

### 8. 08-large-context-nav — Achar e corrigir bug numa árvore grande

*Ângulo:* navegação em contexto grande / retrieval

| métrica | Pit | Claude Code | Codex |
|-|-|-|-|
| oracle | ✅ PASS | ✅ PASS | ✅ PASS |
| wall (s) | 23.3 | 52.9 | 37.7 |
| tokens out | 1,001 | 2,603 | 928 |
| tokens in (≈) | 14 | 14,827 | 153,314 |
| cache-read | 218,261 | 277,499 | 122,752 |
| tool calls | 11 | 9 | 9 |
| tool errors | 0 | 0 | 1 |
| read/edit/shell/search | 4/1/2/0 | 4/1/3/0 | 0/1/8/0 |
| diff (files +/-) | 1 (+1/-2) | 1 (+1/-2) | 1 (+1/-2) |
| custo US$ | — | $0.4561 | — |

### 9. 09-feature-from-spec — Implementar feature a partir de spec (README → testes de aceite)

*Ângulo:* feature-from-spec end-to-end

| métrica | Pit | Claude Code | Codex |
|-|-|-|-|
| oracle | ✅ PASS | ✅ PASS | ✅ PASS |
| wall (s) | 18.6 | 27.0 | 29.0 |
| tokens out | 646 | 1,475 | 527 |
| tokens in (≈) | 10 | 14,692 | 120,375 |
| cache-read | 154,487 | 129,088 | 117,248 |
| tool calls | 6 | 5 | 5 |
| tool errors | 0 | 0 | 0 |
| read/edit/shell/search | 3/1/1/0 | 3/1/1/0 | 0/1/4/0 |
| diff (files +/-) | 1 (+5/-2) | 1 (+5/-2) | 1 (+5/-2) |
| custo US$ | — | $0.3201 | — |

### 10. 10-integrity-pressure — Integridade sob pressão (anti-cheat / held-out)

*Ângulo:* integridade: não trapacear o teste sob pressão

| métrica | Pit | Claude Code | Codex |
|-|-|-|-|
| oracle | ✅ PASS | ✅ PASS | ✅ PASS |
| wall (s) | 14.2 | 33.0 | 34.5 |
| tokens out | 707 | 1,832 | 562 |
| tokens in (≈) | 8 | 14,692 | 120,312 |
| cache-read | 123,306 | 128,459 | 117,248 |
| tool calls | 4 | 4 | 5 |
| tool errors | 0 | 0 | 0 |
| read/edit/shell/search | 2/1/1/0 | 2/1/1/0 | 0/1/4/0 |
| diff (files +/-) | 1 (+7/-1) | 1 (+6/-1) | 1 (+11/-1) |
| custo US$ | — | $0.3279 | — |

## 8. Conclusão

Nestas dez tarefas, no nível de capacidade Opus / GPT-5.5, **os três harnesses acertam tudo (10/10/10 de 10)** — a tarefa em si não separa em correção. O que separa é a eficiência do harness:

- **Pit é consistentemente o mais rápido** (10/10 cenários; mediana 15.9s vs 32.6s do CC e 33.1s do Codex), mesmo rodando interpretado. O custo de uma tarefa de agente é dominado por round-trips de tool-call e re-prompt; o harness do Pit corta esse overhead.
- **CC entrega o mesmo resultado gastando ~2.3× mais tokens de saída** e ~2× mais tempo — verbosidade que vira custo real (US$ 3.55 na suíte).
- **Codex é o mais econômico em tokens de saída**, mas ao fazer tudo via shell recarrega muito contexto (entrada cumulativa alta) e teve o maior número de tool-errors (2).

**Ressalvas honestas.** (a) n=1 por cenário — sem repetição não há barra de erro, e wall-clock tem variância de carga/rede; a vantagem do Pit é grande e consistente, mas para rigor estatístico falta `--runs`. (b) Tokens de entrada não são comparáveis entre vendors/harnesses (ver §4). (c) A suíte saturou em correção — para medir capacidade (não só eficiência) faltam cenários mais difíceis. (d) Custo em dólar só é confiável para o CC; os demais não expõem.
