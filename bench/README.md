# bench — Pit × Claude Code × Codex

Suíte de **dez benchmarks** que rodam a MESMA tarefa nos três harnesses, em
sandboxes idênticos e isolados, com um **oráculo objetivo** (script Node
zero-dependência rodado FORA do agente). Fixando modelos de capacidade
comparável, a diferença observada é do **harness** — system prompt, toolset,
tool-rewrite, grounding, gate de verificação, compaction — não da LLM.

## Por que dez ângulos

Um harness de coding-agent é bom ou ruim em coisas diferentes. Cada cenário
isola um eixo:

| # | cenário | ângulo medido |
|-|-|-|
| 01 | edit-precision | precisão de edição: acertar UMA linha entre várias idênticas, sem reformatar |
| 02 | bug-fix-verify | debug guiado por teste falho + não trapacear (não editar o teste) |
| 03 | runtime-crash | debug guiado por exceção em runtime (stack trace) |
| 04 | multifile-refactor | renomear símbolo em todos os arquivos com coerência (grounding/grep) |
| 05 | scope-discipline | disciplina de escopo: mexer SÓ no alvo, ignorar a bagunça vizinha |
| 06 | tdd-implement | implementar para satisfazer testes sem editá-los |
| 07 | shell-resilience | contar arquivos via shell — resiliência cross-platform (Windows) |
| 08 | large-context-nav | achar e corrigir 1 bug numa árvore de ~19 arquivos (retrieval) |
| 09 | feature-from-spec | implementar feature a partir de spec em README → testes de aceite |
| 10 | integrity-pressure | sob pressão de "passe o teste de qualquer jeito", não fazer hardcode |

O oráculo é a fonte de verdade: o agente **não** se auto-avalia. Cenários de
integridade (02, 06, 09, 10) usam **casos held-out** que o agente nunca viu, mais
verificação de que o arquivo de teste ficou **byte-idêntico** — isso pega
hardcode, overfit e adulteração de teste. Cenário 05 verifica que nenhum arquivo
fora de escopo mudou.

## Como rodar

Pré-requisitos no PATH: `bin/pit.cmd` (Pit local), `claude` (Claude Code),
`codex` (Codex CLI). Os que faltarem são pulados.

```sh
# tudo (10 cenários × 3 agentes) → SCORECARD.md
npx tsx bench/run-all.mts --keep --out C:/tmp/bench-full

# só alguns cenários
npx tsx bench/run-all.mts --only 02,08,10

# só alguns agentes
npx tsx bench/run-all.mts --agents pit,cc

# um cenário isolado, com relatório detalhado
npx tsx bench/runner.mts 08-large-context-nav --keep

# valida a mecânica (sandbox/launchers) sem chamar a LLM
npx tsx bench/run-all.mts --dry
```

Flags: `--pit-model`, `--cc-model`, `--codex-model`, `--thinking <lvl>` (Pit),
`--timeout <seg>`, `--out <dir>`, `--only a,b`, `--agents`, `--keep`, `--dry`.

Defaults: pit=`claude-opus-4-8`, cc=`opus`, codex=`gpt-5.5`.

## Métricas

Comparáveis entre os três: **oracle pass** (passou a tarefa?), **wall**,
**turnos**, **tool calls** (e por categoria normalizada read/edit/shell/search),
**tool errors**, **tokens out**, **tamanho do diff**. O SCORECARD também marca,
por cenário, o **vencedor de eficiência** entre quem PASSOU (menos turnos →
menos tools → menos tokens; ser barato falhando não conta).

Só do Pit, do stream de eventos: **rewrites** (reescrita preventiva de
tool-call), **rejects** (call inválida bloqueada), **error-hints**, **gate de
verificação** (typecheck/teste antes de declarar pronto) e **auto-retries**.
CC e Codex não expõem esses sinais.

### Cuidados de leitura (tokens de entrada NÃO são 1:1)

- **Pit** reporta no headless só o input **não-cacheado** por mensagem → o
  número de "tokens in" sai artificialmente baixo. Não comparar diretamente.
- **Codex** reporta `input_tokens` **cumulativo** do contexto (inclui cache e
  tokens de raciocínio do modelo) → sai artificialmente alto.
- **Claude Code** reporta input por turno somado.

Por isso o eixo de tokens confiável é **tokens out**. Os eixos mais limpos de
harness são **oracle pass**, **turnos**, **tool calls**, **tool errors** e
**diff**.

## Arquitetura

```
bench/
  lib.mts        tipos, sandbox, launchers dos 3 agentes, git-diff, oráculo, parsers
  runner.mts     roda UM cenário em N agentes → REPORT.md + result.json
  run-all.mts    roda todos → SCORECARD.md + scorecard.json
  scenarios/
    _helpers.mjs       helpers dos oráculos (importSandbox, runNode, unchanged…)
    NN-<id>/
      meta.json        { id, title, angle, timeoutSec }
      prompt.txt       a tarefa dada ao agente
      seed/            estado inicial do repo (só isto o agente vê)
      oracle.mjs       checagem objetiva — exit 0 = passou
```

Invocação headless de cada agente:

- **Pit**: `pit --mode json --no-session --model <m>` (prompt via stdin; modo
  `auto` executa edits/bash sem prompt).
- **Claude Code**: `claude -p --output-format stream-json --verbose --model <m>
  --permission-mode bypassPermissions`.
- **Codex**: `codex exec --json --skip-git-repo-check
  --dangerously-bypass-approvals-and-sandbox -C <dir> -m <m>`.

Cada agente roda num sandbox próprio com baseline `git` para medir o diff. O
oráculo roda com `cwd` = sandbox e `BENCH_PRISTINE` = cópia limpa do seed (para
diferenciar arquivos que NÃO podiam mudar).
