# bench — Pit × Claude Code × Codex × Droid × opencode

Suíte de **doze benchmarks** que rodam a MESMA tarefa nos cinco harnesses, em
sandboxes idênticos e isolados, com um **oráculo objetivo** (script Node
zero-dependência rodado FORA do agente). Fixando modelos de capacidade
comparável, a diferença observada é do **harness** — system prompt, toolset,
tool-rewrite, grounding, gate de verificação, compaction — não da LLM.

## Por que doze ângulos

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
| 11 | async-correctness | corrigir bug de concorrência (forEach async não-aguardado) preservando ordem |
| 12 | perf-preserve | otimizar O(n²)→O(n) sob **perf-gate objetivo** (timeout) sem mudar comportamento |

O oráculo é a fonte de verdade: o agente **não** se auto-avalia. Cenários de
integridade (02, 06, 09, 10) usam **casos held-out** que o agente nunca viu, mais
verificação de que o arquivo de teste ficou **byte-idêntico** — isso pega
hardcode, overfit e adulteração de teste. Cenário 05 verifica que nenhum arquivo
fora de escopo mudou.

## Como rodar

Pré-requisitos no PATH: `bin/pit.cmd` (Pit local), `claude` (Claude Code),
`codex` (Codex CLI), `droid` (Factory) e `opencode`. Os que faltarem são pulados.

```sh
# tudo (10 cenários × 3 agentes) → SCORECARD.md
npx tsx bench/run-all.mts --keep --out C:/tmp/bench-full

# só alguns cenários
npx tsx bench/run-all.mts --only 02,08,10

# só alguns agentes (de 5: pit, cc, codex, droid, opencode)
npx tsx bench/run-all.mts --agents pit,cc,codex,droid,opencode

# um cenário isolado, com relatório detalhado
npx tsx bench/runner.mts 08-large-context-nav --keep

# valida a mecânica (sandbox/launchers) sem chamar a LLM
npx tsx bench/run-all.mts --dry
```

Flags: `--pit-model`, `--cc-model`, `--codex-model`, `--droid-model`,
`--opencode-model`, `--thinking <lvl>` (Pit), `--timeout <seg>`, `--out <dir>`,
`--only a,b`, `--agents`, `--keep`, `--dry`.

Defaults: pit=`claude-opus-4-8`, cc=`opus`, codex=`gpt-5.5`,
droid=`claude-opus-4-8`, opencode=`anthropic/claude-opus-4-8`.

### Notas por agente (droid e opencode)

- **Droid** (`droid exec -o json --skip-permissions-unsafe`): o `-o json` só emite
  o objeto `result` final (turnos + tokens), **sem eventos por-tool** → tool calls
  conta 0 (limite de medição). Droid roteia o Claude por um CLIProxyAPI embutido;
  se outro proxy (ex.: CCS) já ocupa a porta `:8317`, o do droid sobe com "0 Claude
  API keys" e retorna `Exec failed`. Libere `:8317` para o droid antes de rodar.
- **opencode** (`opencode run --format json --dangerously-skip-permissions`): o
  `opus-4-8` foi adicionado como **custom model** em
  `~/.config/opencode/opencode.json` (`provider.anthropic.models.claude-opus-4-8`)
  e roteia pela OAuth anthropic do opencode. Um erro `400 "out of extra usage"`
  significa **cota Max esgotada** (overage desabilitado no org), não falha de
  config — roda quando a janela de uso liberar. opencode reporta **custo real** por
  step no stream.

## Métricas

Comparáveis entre os cinco: **oracle pass** (passou a tarefa?), **wall**,
**turnos**, **tool calls** (e por categoria normalizada read/edit/shell/search),
**tool errors**, **tokens out**, **tamanho do diff**. O SCORECARD também marca,
por cenário, o **vencedor de eficiência** entre quem PASSOU (menos turnos →
menos tools → menos tokens; ser barato falhando não conta).

Quatro eixos adicionais cobrem **qualidade, tamanho, latência-até-código e
consumo** (todos derivados sem instrumentar o agente):

- **→ 1º edit (tempo-para-código):** ms do spawn até o PRIMEIRO evento de
  edit/write no stream — quão rápido o harness começa a entregar código, isolado
  do wall total que mistura startup + raciocínio. Droid (`-o json`, sem stream
  por-tool) fica **n/d**.
- **syntax-check (qualidade):** todo `.mjs/.js` alterado passa por `node --check`
  (parse-only). Um harness que deixa uma edição malformada pontua erro aqui mesmo
  que o oráculo já fosse FAIL por outro motivo — sinal de qualidade independente
  do veredito.
- **churn / net-LOC (tamanho):** linhas adicionadas+removidas e net-LOC do diff
  (só código, sidecars `.pit/.claude/.codex/.droid/.opencode` excluídos). Entre
  dois agentes que PASSAM, o de menor churn resolveu com menos código.
- **custo estimado US$ (consumo):** preço de tabela público (opus 15/75, gpt-5
  1,25/10 US$/Mtok) × tokens medidos — proxy **uniforme** entre todos. Não é o
  que se paga via Max/OAuth (custo marginal $0), mas responde "quanto custaria a
  preço de API". O componente de saída é o mais limpo; o de entrada herda o viés
  de medição abaixo.

Só do Pit, do stream de eventos: **rewrites** (reescrita preventiva de
tool-call), **rejects** (call inválida bloqueada), **error-hints**, **gate de
verificação** (typecheck/teste antes de declarar pronto) e **auto-retries**.
Os outros harnesses não expõem esses sinais.

A infra de métricas tem um **self-test** determinístico (sem LLM): `npx tsx
bench/selftest.mts` valida o detector de 1º-edit por formato, o syntax-gate e o
custo estimado.

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
- **Droid**: `droid exec -o json --skip-permissions-unsafe -m <m> --cwd <dir>`.
- **opencode**: `opencode run --format json --dangerously-skip-permissions -m <m>
  --dir <dir>`.

Todos recebem o prompt via **stdin**. Cada agente roda num sandbox próprio com baseline `git` para medir o diff. O
oráculo roda com `cwd` = sandbox e `BENCH_PRISTINE` = cópia limpa do seed (para
diferenciar arquivos que NÃO podiam mudar).
