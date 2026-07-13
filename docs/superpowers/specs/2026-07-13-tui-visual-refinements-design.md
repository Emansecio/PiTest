# Refinamentos visuais da TUI do Pit

## Objetivo

Melhorar legibilidade, hierarquia e densidade da TUI observada em terminais largos, sem redesenhar a interface nem alterar o fluxo do agente.

## Decisões

### 1. Coluna de leitura

- A prosa do assistente continuará alinhada à esquerda.
- O limite padrão passará de 100 para 120 colunas; terminais menores continuarão usando toda a largura disponível.
- `assistantReadingColumns: 0` continuará significando largura total, e valores positivos explícitos continuarão sendo respeitados.

### 2. Estado ativo

- A linha transitória acima do editor será a fonte principal de fase, tempo e atalho de interrupção.
- Linhas de atividade no histórico continuarão registrando ferramentas, mas não repetirão sinais transitórios já mostrados pelo loader.
- A integração preservará as mudanças locais já existentes em `activity-line.ts` e `interactive-mode.ts`.

### 3. Telemetria

- A linha `done` deixará de repetir o percentual de contexto, já exibido no rodapé.
- Tempo, tokens e custo do turno permanecerão na linha `done`, pois não possuem equivalente persistente no rodapé e são úteis para diagnóstico.
- Nenhuma nova configuração ou modo de telemetria será criado.

### 4. Separação entre turnos

- A régua continuará indicando mudança de turno, mas será limitada à mesma largura visual da leitura em terminais largos.
- O espaçamento atual será preservado; não serão introduzidos cards ou fundos por mensagem.

### 5. Tabelas Markdown

- Bordas usarão a cor semântica de borda discreta do tema.
- Cabeçalhos manterão contraste superior ao corpo.
- Cálculo de largura, quebra de células, fallback estreito e estrutura dos caracteres da tabela permanecerão inalterados.

## Arquivos previstos

- `packages/coding-agent/src/modes/interactive/components/assistant-message.ts`
- `packages/coding-agent/src/core/settings-manager.ts`
- `packages/coding-agent/src/modes/interactive/turn-done-format.ts`
- `packages/coding-agent/src/modes/interactive/components/turn-rule.ts`
- `packages/coding-agent/src/modes/interactive/components/activity-line.ts`, somente se a inspeção confirmar duplicação transitória real
- `packages/tui/src/components/markdown.ts`
- testes focados correspondentes em `packages/coding-agent/test` e `packages/tui/test`

## Validação

- Testes de largura da prosa em terminais estreitos e largos.
- Testes da linha `done` sem `ctx`, preservando tempo, tokens e custo.
- Testes da régua compacta e responsiva.
- Testes ANSI de tabela para confirmar borda discreta sem alterar a geometria.
- Testes existentes das áreas tocadas e, em seguida, o gate rápido do projeto quando não houver bloqueio de baseline.

## Fora de escopo

- Centralizar mensagens.
- Colocar mensagens em cards.
- Refatorar a arquitetura geral de status, footer ou activity stack.
- Alterar desempenho, protocolo de renderização ou comportamento de ferramentas.
