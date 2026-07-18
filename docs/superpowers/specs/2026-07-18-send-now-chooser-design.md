# Chooser "[Send now] [Queue] [Cancel]" ao submeter durante um turno ativo

## Objetivo

Deixar o usuário mandar um insight **durante** o trabalho do agente e escolher, na
hora, se ele deve ser lido **imediatamente** no turno corrente ou enfileirado para o
próximo — sem interromper nada e sem perder o que foi digitado. O mecanismo de core
(steering mid-turn) já existe; esta entrega é UX + roteamento + bordas.

Supersede a decisão do spec [2026-07-15-pit-input-queue-design.md](2026-07-15-pit-input-queue-design.md)
em que `Enter` durante trabalho enfileirava direto como `followUp`. Aquele
comportamento permanece disponível sob `PIT_NO_SEND_NOW=1`.

## Comportamento

Quando o usuário dá **Enter** com texto no compositor durante trabalho ativo
(`isStreaming || isFusing`), em vez de enfileirar direto aparece um chooser inline
compacto (uma linha, estilo Grok CLI) logo acima da caixa de digitação:

```text
#1 <texto da mensagem truncado…>   [Send now] [Queue] [Cancel]
←/→ choose · enter confirm · esc cancel
```

- **Send now** (realçado ao abrir): entrega para leitura imediata no turno corrente
  → `prompt(text, { streamingBehavior: "steer" })`. A mensagem é lida no próximo
  *step boundary* do turno, sem abortar nada. **Exceção Fusion:** se `isFusing` no
  momento da confirmação, degrada para `followUp` com aviso discreto no rodapé
  (`"Fusion turn — delivered at end of turn"`), porque o turno de Fusion roda fora do
  agent-loop e não há step boundary para injetar o steer.
- **Queue:** comportamento legado → `prompt(text, { streamingBehavior: "followUp" })`.
- **Cancel:** fecha o chooser e devolve o texto **intacto** ao compositor.

## Foco e roteamento de teclado

O foco **permanece no editor** o tempo todo. O chooser é um componente puramente
apresentacional (`send-now-chooser.ts`) que guarda o índice realçado e o texto. Um
*input listener* global (`ui.addInputListener`, o mesmo mecanismo do cheatsheet) é
instalado ao abrir e roda **antes** do componente focado:

- `←` = anterior; `→` / `Tab` = próximo; `Enter` = confirma o realçado; `Esc` = Cancel.
  Todos consumidos (`{ consume: true }`).
- **Qualquer outra tecla** (caractere imprimível incluso) = Cancel implícito: o
  listener fecha o chooser e retorna `undefined`, deixando a tecla **fluir para o
  compositor** — digitar fecha o chooser e continua editando sem fricção.
- Como `Esc` é consumido pelo listener, ele **nunca** chega ao `onEscape` do editor,
  então não dispara o interrupt do turno.

### Preservação do texto no Cancel

O editor **limpa o próprio buffer em `submitValue()` antes de chamar `onSubmit`**, logo
o texto já não está no compositor quando o chooser abre. Ao abrir, o chooser
**re-assenta** o texto no editor (`editor.setText(text)`): assim ele fica visível, o
Cancel é trivial (nada a restaurar) e o Cancel implícito por digitação anexa o
caractere ao texto já presente. Não há cópia duplicada do texto para reconciliar — o
editor é a única fonte da verdade; o chooser só guarda o texto para a confirmação.

## Bordas

- **Turno termina com o chooser aberto:** o chooser é mantido. A degradação de Fusion
  é decidida **no momento da confirmação** (o estado pode ter mudado). Se o agente
  ficou idle, `session.prompt(text, { streamingBehavior })` ignora o `streamingBehavior`
  (o guard `isStreaming || isFusing` não dispara) e inicia um turno normal —
  naturalmente, sem decisão automática pelo usuário.
- **Alt+Enter** (`handleFollowUp`) continua enfileirando **direto** sem chooser
  (atalho explícito de quem já sabe o que quer). `/steer` continua como hoje.
- **Enter idle** (sem trabalho) não muda.
- **Mensagens especiais não passam pelo chooser:** slash commands, bash `!` e o caminho
  de fila de compactação mantêm o comportamento atual — o chooser só se aplica ao ramo
  de mensagem normal durante trabalho (essas rotas retornam antes desse ramo).

## Feedback pós-envio

O steer/followUp pendente já aparece no display de fila existente
(`PendingUserMessageComponent` via `updatePendingMessagesDisplay`, que lê
`session.getSteeringMessages()` + `getFollowUpMessages()`), e o steer é exibido no
transcript quando drenado pelo loop. Nenhuma mudança nova de exibição foi necessária.

## Kill-switch

`PIT_NO_SEND_NOW=1` desliga o chooser e restaura o comportamento legado (Enter durante
trabalho → `followUp` direto). Nativo on-by-default, no estilo do projeto. Documentado
em [token-economy-tuning.md](../../token-economy-tuning.md).

## Testes

- `test/interactive-mode-send-now-chooser.test.ts`: abrir vs. kill-switch, confirmação
  Send now/Queue/Cancel, navegação ←/→/Tab, caractere imprimível = passthrough, degradação
  em Fusion, confirmação com turno idle, Esc não interrompe, Alt+Enter direto.
- `test/interactive-mode-input-queue.test.ts`: o caso legado de `Enter → followUp`
  passou a rodar sob `PIT_NO_SEND_NOW=1`.

## Limitação conhecida

Se um seletor mid-turn (ex.: pedido da ferramenta `ask`) abrir enquanto o chooser está
aberto, a primeira tecla de navegação do chooser (`←/→/Tab/Enter/Esc`) é interceptada
pelo listener do chooser antes do seletor; qualquer outra tecla fecha o chooser e passa
adiante. É uma corrida rara (o chooser é efêmero, o usuário está decidindo) e foi
deixada de fora deliberadamente para não duplicar o sistema de foco.
