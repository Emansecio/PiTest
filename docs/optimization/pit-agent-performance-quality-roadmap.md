# Roadmap de desempenho e qualidade do agente Pit/Pit

## Leitor e objetivo

**Leitor-alvo:** mantenedor futuro do Pit/Pit que precisa priorizar e implementar melhorias sem reler esta conversa.

**Ação após leitura:** escolher a próxima melhoria, editar os arquivos certos, rodar o benchmark correto e saber quais achados não devem ser retrabalhados.

## Escopo

Este documento consolida achados revisados sobre desempenho, velocidade e qualidade do agente Pit/Pit. Ele deduplica os resultados dos subagentes e remove conclusões que ficaram obsoletas após leitura direta do código atual.

Foco principal:

- tempo de startup;
- tempo até primeiro token (TTFT);
- latência de hooks e extensões;
- qualidade dos guards do harness;
- responsividade da TUI;
- contexto dinâmico do agente.

## Medições atuais confirmadas

Benchmarks executados em `C:/PiTest`:

```bash
node scripts/bench-startup.mjs --n=3
```

Resultado observado:

- extensões carregadas: `21`;
- melhor tempo total de carregamento de extensões: `2552ms`;
- wall-clock médio do startup/help: `4797ms`.

Prompt base medido:

```bash
npx tsx scripts/bench-prompt-size.mts
```

Resultado observado:

- prompt + ferramentas base: `11018` chars;
- estimativa: `~2978` tokens;
- system prompt: `3561` chars;
- descrições de ferramentas: `4396` chars;
- schemas de parâmetros: `3061` chars.

Configuração global atual relevante:

- `defaultProvider`: `anthropic`;
- `defaultModel`: `claude-opus-4-7`;
- `defaultThinkingLevel`: `high`;
- enabled models: `openai-codex/gpt-5.5`, `anthropic/claude-opus-4-7`.

Essa configuração favorece qualidade máxima, mas é lenta para trabalho mecânico com ferramentas.

## Já implementado: não retrabalhar

Estes achados apareceram em relatórios anteriores, mas já estão resolvidos no código atual:

1. **`before_provider_request` serializado**  
   O runner já separa handlers side-effect de handlers mutativos. Side-effects podem rodar com `Promise.all`; mutativos continuam seriais para preservar ordem.

2. **Cache ausente para tools, flags e commands**  
   O runner já cacheia ferramentas registradas, flags, comandos resolvidos e lookup de comando.

3. **`emitContext` com clone pesado ou sem early-out**  
   O código atual já retorna cedo quando não há handlers de contexto e evita `structuredClone` incondicional.

4. **Eventos side-effect genéricos serializados**  
   Eventos genéricos não ordenados já usam execução paralela. Eventos `session_before_*` continuam seriais por poderem cancelar.

5. **Ausência de registry de built-ins**  
   Já existe registry em `packages/coding-agent/src/core/built-ins/index.ts`.

6. **System prompt reconstruído em todo turno**  
   Não confirmado no código atual. O prompt base fica cacheado e só é reconstruído em mudanças de ferramentas/recursos.

## Prioridade P0: perfis de modelo e thinking

### Problema

O padrão atual usa Opus com thinking `high`. Isso aumenta muito o wall-clock para tarefas rotineiras como ler arquivos, editar trechos pequenos, rodar comandos e responder após tool calls.

### Melhorias

Criar perfis explícitos:

| Perfil | Modelo | Thinking | Uso |
|---|---|---|---|
| `fast` | Sonnet ou Codex | `low` ou `minimal` | navegação, leitura, edição, tool calls |
| `deep` | Opus | `high` | arquitetura, debugging profundo, revisão crítica |
| `auto` | roteador simples | depende da tarefa | seleciona `fast` por padrão e sobe para `deep` sob demanda |

### Arquivos prováveis

- `packages/coding-agent/src/core/model-resolver.ts`
- `packages/coding-agent/src/core/defaults.ts`
- `packages/coding-agent/src/core/settings-manager.ts`
- áreas da TUI que alternam modelo/thinking

### Validação

Comparar tempo por turno real com:

- Opus + `high`;
- Sonnet/Codex + `low`;
- Opus + `high` só em tarefas complexas.

### Impacto esperado

Maior ganho prático: **2x a 5x menos wall-clock** em uso comum.

## Prioridade P1: corrigir permissões do `edit`

### Problema

O tool `edit` atual usa `path`, mas `describeToolAction("edit")` coleta `file`. Isso pode fazer regras de permissão por path não pegarem edições reais.

### Arquivo

- `packages/coding-agent/src/core/permissions/checker.ts`

### Correção

- Para `edit`, coletar `file` e `path`.
- Se algum formato futuro aceitar path por edição, coletar também `edits[].path`.
- Manter compatibilidade com `edits[].file` existente.
- Atualizar testes de `describeToolAction`.

### Validação

Adicionar casos em `permissions-checker.test.ts`:

- `describeToolAction("edit", { path: "src/a.ts", edits: [...] })` retorna action `write` com `paths: ["src/a.ts"]`;
- regra `denyPaths` bloqueia `edit` por `path`;
- regra `allowPaths` libera `edit` por `path`.

### Impacto esperado

Alta qualidade/segurança. Evita bypass acidental de regras de path em edições.

## Prioridade P1: corrigir `diff-limit` para schema atual do `edit`

### Problema

`diff-limit-extension.ts` procura `old_string/new_string` ou `oldString/newString`, mas o tool `edit` atual usa `edits[].oldText/newText`. Resultado: grandes edições podem não entrar corretamente no limite de linhas.

### Arquivo

- `packages/coding-agent/src/core/built-ins/diff-limit-extension.ts`

### Correção

- Para `write`, continuar contando linhas de `content`.
- Para `edit`, iterar `edits[]`.
- Para cada edição, contar linhas de `oldText` e `newText`.
- Suportar LF e CRLF.
- Evitar dupla contagem absurda em múltiplas edições próximas; se necessário, manter estimativa conservadora.

### Validação

Adicionar teste com:

- edição pequena abaixo do limite;
- edição grande acima do limite;
- múltiplas entradas em `edits[]`;
- CRLF;
- modo sem UI bloqueando overage.

### Impacto esperado

Evita over-engineering passar sem confirmação. Melhora segurança operacional do harness.

## Prioridade P1: documentar e testar contrato de `tool_call`

### Problema

Vários built-ins usam o mesmo evento `tool_call`: permissões, read guard e diff limit. O código atual é serial, na ordem de registro, e o primeiro handler que retorna `block` encerra a cadeia. Isso precisa estar documentado e coberto por teste de integração.

### Arquivos

- `packages/coding-agent/src/core/extensions/types.ts`
- `packages/coding-agent/src/core/extensions/runner.ts`
- `packages/coding-agent/src/core/built-ins/index.ts`
- testes de integração do agent session

### Correção

Documentar no tipo/evento:

- handlers rodam serialmente;
- ordem = ordem de registro das extensões;
- handlers posteriores veem mutações de `event.input` feitas por handlers anteriores;
- primeiro `block` interrompe execução;
- não há revalidação automática após mutação.

Adicionar teste de interleaving:

- permissions bloqueia antes de read guard;
- read guard bloqueia quando permissions permite;
- diff limit bloqueia quando permissions e read guard permitem;
- ordem de built-ins permanece estável.

### Impacto esperado

Menos ambiguidade para extensões. Reduz bugs de interação entre guards.

## Prioridade P1: util comum de path para guards e tools

### Problema

Read guard resolve paths localmente. Permissions e ferramentas têm suas próprias convenções. Divergência de normalização pode causar falso bloqueio ou falso allow.

### Arquivos

- `packages/coding-agent/src/core/built-ins/read-guard-extension.ts`
- `packages/coding-agent/src/core/permissions/checker.ts`
- util de paths existente ou novo módulo em `packages/coding-agent/src/core/`

### Correção

Extrair util compartilhado para:

- detectar path absoluto Windows/Unix;
- resolver relativo contra cwd;
- normalizar separadores quando necessário;
- preservar path original para mensagens ao usuário.

### Validação

Testes com:

- path relativo;
- path absoluto Unix;
- path absoluto Windows;
- paths com `..`;
- cwd Windows.

### Impacto esperado

Melhora confiabilidade dos guards e reduz drift entre módulos.

## Prioridade P1: reduzir startup das extensões

### Evidência

Execução com `PIT_TIMING=1` mostrou custos relevantes:

- `.pit/extensions/prompt-url-widget.ts`: `759ms`;
- `pi-autoresearch`: `689ms`;
- `pi-subagents`: `606ms`;
- `@tintinweb/pi-tasks`: `530ms`.

Também foram observadas falhas de native import com fallback para jiti em alguns pacotes, incluindo `pi-caveman`, `@tintinweb/pi-tasks` e `@tintinweb/pi-subagents`.

### Arquivos

- `packages/coding-agent/src/core/extensions/loader.ts`
- `scripts/precompile-pi-packages.mjs`

### Melhorias

1. Aplicar preferência por `.js` precompilado também para extensões locais diretas em `.pit/extensions/*.ts`.
2. Precompilar extensões locais do projeto, não só pacotes npm.
3. Corrigir imports/exports que fazem native import falhar e cair para jiti.
4. Melhorar `precompile-pi-packages.mjs` para não andar pacote inteiro quando um entry root importa só poucos arquivos.
5. Benchmarkar loading paralelo seletivo apenas para `.js` nativo.

### Observação sobre paralelismo

`loadExtensions()` ainda é serial. Vale testar paralelismo seletivo de `.js`, mas o comentário atual indica que medição anterior não mostrou ganho. Portanto, isso deve ser tratado como experimento benchmark-first, não como certeza.

### Validação

Rodar antes/depois:

```bash
PIT_TIMING=1 npx tsx packages/coding-agent/src/cli.ts --help
node scripts/bench-startup.mjs --n=5
```

Verificar:

- queda no tempo dos maiores offenders;
- menos fallback para jiti;
- nenhum pacote carregando versão stale de `.ts`.

### Impacto esperado

Provável redução de **0.7s a 1.5s** no startup se native import fallback e precompile local forem corrigidos.

## Prioridade P1: orçamento para hooks `before_agent_start`

### Problema

`agentmemory` executa smart-search antes de cada turno. Quando lento, bloqueia TTFT: o modelo nem começa a responder até o hook terminar.

### Arquivos

- `C:/Users/User/.pit/agent/extensions/agentmemory/index.ts`
- `packages/coding-agent/src/core/extensions/runner.ts`

### Melhorias

1. Timeout curto por hook, inicialmente entre `100ms` e `300ms` para modo rápido.
2. Cache por prompt/session para smart-search.
3. Modo speed: lookup de memory em background ou desligado.
4. Métricas por hook com `PIT_TIMING`.
5. Fallback silencioso quando memory server estiver lento.

### Validação

Adicionar métricas:

- tempo por handler de `before_agent_start`;
- tempo total antes do provider request;
- cache hit/miss do memory lookup;
- timeout count.

### Impacto esperado

TTFT menor e menos travamento antes do primeiro token.

## Prioridade P1: snapshot defensivo em hooks mutativos de provider payload

### Problema

`before_provider_request` já separa side-effect e mutativo. Porém, se um handler mutativo alterar payload parcialmente e falhar, outro handler pode receber estado inconsistente.

### Arquivo

- `packages/coding-agent/src/core/extensions/runner.ts`

### Correção

Antes de cada handler mutativo:

- guardar snapshot barato do payload atual quando possível;
- se handler falhar, restaurar estado anterior ou garantir que resultado parcial não segue adiante;
- registrar erro via mecanismo existente.

### Validação

Teste com extensão fake que:

1. recebe payload;
2. muta campo interno;
3. lança erro;
4. confirma que próximo handler recebe payload anterior consistente.

### Impacto esperado

Mais robustez contra extensões instáveis. Ganho é qualidade, não velocidade.

## Prioridade P2: cache e dirty flags no autocomplete/TUI

### Problema

`createBaseAutocompleteProvider()` recria listas, closures e coleções. `setupAutocompleteProvider()` tem múltiplos call sites e reconstrói provider completo. `getRegisteredCommands()` também limpa `commandDiagnostics` em todo call, mesmo em cache hit.

### Arquivos

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
- `packages/coding-agent/src/core/extensions/runner.ts`

### Melhorias

1. Cachear comandos built-in.
2. Cachear lista de modelos enquanto registry/scoped models não muda.
3. Cachear templates, extension commands e skill commands por dirty flag.
4. Recriar provider só quando resources/model/skills mudarem.
5. Mover reset de `commandDiagnostics` para invalidação de cache, não para getter.
6. Evitar allocations no caminho de digitação.

### Validação

Medir:

- tempo de `setupAutocompleteProvider()`;
- número de chamadas por sessão;
- latência de keypress com muitas skills/extensões;
- heap/GC durante autocomplete.

### Impacto esperado

Menos GC e TUI mais responsiva, especialmente com muitas extensões e skills.

## Prioridade P2: frequent-files dinâmico e compacto

### Problema

O tracker de frequent-files registra arquivos tocados, mas a seção no prompt base pode ficar stale se o prompt não for reconstruído. Além disso, a renderização atual pode ser mais verbosa que o necessário.

### Arquivos

- `packages/coding-agent/src/core/agent-session.ts`
- `packages/coding-agent/src/core/frequent-files.ts`

### Melhorias

1. Renderizar `<frequent_files>` como seção dinâmica no início de cada turno, sem reconstruir o prompt inteiro.
2. Alternativamente, invalidar o prompt base quando o tracker muda.
3. Compactar formato da seção:
   - menos texto explicativo;
   - formato de contadores curto;
   - limitar top N por settings.

### Validação

Testes:

- read/edit/write atualizam tracker;
- próximo turno vê seção atualizada;
- compaction/reset não deixa estado enganoso;
- prompt não cresce demais.

### Impacto esperado

Melhora qualidade do agente por manter arquivos relevantes visíveis sem busca extra. Pequeno ganho de tokens se formato for comprimido.

## Prioridade P2: metadata de compaction para sessões antigas

### Problema

Compactions antigas podem ter só `readFiles` e `modifiedFiles`, sem `searches`, `shellCmds` e `mcpCalls`. Ao retomar sessões, parte do sinal operacional se perde.

### Arquivos

- `packages/coding-agent/src/core/compaction/compaction.ts`
- `packages/coding-agent/src/core/compaction/utils.ts`
- session loading/build context

### Melhorias

1. Tratar campos ausentes como arrays vazios.
2. Quando possível, extrair sinais do texto da summary antiga.
3. Garantir que novas compactions sempre gravem metadata estruturada completa.

### Validação

Criar fixture de sessão antiga e confirmar que build de contexto não perde formato nem quebra.

### Impacto esperado

Melhor retomada de sessões longas. Menos reexploração desnecessária.

## Prioridade P2: budget dinâmico para branch summary

### Problema

Branch summaries pequenas podem reservar budget alto demais. Isso não quebra, mas desperdiça margem e pode aumentar latência em resumos simples.

### Arquivo

- `packages/coding-agent/src/core/compaction/branch-summarization.ts`

### Melhorias

- Estimar tamanho da branch antes de sumarizar.
- Usar budget menor para branches curtas.
- Manter cap alto para branches grandes.

Exemplo de política:

| Tamanho estimado da branch | Budget sugerido |
|---|---|
| `< 500 tokens` | `2048` ou `4096` |
| `500–5000 tokens` | `8192` |
| `> 5000 tokens` | manter default alto |

### Validação

Benchmarkar qualidade e latência em branches pequenas, médias e grandes.

### Impacto esperado

Menor latência em navegação/retorno de branches pequenas.

## Benchmarks recomendados

Rodar sempre antes e depois de cada mudança de performance:

```bash
cd C:/PiTest
node scripts/bench-startup.mjs --n=5
npx tsx scripts/bench-prompt-size.mts
PIT_TIMING=1 npx tsx packages/coding-agent/src/cli.ts --help
```

Para mudanças em hooks, adicionar cenário com turno real e medir:

- tempo antes do provider request;
- `emit_bpr_ms`;
- `before_agent_start` por extensão;
- TTFT percebido.

Para mudanças em guards, rodar testes focados do pacote `packages/coding-agent` conforme regra do repositório, a partir do package root.

## Ordem prática recomendada

1. **Config/perfis de modelo + thinking**  
   Maior ganho de velocidade percebida.

2. **Corrigir permissões do `edit` e `diff-limit`**  
   Alto impacto em segurança/qualidade do harness.

3. **Precompile/local extension fast path e native import fallback**  
   Reduz startup com evidência direta em `PIT_TIMING`.

4. **Hook budgets para `before_agent_start`**  
   Reduz TTFT e travas antes do primeiro token.

5. **TUI autocomplete cache**  
   Melhora responsividade interativa.

6. **Frequent-files dinâmico e compacto**  
   Melhora contexto do agente sem busca extra.

7. **Compaction metadata e branch budget**  
   Melhora retomada de sessões e navegação.

8. **Micro-otimizações restantes**  
   Só após medições mostrarem gargalo real.

## Achados descartados ou rebaixados após revisão

| Achado original | Decisão revisada | Motivo |
|---|---|---|
| `before_provider_request` ainda serial | descartado | split side-effect/mutating já existe |
| cache de tools/commands/flags ausente | descartado | caches já existem |
| `emitContext` sem early-out/lazy | descartado | guard e lazy behavior já existem |
| ausência de registry built-ins | descartado | `built-ins/index.ts` existe |
| system prompt rebuild em todo turno | descartado | não confirmado; prompt base é cacheado |
| parallelizar todo `loadExtensions()` | rebaixado | comentário atual diz que teste anterior não ganhou; deve ser benchmark-first |
| frequent-files eviction O(n) | rebaixado | cap baixo torna impacto pequeno; só otimizar se medição justificar |

## Critério de conclusão para cada item

Cada melhoria deve ter:

1. benchmark antes/depois;
2. teste focado quando alterar comportamento;
3. nenhum achado obsoleto reintroduzido;
4. documentação curta no changelog ou doc interna se mudar contrato de extensão;
5. rollback claro se métrica piorar.
