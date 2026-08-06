# Plano de correção e polimento da UI/UX da CLI do Pit

**Status:** proposta de implementação
**Data da auditoria:** 2026-08-04
**Escopo:** modo interativo da CLI, superfícies auxiliares do terminal e mensagens de erro da linha de comando

## 1. Objetivo

Este documento transforma a auditoria visual e de experiência de uso da CLI em um plano executável. Ao final, um mantenedor deve conseguir corrigir os problemas confirmados sem redesenhar a TUI, sem perder as qualidades já existentes e sem depender de documentação possivelmente desatualizada.

O resultado pretendido é:

- tornar comandos e recursos encontráveis mesmo quando o ambiente carrega muitas extensões, templates e skills;
- remover caminhos de ajuda que ocupam permanentemente o histórico da conversa;
- alinhar a aparência da tela inicial ao que realmente é interativo;
- melhorar o contraste de informações acionáveis;
- permitir acesso deliberado ao conteúdo de thinking que já é exibido, mas hoje é dobrado sem retorno;
- oferecer recuperação mínima em erros de argumentos da CLI;
- proteger o acabamento visual com testes de tela completa.

O plano não propõe trocar a biblioteca TUI, redesenhar todas as mensagens, adicionar uma GUI ou alterar a execução do agente. O núcleo visual atual é bom e deve ser preservado.

## 2. Como a auditoria foi feita

As conclusões vieram do código executado e dos componentes atuais. A documentação existente foi usada somente para localização e convenções do repositório.

A verificação incluiu:

1. leitura do fluxo de inicialização, composição da conversa, editor, rodapé, autocomplete, seletores, ferramentas, thinking, temas e núcleo da TUI;
2. execução do código-fonte atual em modo interativo offline;
3. inspeção de `--help`, argumento inválido, tela inicial, atualização do rodapé, abertura da paleta `/`, `/help` e encerramento;
4. execução de 297 testes focados dos componentes da CLI;
5. execução dos 1.090 testes da biblioteca `@pit/tui`.

Os 1.387 testes passaram. Isso confirma uma base funcional forte, mas não invalida os problemas de descoberta, coerência e contraste descritos abaixo.

### Limitações da observação

- A auditoria não enviou solicitações pagas a providers. Estados de streaming e ferramentas foram verificados pelo código e por testes.
- Não houve validação manual em todos os emuladores de terminal suportados.
- Temas, extensões e keybindings personalizados podem produzir combinações adicionais.
- O wrapper local informou que o código-fonte estava mais novo que o bundle e executou via `tsx`. Portanto, a inspeção interativa representa a fonte atual, não uma garantia de paridade com um bundle antigo.

## 3. Fotografia atual

### 3.1 Pontos fortes que devem permanecer

| Área | Comportamento atual a preservar | Módulos principais |
|---|---|---|
| Renderização | Atualização diferencial, isolamento de falhas por componente, resize, backpressure e limpeza de imagens. | `packages/tui/src/tui.ts` |
| Terminal | Mouse, seleção de transcript, foco de overlays, cursor de hardware e suporte a capacidades distintas. | `packages/tui/src/tui.ts`, `packages/tui/src/terminal.ts`, `packages/tui/src/keys.ts` |
| Conversa | Mensagens com gutters estáveis, largura controlada e separação semântica entre usuário, assistente, sistema e ferramentas. | `components/message-shell.ts`, `turn-view.ts` |
| Ferramentas | Resumo compacto durante execução, duração, alvo, diffstat, erros visíveis e expansão sob demanda. | `components/activity-line.ts`, `components/tool-execution.ts`, `components/work-group.ts` |
| Rodapé | Densidade adaptativa, contexto, modelo, permissão, repositório e alertas sem quebrar larguras reduzidas. | `components/footer.ts` |
| Pickers | Busca, paginação, teclado, mouse, cancelamento e estados vazio/carregando. | `components/ask-picker.ts`, `components/session-selector.ts`, `components/tree-selector.ts` |
| Temas | Temas claro/escuro, detecção do fundo do terminal, tokens semânticos e movimento reduzido. | `theme/theme.ts`, `theme/dark.json`, `theme/light.json` |
| Startup | Layout adaptativo, mascote opcional, redução de movimento e fallback seguro se a renderização falhar. | `components/startup-screen.ts` |

Essas áreas não precisam de reescrita. As correções devem atuar nas superfícies de orientação e nos poucos pontos de inconsistência confirmados.

### 3.2 Avaliação resumida

| Eixo | Avaliação qualitativa | Motivo |
|---|---:|---|
| Robustez visual | 9/10 | A TUI possui proteções e cobertura incomuns para uma CLI. |
| Coerência de componentes | 8/10 | Mensagens, ferramentas e seletores compartilham linguagem visual consistente. |
| Hierarquia da conversa | 8/10 | Conteúdo principal e atividade operacional são bem separados. |
| Descoberta de recursos | 5/10 | A quantidade de comandos superou a organização da paleta e da ajuda. |
| Acessibilidade visual | 6,5/10 | Há reduced motion e fallbacks, mas dicas acionáveis usam contraste baixo. |
| Consistência de interação | 7/10 | A maioria dos seletores é consistente; ajuda e startup fogem desse padrão. |

## 4. Problemas confirmados

### P1 — Paleta `/` sobrecarregada e sem estrutura suficiente

Na sessão auditada, digitar `/` abriu 143 entradas. O editor mostrava cinco itens por vez. A ordem inicial era formada pela concatenação de comandos nativos, templates, extensões e skills. O `/help`, anunciado na tela inicial, não aparecia na primeira página.

O problema nasce de três decisões atuais:

- `createBaseAutocompleteProvider()` concatena as quatro origens em sequência;
- o autocomplete trata cada entrada somente como valor, label e descrição;
- com prefixo vazio, a lista mantém a ordem recebida; com texto, aplica apenas fuzzy matching.

O modelo de comandos já possui grupos para `/help`, mas registra explicitamente que a aplicação desses grupos ao menu `/` ainda ficou para depois.

**Impacto:** recursos existentes parecem inexistentes, a origem dos comandos é pouco legível e o usuário precisa navegar por uma lista extensa para tarefas elementares.

**Evidência primária:** [registro de slash commands](../../packages/coding-agent/src/core/slash-commands.ts), [montagem do autocomplete](../../packages/coding-agent/src/modes/interactive/interactive-mode.ts), [provider da TUI](../../packages/tui/src/autocomplete.ts), [lista usada pelo editor](../../packages/tui/src/components/select-list.ts).

### P2 — `/help` descreve uma realidade diferente da paleta

O conteúdo de `/help` é gerado somente a partir de `BUILTIN_SLASH_COMMANDS`. Templates, extensões e skills disponíveis na mesma sessão não entram no resultado. Na execução auditada, a paleta tinha 143 itens, mas a ajuda listava apenas os comandos nativos visíveis.

**Impacto:** existem duas fontes de verdade para o mesmo produto. Um usuário não consegue usar `/help` para compreender o menu que acabou de abrir.

**Evidência primária:** [builder de ajuda](../../packages/coding-agent/src/core/slash-commands.ts) e [handler de `/help`](../../packages/coding-agent/src/modes/interactive/interactive-mode.ts).

### P3 — `/help` e `/hotkeys` poluem permanentemente a conversa

Cada execução acrescenta `Spacer`, bordas, título e um bloco Markdown ao `chatContainer`. O conteúdo não é removido, não é reutilizado e pode ser duplicado indefinidamente.

Para atalhos, já existe uma superfície melhor: o `Cheatsheet` centralizado, rolável, focável e fechável. O comando `/hotkeys` ignora esse componente e mantém um segundo caminho de apresentação.

**Impacto:** perda de espaço vertical, conversa empurrada para o scrollback e inconsistência entre atalho e comando textual.

**Evidência primária:** [handlers de ajuda e hotkeys](../../packages/coding-agent/src/modes/interactive/interactive-mode.ts) e [Cheatsheet existente](../../packages/tui/src/components/cheatsheet.ts).

### P4 — Sessões recentes parecem ações, mas são apenas texto

A tela inicial mostra até três sessões com seta em cor de destaque. O comentário do componente as chama de “resumable”, mas `StartupScreen` não implementa foco, input ou mouse. Também não há texto adjacente explicando que a retomada ocorre por `/resume`.

**Impacto:** a aparência cria uma expectativa de clique ou Enter que a interface não cumpre.

**Evidência primária:** [StartupScreen](../../packages/coding-agent/src/modes/interactive/components/startup-screen.ts) e [integração da startup](../../packages/coding-agent/src/modes/interactive/interactive-mode.ts).

### P5 — Informações acionáveis usam contraste baixo

Os temas canônicos usam o token `dim` em dicas, atalhos, placeholders e URLs. O tema de pickers também mapeia `hint` diretamente para `dim`.

Contraste calculado a partir das cores dos próprios temas:

| Combinação | Relação |
|---|---:|
| Escuro: `dim` sobre `pageBg` | 3,60:1 |
| Escuro: `dim` sobre `cardBg` | 3,40:1 |
| Claro: `dim` sobre `pageBg` | 3,47:1 |
| Claro: `dim` sobre `cardBg` | 3,74:1 |

O token `muted` fica aproximadamente entre 4,9:1 e 5,2:1 nesses fundos. O problema, portanto, pode ser corrigido sem descaracterizar a paleta.

**Impacto:** atalhos e instruções de operação ficam difíceis de ler, especialmente em terminais com brilho, gamma ou fundo diferentes do esperado.

**Evidência primária:** [tema escuro](../../packages/coding-agent/src/modes/interactive/theme/dark.json), [tema claro](../../packages/coding-agent/src/modes/interactive/theme/light.json) e [mapeamento semântico](../../packages/coding-agent/src/modes/interactive/theme/theme.ts).

### P6 — Thinking concluído é dobrado sem caminho de expansão

Durante o streaming, o thinking visível permanece completo. Depois de concluído, blocos longos conservam somente as últimas seis linhas visuais e mostram `… +N earlier lines`. O próprio componente registra que nenhum keybinding pode restaurar as linhas ocultas.

O problema não é a dobra padrão: ela reduz ruído corretamente. O problema é apresentar uma contagem de conteúdo oculto sem permitir acesso deliberado a ele.

**Impacto:** depuração, auditoria e leitura detalhada ficam incompletas mesmo quando o usuário escolheu exibir thinking.

**Evidência primária:** [AssistantMessageComponent](../../packages/coding-agent/src/modes/interactive/components/assistant-message.ts) e [keybindings de thinking/ferramentas](../../packages/coding-agent/src/core/keybindings.ts).

### P7 — Argumento desconhecido encerra sem orientação

Um argumento inválido produz apenas `Error: Unknown option: ...` e código de saída 1. O fluxo não aponta para `pit --help` e não tenta sugerir uma opção próxima, embora o parser conheça as opções válidas.

**Impacto:** pequeno, mas recorrente em uso de CLI. O usuário precisa descobrir sozinho como se recuperar.

**Evidência primária:** [parser de argumentos](../../packages/coding-agent/src/cli/args.ts) e [tratamento dos diagnósticos](../../packages/coding-agent/src/main.ts).

### P8 — Ausência de uma matriz de regressão visual de tela completa

A cobertura unitária e comportamental é forte, mas não foi encontrada uma matriz determinística que compare frames completos para os principais estados, larguras e temas.

**Impacto:** espaçamento, ordem, truncamento e hierarquia podem regredir enquanto testes isolados continuam verdes.

**Evidência primária:** [visual gate atual](../../packages/coding-agent/test/visual-gate.test.ts), testes de componentes em `packages/coding-agent/test/` e testes de renderização em `packages/tui/test/`.

## 5. Princípios para a correção

1. **Uma fonte de verdade para comandos.** Dispatch, autocomplete e ajuda devem consumir o mesmo registro efetivo.
2. **Informação temporária não pertence ao transcript.** Ajuda, atalhos e pickers devem usar overlays; resultados da conversa e operações do agente continuam no histórico.
3. **Não prometer interação visualmente quando ela não existe.** Destaque, seta e seleção devem corresponder a uma ação real.
4. **Contraste sem transformar tudo em destaque.** `dim` continua válido para decoração; conteúdo acionável usa `muted` ou `hint` acessível.
5. **Dobra com saída.** Conteúdo recolhido deve indicar e oferecer expansão quando a informação ainda existe em memória.
6. **Mudanças pequenas e testáveis.** Não reescrever `interactive-mode.ts`, o editor ou a TUI para resolver problemas localizados.
7. **Compatibilidade progressiva.** Metadados novos no autocomplete e no `SelectList` devem ser opcionais para não alterar outros consumidores.

## 6. Arquitetura proposta

### 6.1 Registro efetivo de comandos

Criar um modelo único de apresentação, derivado das fontes já carregadas pela sessão:

```ts
interface EffectiveSlashCommand {
	name: string;
	description?: string;
	argumentHint?: string;
	completeOnly?: boolean;
	group: "Session" | "Model" | "Config" | "Info" | "Advanced" | "Project";
	kind: "builtin" | "template" | "extension" | "skill";
	sourceLabel?: string;
	priority: number;
}
```

Esse tipo é uma projeção de UI, não um novo mecanismo de dispatch. Ele deve respeitar as colisões e precedências que já são resolvidas por `InteractiveMode`.

O array efetivo deve alimentar:

```text
BUILTIN_SLASH_COMMANDS ─┐
prompt templates ───────┤
extension commands ─────┼─> effective command registry ─> autocomplete
skills ─────────────────┤                              └─> /help overlay
source metadata ────────┘                              └─> diagnostics/tests
```

### 6.2 Metadados opcionais na TUI

Adicionar aos itens de autocomplete e seleção somente os campos necessários para apresentação:

- `section?: string` — título do grupo;
- `badge?: string` — origem curta, como `built-in`, `skill`, `ext`, `project`;
- `priority?: number` — ordenação inicial antes de qualquer filtro.

`SelectList` deve tratar cabeçalhos como linhas não selecionáveis. O cálculo de scroll e o hit-test do mouse precisam trabalhar com as linhas realmente renderizadas, não assumir que cada linha corresponde a um item.

Para consumidores que não fornecem esses campos, a saída deve permanecer byte a byte equivalente à atual.

### 6.3 Ajuda como overlay

Criar um componente da camada `coding-agent`, por exemplo `SlashHelpOverlay`, usando os componentes de busca e seleção existentes. Ele recebe o registro efetivo, permite filtrar por nome/descrição/origem e fecha com Esc.

`/hotkeys` não precisa de componente novo: deve abrir o `Cheatsheet` que já existe.

### 6.4 Startup honesta, com baixo risco

Neste ciclo, a correção recomendada é explícita e não interfere no editor:

- incluir o rótulo `Recent sessions · /resume` antes das linhas;
- substituir a seta de ação por um marcador neutro;
- preservar até três sessões e suas idades;
- não interceptar números, setas ou Enter enquanto o usuário escreve.

Tornar essas linhas diretamente selecionáveis exigiria uma nova negociação de foco entre o histórico e o editor. Isso pode ser uma melhoria posterior, mas não é necessário para corrigir a falsa affordance atual.

### 6.5 Contraste semântico

Não clarear globalmente todo `dim`. Em vez disso:

- `hint`, key hints, placeholders, indicadores de scroll e URLs usam `muted`;
- `dim` permanece em separadores, idades, metadata não essencial e elementos decorativos;
- os temas canônicos passam por teste automatizado de contraste para pares de texto acionável sobre `pageBg`, `cardBg` e fundos de seleção relevantes.

### 6.6 Expansão do thinking

Adicionar estado de expansão separado da visibilidade:

- `hidden`: bloco de thinking não renderizado;
- `visible-folded`: comportamento atual após settle;
- `visible-expanded`: conteúdo completo preservado.

O keybinding `app.thinking.toggle` deve continuar controlando visibilidade. A expansão pode reutilizar `app.tools.expand` quando o último bloco expansível for thinking, seguindo a mesma lógica contextual já usada por ferramentas e resumos.

O trailer deve informar o atalho real, por exemplo `… +18 earlier lines (Ctrl+O to expand)`. Recolher novamente deve ser possível pelo mesmo comando.

## 7. Plano de implementação

### Tarefa 0 — Congelar a baseline e proteger o WIP

**Objetivo:** distinguir as correções de UI/UX das alterações locais já existentes.

**Ações:**

- registrar `git status --short` e a diff atual dos arquivos-alvo;
- não restaurar arquivos inteiros;
- aplicar cada tarefa como uma fatia independente;
- não editar `CHANGELOG.md`;
- executar testes focados antes dos gates amplos.

O working tree auditado já possui WIP em arquivos centrais desta proposta, incluindo `interactive-mode.ts`, componentes de mensagens, footer, temas, testes e partes da TUI. Isso aumenta a importância de patches pequenos e revisão de diff por tarefa.

### Tarefa 1 — Criar o registro efetivo de comandos

**Arquivos:**

- modificar `packages/coding-agent/src/core/slash-commands.ts`;
- criar `packages/coding-agent/src/modes/interactive/effective-slash-commands.ts`;
- modificar `packages/coding-agent/src/modes/interactive/interactive-mode.ts`;
- modificar `packages/coding-agent/src/modes/interactive/autocomplete-source.ts`;
- modificar `packages/coding-agent/test/slash-commands.test.ts`;
- modificar `packages/coding-agent/test/slash-command-autocomplete.test.ts`.

**Implementação:**

1. manter `BUILTIN_SLASH_COMMANDS` como catálogo dos built-ins;
2. projetar built-ins, templates, extensões e skills em `EffectiveSlashCommand` após aplicar as regras atuais de colisão;
3. atribuir grupo, tipo e origem a cada entrada;
4. definir uma prioridade inicial explícita:
   - `help`, `resume`, `new`, `model`, `settings`;
   - demais built-ins por grupo;
   - comandos de projeto;
   - extensões e skills;
5. manter correspondência exata e por prefixo acima de prioridade quando o usuário digitar texto;
6. substituir a construção paralela de arrays no autocomplete pelo registro efetivo.

**Regressões obrigatórias:**

- o registro contém todas as fontes disponíveis uma única vez;
- colisões preservam a mesma precedência do dispatch;
- `/help` aparece entre os primeiros itens com prefixo vazio;
- busca exata continua vencendo a prioridade estática;
- hidden built-ins continuam conhecidos, mas não aparecem visualmente;
- source labels não expõem caminhos absolutos.

### Tarefa 2 — Estruturar visualmente a paleta `/`

**Arquivos:**

- modificar `packages/tui/src/autocomplete.ts`;
- modificar `packages/tui/src/components/select-list.ts`;
- modificar `packages/tui/src/components/editor.ts`;
- modificar `packages/tui/test/autocomplete.test.ts`;
- modificar `packages/tui/test/select-list.test.ts`;
- modificar `packages/coding-agent/test/slash-command-autocomplete.test.ts`.

**Implementação:**

1. adicionar metadados opcionais de seção, badge e prioridade;
2. ordenar por prioridade somente quando o prefixo estiver vazio;
3. renderizar uma seção apenas quando houver ao menos um item visível daquele grupo;
4. garantir que cabeçalhos não recebam seleção, confirmação ou clique;
5. manter o contador em termos de comandos, não de linhas de cabeçalho;
6. aumentar a quantidade visível de comandos de forma adaptativa, limitada pela altura do terminal, em vez de fixar sempre cinco;
7. preservar a renderização atual em file completion, histórico e pickers que não usam seções.

**Saída visual esperada:**

```text
  ESSENTIAL
→ help        Open command help                         built-in
  resume      Resume a previous session                 built-in
  new         Start a new session                       built-in

  MODEL & CONFIG
  model       Select model or role                      built-in
  settings    Open settings menu                        built-in
  ↓ (1/143) · type to filter
```

O texto exato pode seguir o idioma atual da interface; o contrato importante é a hierarquia.

**Regressões obrigatórias:**

- teclado pula cabeçalhos;
- clique resolve o item correto mesmo com cabeçalhos;
- scroll mantém seleção visível;
- terminais estreitos truncam badge antes do nome do comando;
- lista sem metadados não muda;
- zero resultados continua exibindo a mensagem atual.

### Tarefa 3 — Unificar `/help`, `/hotkeys` e a paleta

**Arquivos:**

- criar `packages/coding-agent/src/modes/interactive/components/slash-help-overlay.ts`;
- modificar `packages/coding-agent/src/modes/interactive/interactive-mode.ts`;
- reutilizar `packages/tui/src/components/cheatsheet.ts` sem duplicar seu conteúdo;
- criar `packages/coding-agent/test/slash-help-overlay.test.ts`;
- modificar `packages/coding-agent/test/slash-commands.test.ts`;
- modificar ou criar teste focado dos handlers de help/hotkeys.

**Implementação:**

1. `handleHelpCommand()` abre o overlay alimentado pelo registro efetivo;
2. o overlay possui filtro, categorias, origem, descrição e hint de fechamento;
3. `handleHotkeysCommand()` chama o mesmo caminho de `showCheatsheet()`;
4. remover a construção de tabelas Markdown duplicadas do handler;
5. impedir mais de uma instância de cada overlay;
6. chamadas repetidas focam ou alternam a instância existente;
7. nenhuma das duas ações acrescenta filhos ao `chatContainer`.

**Critérios de aceite:**

- ajuda lista built-ins, templates, extensões e skills efetivamente disponíveis;
- fechar o overlay devolve foco ao editor;
- Esc e keybinding configurado funcionam;
- repetição não altera o tamanho do transcript;
- atalhos personalizados continuam refletidos no Cheatsheet;
- terminais de baixa altura permitem scroll interno.

### Tarefa 4 — Corrigir a affordance das sessões recentes

**Arquivos:**

- modificar `packages/coding-agent/src/modes/interactive/components/startup-screen.ts`;
- modificar `packages/coding-agent/test/startup-screen.test.ts`;
- modificar `packages/coding-agent/test/interactive-mode-startup.test.ts`.

**Implementação:**

1. adicionar rótulo claro para o bloco de sessões recentes;
2. incluir `/resume` no próprio rótulo;
3. substituir o glifo de ação por bullet ou conector neutro;
4. conservar truncamento, centralização, reduced motion e limite de três sessões;
5. assegurar que a adição não empurre o editor para fora de telas compactas.

**Critérios de aceite:**

- a tela não sugere clique ou Enter;
- o usuário sabe como retomar uma sessão sem abrir `/help`;
- startup compacta continua top-anchored;
- sessões que chegam depois do reveal aparecem sem reiniciar a animação.

### Tarefa 5 — Corrigir contraste de conteúdo acionável

**Arquivos:**

- modificar `packages/coding-agent/src/modes/interactive/theme/theme.ts`;
- modificar `packages/coding-agent/src/modes/interactive/theme/dark.json`;
- modificar `packages/coding-agent/src/modes/interactive/theme/light.json`;
- revisar consumidores em `components/ask-picker.ts`, `components/footer.ts`, `components/startup-screen.ts` e `packages/tui/src/components/select-list.ts`;
- modificar `packages/coding-agent/test/theme-semantic-tokens.test.ts`;
- criar `packages/coding-agent/test/theme-contrast.test.ts`.

**Implementação:**

1. mapear `hint` para `muted`, não `dim`;
2. alterar `mdLinkUrl` para um token legível e semanticamente adequado;
3. aplicar `muted` a key hints, scroll status e placeholders operacionais;
4. manter `dim` em idades, decoração e metadata dispensável;
5. implementar no teste uma função pequena de luminância e razão de contraste;
6. exigir ao menos 4,5:1 para texto acionável nos fundos canônicos.

**Critérios de aceite:**

- temas claro e escuro passam no gate de contraste;
- selected text continua legível sobre selected background;
- erros, warnings e success não perdem distinção;
- temas customizados continuam carregando mesmo sem os tokens opcionais novos;
- não há clareamento global que destrua a hierarquia visual.

### Tarefa 6 — Tornar a dobra do thinking reversível

**Arquivos:**

- modificar `packages/coding-agent/src/modes/interactive/components/assistant-message.ts`;
- modificar `packages/coding-agent/src/modes/interactive/turn-view.ts`;
- modificar `packages/coding-agent/src/modes/interactive/interactive-mode.ts`;
- modificar `packages/coding-agent/src/core/keybindings.ts` somente se o comportamento contextual existente não for suficiente;
- modificar `packages/coding-agent/test/assistant-message.test.ts`;
- modificar `packages/coding-agent/test/interactive-mode-thinking-preview.test.ts`.

**Implementação:**

1. separar `thinkingVisible` de `thinkingExpanded`;
2. manter o thinking vivo sem dobra durante streaming;
3. após settle, dobrar somente quando economizar ao menos duas linhas;
4. incluir no trailer o keybinding efetivo de expansão;
5. fazer `app.tools.expand` expandir o último conteúdo recolhido, incluindo thinking, sem quebrar o ciclo de ferramentas;
6. permitir recolher novamente;
7. preservar o conteúdo completo no componente enquanto a mensagem estiver disponível.

**Critérios de aceite:**

- o estado padrão permanece compacto;
- o trailer nunca promete um atalho inoperante;
- expansão mostra todas as linhas;
- recolhimento restaura as últimas seis linhas;
- ocultar thinking continua funcionando independentemente da expansão;
- exportação e reconstrução de turno não divergem da visualização interativa.

### Tarefa 7 — Melhorar a recuperação de argumentos inválidos

**Arquivos:**

- modificar `packages/coding-agent/src/cli/args.ts`;
- modificar `packages/coding-agent/src/main.ts`;
- modificar `packages/coding-agent/test/args.test.ts`;
- modificar `packages/coding-agent/test/dry-run-cli.test.ts` ou criar um teste de subprocesso específico.

**Implementação:**

1. manter a primeira linha de erro curta;
2. acrescentar `Run pit --help to list available options.`;
3. sugerir `Did you mean --<option>?` somente abaixo de uma distância conservadora;
4. não imprimir a ajuda inteira automaticamente;
5. manter código de saída 1 e stderr como canal do diagnóstico;
6. não incluir opções registradas por extensões quando elas ainda não estiverem carregadas com segurança no ponto do parse.

**Critérios de aceite:**

- flag desconhecida termina com código 1;
- typo próximo recebe uma única sugestão;
- entrada distante não recebe sugestão enganosa;
- `--help` continua terminando com sucesso;
- modos JSON/RPC não recebem ruído em stdout.

### Tarefa 8 — Adicionar regressão visual de tela completa

**Arquivos:**

- criar `packages/coding-agent/test/interactive-screen-golden.test.ts`;
- criar fixtures pequenas sob `packages/coding-agent/test/fixtures/ui/`;
- reutilizar helpers de `packages/coding-agent/test/visual-gate.test.ts` e `packages/tui/test/_render-assert-setup.ts`;
- alterar scripts somente se o teste não puder entrar no Vitest unitário atual.

**Matriz mínima:**

| Estado | 40×12 | 80×24 | 120×40 | Claro/escuro |
|---|---:|---:|---:|---:|
| Startup sem sessões | ✓ | ✓ | — | ambos |
| Startup com três sessões | ✓ | ✓ | — | ambos |
| Paleta `/` com muitas origens | ✓ | ✓ | ✓ | ambos |
| Help overlay | ✓ | ✓ | — | ambos |
| Mensagem do usuário + streaming | — | ✓ | ✓ | escuro |
| Ferramenta pendente/sucesso/erro | ✓ | ✓ | ✓ | ambos |
| Thinking dobrado/expandido | ✓ | ✓ | — | ambos |
| Permission/Ask picker | ✓ | ✓ | — | ambos |
| Rodapé em contexto normal/crítico | ✓ | ✓ | ✓ | ambos |

**Normalização:**

- congelar relógio e duração;
- usar cwd, branch, modelo e contagens fixos;
- remover OSCs voláteis e normalizar ANSI antes da comparação quando apropriado;
- desabilitar animação ou avançar o ticker deterministicamente;
- não depender das dimensões do terminal real da máquina de teste.

**Critérios de aceite:**

- snapshots mostram frames completos, não somente linhas isoladas;
- uma mudança de hierarquia exige atualização explícita do golden;
- falha apresenta diff legível;
- execução permanece rápida o bastante para `check:fast`;
- nenhuma fixture contém credenciais, paths pessoais ou conteúdo de sessões reais.

## 8. Mapa consolidado de arquivos

| Área | Arquivos principais | Natureza da mudança |
|---|---|---|
| Registro de comandos | `core/slash-commands.ts`, `modes/interactive/effective-slash-commands.ts`, `interactive-mode.ts` | Unificar a fonte de apresentação. |
| Paleta | `tui/src/autocomplete.ts`, `tui/src/components/select-list.ts`, `tui/src/components/editor.ts` | Metadados, grupos, badges e altura adaptativa. |
| Ajuda | `components/slash-help-overlay.ts`, `interactive-mode.ts`, `tui/src/components/cheatsheet.ts` | Overlays sem poluir transcript. |
| Startup | `components/startup-screen.ts` | Rótulo explícito e affordance neutra. |
| Contraste | `theme/theme.ts`, `theme/dark.json`, `theme/light.json` | Separar decoração de informação acionável. |
| Thinking | `components/assistant-message.ts`, `turn-view.ts`, `interactive-mode.ts` | Dobra reversível. |
| Erros da CLI | `cli/args.ts`, `main.ts` | Hint e sugestão conservadora. |
| Regressão visual | testes e fixtures de UI | Frames determinísticos por estado e largura. |

## 9. Estratégia de testes

### Durante cada tarefa

No pacote `coding-agent`:

```powershell
cd packages/coding-agent
npx vitest --run test/slash-commands.test.ts test/slash-command-autocomplete.test.ts
npx vitest --run test/startup-screen.test.ts test/interactive-mode-startup.test.ts
npx vitest --run test/assistant-message.test.ts test/interactive-mode-thinking-preview.test.ts
npx vitest --run test/theme-semantic-tokens.test.ts test/theme-contrast.test.ts
npx vitest --run test/args.test.ts
```

Os testes da TUI usam o runner nativo do Node, não Vitest:

```powershell
cd packages/tui
node --test --import tsx --import ./test/_render-assert-setup.ts test/autocomplete.test.ts test/select-list.test.ts test/cheatsheet.test.ts
```

### Gates finais

Na raiz:

```powershell
npx tsgo --noEmit
npm run check:fast
npm run check
```

Também realizar uma verificação manual curta em terminal real:

1. iniciar `pit --no-session --offline`;
2. conferir startup em largura normal e estreita;
3. digitar `/`, filtrar e selecionar comandos de cada origem;
4. abrir e fechar `/help` duas vezes;
5. abrir `/hotkeys` por comando e keybinding;
6. verificar que o transcript não cresceu;
7. renderizar thinking longo e alternar dobra/expansão;
8. executar uma flag inválida próxima e outra distante;
9. testar tema claro e escuro;
10. confirmar mouse, seleção nativa com Shift e retorno de foco ao editor.

## 10. Critérios globais de aceite

A proposta estará concluída quando:

1. a paleta apresenta comandos por prioridade e origem, sem perder busca fuzzy;
2. `/help` representa exatamente os comandos disponíveis na sessão;
3. `/help` e `/hotkeys` não adicionam conteúdo permanente ao transcript;
4. a startup explica corretamente como retomar sessões;
5. todos os textos acionáveis dos temas canônicos atingem contraste mínimo de 4,5:1;
6. thinking dobrado pode ser expandido e recolhido por um atalho real;
7. opções inválidas oferecem um caminho de recuperação sem poluir stdout;
8. frames completos protegem os estados visuais principais;
9. reduced motion, fallback ASCII, resize, mouse e seleção continuam funcionando;
10. testes focados, typecheck, `check:fast` e `check` passam, ou qualquer bloqueio externo é registrado separadamente como WIP não relacionado.

## 11. Ordem recomendada e dependências

```text
Tarefa 0 — baseline/WIP
   │
   ├─> Tarefa 1 — registro efetivo
   │      ├─> Tarefa 2 — paleta estruturada
   │      └─> Tarefa 3 — help unificado
   │
   ├─> Tarefa 4 — startup
   ├─> Tarefa 5 — contraste
   ├─> Tarefa 6 — thinking
   └─> Tarefa 7 — argumentos
          │
          └─> Tarefa 8 — goldens após estabilizar a saída
```

Tarefas 4, 5, 6 e 7 são independentes entre si. Tarefas 2 e 3 dependem do registro efetivo criado na Tarefa 1. Os goldens devem ser produzidos por último para registrar o comportamento final, não uma etapa intermediária.

## 12. Riscos e mitigação

| Risco | Mitigação |
|---|---|
| Cabeçalhos quebrarem mouse/scroll no `SelectList` | Tornar metadata opcional e testar hit-test com linhas não selecionáveis. |
| Nova ordenação esconder comandos dinâmicos | Prioridade só no prefixo vazio; busca digitada continua ranqueando por correspondência. |
| Ajuda ficar lenta com centenas de comandos | Construir o registro uma vez por refresh de recursos e filtrar localmente. |
| Startup interativa conflitar com o editor | Neste ciclo, usar rótulo explícito e não capturar teclas. |
| Aumento de contraste achatar a hierarquia | Alterar somente tokens acionáveis, preservando `dim` decorativo. |
| Ctrl+O ficar imprevisível | Expandir o conteúdo recolhido mais recente e cobrir a ordem do ciclo em teste. |
| Goldens frágeis | Congelar dados voláteis, normalizar ANSI/OSC e limitar a matriz a estados de alto valor. |
| Sobreposição com WIP atual | Aplicar patches por fatia, inspecionar diff antes/depois e nunca restaurar o arquivo inteiro. |

## 13. Fora de escopo

- mudar a identidade visual, mascote ou linguagem de cores do Pit;
- substituir a TUI por Ink, Blessed, Bubble Tea ou interface gráfica;
- redesenhar o sistema de sessões;
- tornar todo texto `dim` acessível como conteúdo principal;
- persistir ranking de comandos com telemetria;
- alterar protocolo de providers, ferramentas ou compactação;
- refatorar `interactive-mode.ts` além das extrações diretamente necessárias;
- editar `CHANGELOG.md`.

## 14. Resultado esperado

Depois dessas correções, o Pit mantém a aparência compacta e a robustez atual, mas passa a orientar melhor o usuário. Recursos importantes deixam de se perder entre dezenas de comandos, ajuda e atalhos deixam de contaminar a conversa, a startup para de sugerir ações inexistentes, dicas ficam legíveis e conteúdo dobrado ganha um caminho de retorno.

O ganho principal não é adicionar mais interface. É fazer a interface já existente explicar melhor o que o Pit sabe fazer.
