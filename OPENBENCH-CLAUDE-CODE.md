# OpenBench — Pit × Claude Code (harness vs harness, mesmo modelo)

**Data:** 2026-07-22 · **Máquina:** Windows 11 local · **Framework:** [minghinmatthewlam/openbench](https://github.com/minghinmatthewlam/openbench) (clone em `C:\Users\User\openbench`)

Pergunta que o benchmark responde: **com o mesmo modelo pinado, quanto o harness em volta importa?**
Cada task tem um `checker.sh` objetivo (exit 0 = sucesso) rodado FORA do agente; o runner mede sucesso, wall-time, tokens e turns por célula (task × harness).

## Configuração

| | claude (Claude Code) | pit (este repo) |
|---|---|---|
| Versão | 2.1.206 (`claude.exe` nativo) | 0.75.4 (`node bin/pit.mjs`, bundle rebuildado) |
| Modelo | `claude-opus-4-8` @ effort medium | `claude-opus-4-8` @ thinking medium |
| Auth | OAuth assinatura (`.credentials.json` copiado p/ config dir isolado) | OAuth assinatura (`~/.pit/agent/auth.json` copiado p/ dir isolado) |
| Isolação | `CLAUDE_CONFIG_DIR` + HOME/USERPROFILE temp; `--dangerously-skip-permissions --disallowedTools Agent Task --no-session-persistence` | `PIT_CODING_AGENT_DIR` temp (extensões pessoais não carregam; guards/factory defaults ativos); `-p --no-session --mode json` |
| Timeout | 900 s/célula | 900 s/célula |

Tasks: as 8 **core** do openbench (validadas no Windows com polaridade correta: checker falha no workspace limpo, passa na solução). Checkers via Git Bash. 1 trial por célula.

Adapters: `openbench\obench\adapters\pit.py` (novo, modelado no do `pi`) e `claude.py` (patch local: resolução de exe no Windows + rota OAuth de assinatura — o upstream é API-key-only).

## Resultados por task

| Task | claude | wall | turns | fresh tok | pit | wall | turns | fresh tok |
|---|---|---|---|---|---|---|---|---|
| add-feature | ✅ | 58,8s | 12 | 14.883 | ✅ | 37,4s | 8 | 1.768 |
| build-a-cli | ✅ | 15,2s | 3 | 12.017 | ✅ | 15,3s | 4 | 613 |
| fix-failing-test | ✅ | 14,8s | 5 | 11.489 | ✅ | 14,1s | 4 | 561 |
| make-ci-green | ✅ | 50,3s | 13 | 13.671 | ✅ | 42,5s | 8 | 2.599 |
| make-it-run | ✅ | 21,5s | 7 | 13.030 | ✅ | 19,9s | 5 | 783 |
| misleading-error | ✅ | 26,9s | 8 | 13.355 | ✅ | 22,2s | 7 | 975 |
| taskflow | ✅ | 107,4s | 27 | 17.995 | ✅ | 109,9s | 27 | 5.973 |
| webcore | ✅ | 519,0s | 34 | 53.418 | ❌ timeout 900s | — | — | — |
| **Total** | **8/8** | | | | **7/8** | | | |

*fresh tok* = input não-cacheado + output (definição TOKEN_PARITY do openbench; cache reads excluídos).

## Agregados (7 tasks pareadas, excluindo webcore)

| Métrica | claude | pit | Δ |
|---|---|---|---|
| Sucesso no checker | 7/7 (100%) | 7/7 (100%) | empate |
| Wall-time total (média) | 294,9s (42,1s) | 261,3s (37,3s) | pit ~11% mais rápido |
| Tokens de output | 13.593 | 13.152 | empate |
| Tokens frescos | 96.440 | 13.272 | **pit ~7× mais econômico** |
| Cache reads | 2,75M | 2,11M | claude lê ~30% mais contexto |

## Leitura honesta

- **Qualidade:** empate nas 7 tasks pequenas/médias. Na única task grande (webcore), o claude fechou em 519s e o pit foi morto no teto de 900s ainda trabalhando (transcript de 483 KB, escrevendo código ativamente — não era rate-limit; a heurística de failure-class do openbench marcou `rate_limited` por falso positivo, célula morta sem evento final de usage). **No orçamento igual: claude 8/8 vs pit 7/8.**
- **Velocidade:** praticamente empatados nas tasks pareadas.
- **Eficiência de tokens:** a diferença real e grande. Output quase idêntico → a distância é quase toda **input fresco**: system prompt + definições de tool do Claude Code são muito maiores e contam como input não-cacheado por célula nova. Em assinatura é invisível; em API pay-per-token é custo direto. O claude também usa mais turns (13,6 vs 9,0 em média) — harness mais "falante" para o mesmo resultado nas tasks fáceis.
- **Estatística:** n=1 trial por célula; Wilson 95% `[0.68, 1.00]` (claude) vs `[0.65, 1.00]` (pit) — os intervalos se sobrepõem quase por inteiro; para separação estatística seria preciso `--trials 3+`.
- **Pendente:** re-run exploratório de `pit × webcore` com teto de 30 min (em `results\exploratory.jsonl`, fora do comparativo pareado) para saber se o pit resolve a task com mais tempo. <!-- TODO: atualizar quando fechar -->

## Reprodução

```powershell
$env:PATH = "C:\Program Files\Git\bin;" + $env:PATH   # checkers precisam do Git Bash, não do bash do WSL
cd C:\Users\User\openbench
obench validate                                        # polaridade dos checkers
obench run --task add-feature,build-a-cli,fix-failing-test,make-ci-green,make-it-run,misleading-error,taskflow,webcore `
           --harness claude,pit --model claude-opus-4-8 --allow-version-drift --timeout 900
obench report
```

Artefatos locais: `C:\Users\User\openbench\results\results.jsonl` (linhas por célula), `results\transcripts\` (transcript integral por célula, LOCAL-ONLY — revisar antes de compartilhar).

## Relação com o `bench/` deste repo

O `bench/` do Pit (12 cenários × 5 harnesses, oráculo Node próprio) mede eixos específicos (precisão de edição, integridade, escopo). O openbench é um comparativo externo/independente com tasks de terceiros e contabilidade de token padronizada — os dois se complementam; os resultados de eficiência de token aqui são consistentes com a tese de context economy do Pit ([Taxonomia.md](Taxonomia.md#3-context-economy)).
