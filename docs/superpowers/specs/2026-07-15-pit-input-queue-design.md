# Caixa de digitação e fila previsível do Pit

> **Nota (2026-07-18):** o comportamento "`Enter` durante trabalho = `followUp` direto"
> descrito abaixo foi **superseded** pelo chooser inline `[Send now] [Queue] [Cancel]`
> — ver [2026-07-18-send-now-chooser-design.md](2026-07-18-send-now-chooser-design.md).
> O design original permanece válido sob o kill-switch `PIT_NO_SEND_NOW=1`.

## Objetivo

Entregar a primeira fase de `GROK_PIT-AMPO.md`: substituir a linha de entrada atual por uma caixa fechada inspirada no AMP e fazer o envio comum durante uma execução entrar na fila, sem duplicar editor, fila ou metadados.

## Limites

Esta entrega inclui:

- moldura fechada na caixa de digitação do Pit;
- `Enter` enfileirando uma mensagem posterior quando o agente estiver trabalhando;
- `/steer <mensagem>` como orientação explícita do turno atual;
- fila FIFO, uma mensagem por novo turno;
- pendências restauradas como rascunhos após retomada da sessão;
- reutilização do rodapé atual para modo, modelo e workspace.

Esta entrega não inclui globo, nova abertura, painel de tarefas, painel de agentes ou restauração de arquivos.

## Decisão de arquitetura

### Caixa fechada

O `Editor` de `@pit/tui` recebe uma opção de moldura fechada. Quando ativa, ele desenha cantos e laterais dentro da largura informada:

```text
╭────────────────────────────╮
│  Digite uma tarefa…        │
╰────────────────────────────╯
```

O coding agent ativa essa opção diretamente no editor padrão. Não haverá wrapper, segundo editor ou configuração para alternar entre o visual antigo e o novo. Outros consumidores de `@pit/tui` preservam o comportamento atual enquanto não solicitarem a moldura.

A largura útil desconta as duas laterais antes do wrap. Cursor, placeholder, texto multilinha, busca no histórico e autocomplete continuam pertencendo ao mesmo `Editor`.

### Roteamento da mensagem

O manipulador atual continua sendo o único ponto de envio:

- agente ocioso: `Enter` inicia um turno normal;
- agente trabalhando: `Enter` chama a rota `followUp` já existente;
- compactação ativa: envio comum entra na fila de compactação como `followUp`;
- `/steer <mensagem>` e a ação remapeável `app.message.steer` chamam explicitamente a rota `steer`; a ação não recebe atalho padrão;
- `Esc` apenas interrompe; enviar depois exige nova ação.

`Alt+Enter` permanece como compatibilidade e produz o mesmo resultado do envio comum durante execução. Nenhuma fila nova será criada.

### Exibição e metadados

O componente atual de mensagens pendentes continua mostrando cada item e a ação para restaurá-los ao editor. O rodapé existente continua sendo a fonte de modo, modelo, nível de raciocínio, diretório e branch. A entrega não cria uma segunda barra de estado.

### Persistência como rascunho

Quando o conjunto de mensagens posteriores muda, o estado pendente é salvo como entrada customizada no arquivo append-only da sessão. O registro contém somente texto e ordem.

Na retomada, o snapshot mais recente do ramo atual é lido. As mensagens são colocadas no editor como um rascunho único, na ordem original, e o snapshot persistido é limpo. Elas não entram novamente na fila e não são enviadas automaticamente.

Sessões em memória continuam funcionando sem persistência. Falha ao persistir não cancela a execução nem perde a fila em memória; ela é apresentada como aviso.

## Compatibilidade com trabalho existente

Há alterações locais nos mesmos arquivos de editor e modo interativo. A implementação deve preservar mudanças não relacionadas e substituir somente a decisão visual da linha reta pela moldura fechada. Não será usado reset, checkout destrutivo ou refatoração ampla.

## Testes

- `Editor`: moldura, largura visível, wrap, placeholder, multiline, scroll e autocomplete.
- modo interativo: `Enter` usa `followUp` durante streaming e durante compactação.
- comando: `/steer` rejeita texto vazio e orienta o turno atual sem abortar.
- fila: FIFO e uma mensagem por turno permanecem cobertos pelo runtime existente.
- persistência: snapshot mais recente do ramo é restaurado como rascunho e limpo sem autoenvio.
- regressão: testes focados de `@pit/tui` e `@pit/coding-agent`, verificação estática dos arquivos tocados e benchmark de render do TUI.

## Critérios de aceite

- A caixa do Pit possui quatro lados e não perde nenhuma função atual do editor.
- Durante trabalho ativo, `Enter` não altera o turno corrente.
- A mensagem aparece imediatamente como pendente e é entregue somente depois do turno anterior.
- Orientar o turno exige `/steer` ou ação remapeável dedicada.
- Retomar uma sessão nunca envia pendências antigas automaticamente.
- A implementação usa as estruturas atuais e não introduz editor, fila ou barra de metadados paralelos.
