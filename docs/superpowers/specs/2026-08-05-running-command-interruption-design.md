# Interrupção navegável de comandos em execução

## Objetivo

Permitir que o usuário saia do compositor com as setas, selecione um comando em execução e o interrompa com Enter. A saída produzida até a interrupção deve voltar ao agente como resultado da ferramenta, sem encerrar o turno inteiro.

## Interação

- Quando o compositor estiver vazio, `↑` transfere o foco para o comando em execução mais próximo.
- Na área de execução, `↑` e `↓` percorrem os comandos.
- `↓` depois do último comando devolve o foco ao compositor.
- `Enter` abre as ações do comando selecionado.
- No menu, `↑` e `↓` selecionam a ação e `Enter` confirma.
- As ações são `Ver saída`, `Interromper e devolver saída` e `Continuar rodando`.
- `Alt+J` e `/jobs` continuam abrindo diretamente o painel existente.

As setas do compositor não mudam de significado enquanto houver texto, seleção ou navegação interna possível. Isso preserva edição multilinha e histórico.

## Fluxos de interrupção

### Ferramenta foreground

Usar o cancelamento individual por `toolCallId`. O agente continua o turno e recebe o resultado abortado com a saída acumulada pelo executor Bash.

### Job background

Parar a árvore de processos com espera limitada, manter o registro até obter o último snapshot da saída e só então remover o job. O evento entregue à sessão inclui comando, tempo decorrido, saída parcial, indicação de truncamento e resultado da finalização.

## Estados excepcionais

- Se o comando terminar antes da confirmação, exibir o resultado final em vez de tentar interrompê-lo novamente.
- Se não houver saída, informar explicitamente que o comando foi interrompido sem saída capturada.
- Se a árvore não terminar dentro do limite, informar a falha de limpeza ao usuário e ao agente sem bloquear a interface.
- A saída enviada ao modelo permanece limitada pelo mesmo orçamento usado nos jobs background.

## Validação

- Navegação compositor → comando → compositor usando setas.
- Seleção e confirmação usando Enter.
- Cancelamento de uma única ferramenta foreground sem abortar o turno.
- Interrupção de job background com saída parcial entregue ao agente.
- Casos sem saída, saída truncada, término concorrente e timeout de encerramento.
- Compatibilidade de `/jobs`, `Alt+J`, mouse e Windows.

## Correções de robustez aprovadas

- A superfície de foreground mostra apenas comandos Bash, cuja interrupção é
  cooperativa e consegue produzir um resultado final de cancelamento.
- O runtime aguarda por tempo limitado o resultado cooperativo de um cancelamento
  individual. Abort do turno inteiro continua desbloqueando imediatamente.
- O menu de ações mantém a identidade do comando. Se o item terminar durante a
  atualização, o menu volta para a lista e nunca transfere a ação para outro item.
- Um job background cuja terminação não foi confirmada permanece registrado,
  visível e passível de nova consulta ou interrupção; ele só é removido após a
  confirmação de saída.
- Cada job promovido registra a sessão proprietária. Eventos de saída/interrupção
  só podem ser injetados na sessão correspondente.
- A mensagem da UI descreve solicitação de interrupção enquanto o resultado ainda
  está sendo apurado, sem afirmar antecipadamente que a saída já foi devolvida.
