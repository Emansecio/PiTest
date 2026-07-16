# GROK_PIT-AMPO — proposta unificada de evolução do Pit

## Objetivo

Esta especificação reúne em uma única direção de produto as oportunidades operacionais observadas no Grok Build e a proposta visual inspirada no AMP. O objetivo é evoluir o Pit como uma interface de trabalho completa: mais clara ao abrir, mais refinada ao digitar e mais controlável enquanto agentes, ferramentas e processos executam.

Leitor esperado: mantenedores e contribuidores do Pit. Depois da leitura, deve ser possível decompor a proposta em entregas implementáveis sem decidir novamente seu comportamento, seus limites ou sua adaptação a diferentes terminais.

## Estado de implementação — 15/07/2026

- **Fase 1 entregue:** caixa de digitação, estados auxiliares e metadados reunidos em um único retângulo completo no verde de destaque do Pit; envio durante execução direcionado à fila `follow-up`, `/steer` explícito e recuperação de pendências como rascunho após reinício.
- **Fase 2 entregue:** a abertura anterior foi substituída pelo `StartupScreen` com globo animado responsivo. Ele aparece em cada ativação interativa, oculta temporariamente o histórico e desaparece na primeira mensagem real enviada, enfileirada ou respondida.
- **Validação concluída:** testes do editor, roteamento de `Enter`/`follow-up`/`steer`, persistência, ciclo de vida da abertura, verificação estática e suíte unitária rápida completa.
- **Ainda não implementado:** painel unificado de tarefas, seleção do histórico, painel de agentes/sessões, revisão visual de planos e restauração transacional de conversa/arquivos. Essas frentes permanecem nas Fases 3 a 5 e não devem ser confundidas com a entrega visual atual.
- **Decisão de escopo:** a implementação recomendada termina nas Fases 1 e 2. As Fases 3 a 5 são propostas independentes e só devem começar mediante decisão específica; não são pendências necessárias para liberar a nova entrada.

## Escopo e fontes

A análise do Grok Build usa a publicação pública `xai-org/grok-build`, no commit `b189869b7755d2b482969acf6c92da3ecfeffd36`, de 15 de julho de 2026. O projeto informa que o repositório é sincronizado periodicamente a partir do monorepo da xAI e pode não representar integralmente o produto interno.

Fontes principais:

- [Repositório e visão geral](https://github.com/xai-org/grok-build)
- [Atalhos e interação durante uma execução](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/03-keyboard-shortcuts.md)
- [Sessões, checkpoints e rewind](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/17-sessions.md)
- [Tarefas em background](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/20-background-tasks.md)
- [Dashboard de agentes](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/23-dashboard.md)
- [Revisão de planos](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/19-plan-mode.md)
- [Comandos, incluindo `/btw`](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/04-slash-commands.md)

A referência AMP é formada pelas imagens fornecidas para esta proposta e pelo protótipo local `spinning-ascii-globe-animation`.

## Visão unificada

GROK_PIT-AMPO não é um tema. É uma evolução coordenada de quatro superfícies:

1. **Entrada** — nova tela inicial, identidade visual e caixa de digitação refinada.
2. **Execução** — tarefas, jobs, mensagens pendentes e estados claramente observáveis.
3. **Coordenação** — painel para agentes e sessões concorrentes.
4. **Histórico e controle** — histórico selecionável (`scrollback` no código), revisão de planos e restauração segura (`rewind` no código).

O Pit não precisa copiar a aparência do Grok Build nem reproduzir literalmente o AMP. A proposta combina a clareza visual do AMP com o modelo de operação do Grok, preservando a arquitetura, os modos e a identidade do Pit.

## Princípios

- Reaproveitar runtime e componentes existentes antes de criar novas abstrações.
- Tornar estado e destino de cada ação visíveis.
- Manter teclado como caminho completo de operação.
- Separar claramente enfileirar, orientar o turno atual e interromper.
- Não sacrificar histórico, editor ou performance por animação.
- Tratar restauração como operação de dados de alto risco, isolada das melhorias visuais.
- Entregar em incrementos verticais que já tenham utilidade própria.
- Substituir o comportamento anterior diretamente depois dos critérios de liberação; não manter sinalizadores de recurso (`feature flags`) ou duas interfaces permanentes.
- Manter cada entrega isolada e reversível como unidade de reversão.
- Usar português claro na documentação e apresentar nomes internos somente na primeira ocorrência.

## Capacidades atuais que devem ser preservadas

Estas capacidades já existem e não devem ser reimplementadas como se fossem novas:

- filas internas de orientação do turno (`steer`) e mensagem posterior (`follow-up`);
- execução básica de comandos em background com identificador de job;
- busca de sessões por metadados e conteúdo;
- modos headless e RPC;
- Plan versionado com dependências, verificação, aprovação e feedback;
- Coordinator, subagentes, paralelismo e worktrees;
- extensões, skills, templates e temas;
- editor multiline com histórico, undo/redo, autocomplete, anexos e paste.

## Matriz de prioridades

| Prioridade | Frente | Estado atual | Esforço | Risco |
|---|---|---|---|---|
| 1 | Caixa de digitação refinada e fila | Editor e mensagem posterior existentes | Médio | Baixo/médio |
| 2 | Nova tela inicial e globo | Área de abertura e protótipo existentes | Médio | Baixo/médio |
| 3 | Painel unificado de tarefas | Runtime parcial, sem superfície central | Médio | Médio |
| 4 | Histórico selecionável | Histórico virtualizado, ações globais | Médio | Médio |
| 5 | Painel de agentes | Coordinator existente, sem visão central | Médio/alto | Médio/alto |
| 6 | Revisão visual de planos | Backend completo, aprovação textual | Médio | Médio |
| 7 | Restauração de conversa e arquivos | Exige design e prova de conceito próprios | Alto | Alto |

## Estratégia de entrega e reversão

GROK_PIT-AMPO é uma visão única executada por entregas independentes. Não é uma única implementação nem uma única versão.

- Cada entrega possui escopo, testes, critérios de liberação e reversão próprios.
- Depois de aprovada, a entrega substitui diretamente o comportamento anterior.
- Não haverá sinalizador temporário ou opção permanente entre interface antiga e nova.
- A implementação anterior não permanece escondida no runtime.
- Se houver regressão depois da troca, a entrega inteira é revertida; não se exige correção emergencial sobre uma base instável.
- Uma entrega não pode depender da conclusão de fases posteriores para ser útil ou segura.

## Frente operacional inspirada no Grok Build

### Painel unificado de tarefas

#### Valor

Dar ao usuário uma visão única do trabalho que continua fora do fluxo principal: comandos em background, verificações, monitores e subagentes.

#### Estado atual

O Pit mantém registro de jobs em background e operações internas para listar, consultar e encerrar processos. O Coordinator conhece o estado dos agentes. Essas informações ainda não formam uma superfície operacional única na TUI.

#### Proposta

- Abrir um painel de tarefas por atalho e comando.
- Agrupar itens por `executando`, `aguardando`, `concluído` e `falhou`.
- Mostrar tipo, nome, duração, origem e resumo do estado.
- Permitir abrir a saída, acompanhar atualizações, aguardar e encerrar.
- Manter jobs e agentes identificáveis depois de fechar e reabrir o painel.
- Expor ao agente ferramentas explícitas para listar, ler, aguardar e encerrar jobs.
- Mostrar somente trabalhos filhos da sessão atual: processos, verificações e subagentes iniciados por ela.

#### Critérios de aceite

- Um comando iniciado em background aparece imediatamente.
- A saída pode ser consultada sem bloquear a interface.
- Encerrar um item atua somente sobre o job selecionado.
- Subagentes e jobs usam estados visuais consistentes.
- Falhas e saídas truncadas são indicadas claramente.
- Trabalhos de outras sessões não aparecem nem podem ser controlados por este painel.

Risco: **médio**. O cuidado principal é evitar duas fontes de verdade para o mesmo estado.

### Histórico selecionável e ações por bloco

#### Valor

Transformar o histórico de uma saída passiva em uma interface navegável.

#### Estado atual

O Pit virtualiza o histórico e permite expandir ou recolher categorias, mas as ações ainda são predominantemente globais. Não há foco persistente em um bloco individual.

#### Proposta

- Alternar o foco entre caixa de digitação e histórico.
- Navegar por mensagens, raciocínios e chamadas de ferramenta.
- Expandir ou recolher somente o bloco selecionado.
- Copiar conteúdo ou metadados do bloco.
- Abrir conteúdo extenso em visualizador de tela cheia.
- Pesquisar no histórico renderizado.
- Preservar posição, seleção e expansão durante streaming.

#### Critérios de aceite

- Todo o fluxo funciona por teclado.
- Atualizações novas não deslocam a seleção arbitrariamente.
- Copiar uma saída não inclui bordas ou decoração.
- Blocos grandes continuam usando renderização limitada ou virtualizada.
- O comando global de expandir ou recolher permanece disponível.

Risco: **médio**. Exige identidade estável por bloco e integração cuidadosa com a virtualização.

### Mensagens enviadas enquanto o agente trabalha

#### Comportamento obrigatório

Quando o usuário envia uma mensagem durante uma execução ativa, ela não é entregue ao turno em andamento. Ela entra em uma fila e aguarda o turno atual terminar. Ferramentas, processos em background e subagentes continuam normalmente.

Na próxima fronteira de turno, a primeira mensagem da fila é enviada como nova mensagem do usuário. Várias mensagens seguem ordem FIFO, salvo reordenação explícita.

#### Estado atual

O Pit possui duas rotas:

1. **Orientação do turno (`steer`)** — `Enter` durante streaming insere a mensagem antes da próxima chamada ao modelo dentro da execução atual. Não aborta a ferramenta, mas pode alterar o mesmo turno.
2. **Mensagem posterior (`follow-up`)** — `Alt+Enter` espera o término lógico do turno e só então inicia a continuação.

O comportamento desejado corresponde à mensagem posterior. A fila deve se tornar o comportamento padrão do envio durante execução; orientar o turno atual permanece uma ação separada e explícita.

#### Semântica

| Situação | Ação | Resultado |
|---|---|---|
| Agente ocioso | `Enter` | Inicia um turno normalmente |
| Agente trabalhando | `Enter` | Coloca a mensagem na fila |
| Agente trabalhando | `Orientar tarefa atual` | Agenda orientação para a próxima decisão do modelo |
| Agente trabalhando | `Esc` | Cancela explicitamente o turno; o envio exige uma segunda ação |
| Há mensagens pendentes | Abrir fila | Permite inspecionar, editar, remover e reordenar |

#### Proposta

- Fazer `Enter` durante execução usar mensagem posterior por padrão.
- Confirmar com `Mensagem adicionada à fila`.
- Mostrar tipo, posição, estado e destino de cada item.
- Permitir selecionar, editar, remover e reordenar itens não entregues.
- Manter ação explícita para orientar o turno e outra para interrupção.
- No painel de agentes, enfileirar automaticamente mensagens para agentes ocupados.
- Preservar fila durante compaction, retry e mudanças de foco.
- Persistir itens ainda não entregues quando a sessão encerrar inesperadamente.
- Ao retomar, restaurar esses itens como rascunhos; nada é reenviado sem confirmação.

#### Estados e invariantes

Estados: `na fila`, `enviando`, `entregue`, `falhou` e `cancelada`.

- Envio comum durante trabalho nunca chama abort.
- Mensagem na fila não entra no contexto do turno atual.
- A ferramenta atual termina normalmente.
- A entrega acontece somente uma vez.
- Mensagens não desaparecem silenciosamente.
- TUI e RPC compartilham a mesma semântica.
- Durante a mesma execução, a fila drena automaticamente em FIFO, uma mensagem por novo turno.
- Fila restaurada de outra execução nunca drena automaticamente.

#### Critérios de aceite

- Durante ferramenta demorada, `Enter` não cancela nem altera o turno atual.
- A mensagem aparece imediatamente como `na fila`.
- A entrega ocorre somente após o término lógico do turno anterior.
- É possível editar ou remover item ainda não entregue.
- A fila sobrevive a compaction e retry.
- Após reinício, itens reaparecem como rascunhos e exigem confirmação.
- Testes distinguem envio comum, orientação do turno e interrupção.

#### Ações explícitas

- Orientar a tarefa atual (`steer`) fica disponível por `/steer <mensagem>` e por uma ação remapeável, sem atalho global obrigatório.
- Interromper não possui chord de envio imediato: `Esc` cancela o turno e o usuário envia a nova mensagem em uma segunda ação.
- O envio comum nunca reutiliza silenciosamente nenhuma dessas duas rotas.

Risco: **baixo** para mudar a rota padrão; **médio** para painel, reordenação e persistência.

### Painel de agentes e sessões

#### Valor

Tornar o Coordinator observável e operável sem exigir identificadores ou comandos memorizados.

#### Proposta

- Agrupar agentes em `trabalhando`, `aguardando resposta`, `ociosos`, `concluídos` e `falhos`.
- Mostrar tarefa, duração, última atividade e workspace.
- Abrir prévia sem anexar à sessão.
- Anexar à conversa completa do agente.
- Enviar ou enfileirar mensagens para o agente selecionado.
- Responder perguntas e aprovações pendentes.
- Criar novos agentes pelo mesmo painel.
- Quando o agente estiver esperando pergunta ou aprovação, trocar a entrada comum por uma ação explícita de `Responder`.
- Para enfileirar outro assunto enquanto há um bloqueio, exigir uma ação separada.

#### Critérios de aceite

- O painel reflete mudanças sem polling agressivo.
- Mensagem para agente ocupado entra na fila sem cancelar trabalho.
- Ações mostram claramente agente e workspace de destino.
- Apenas sessões pertencentes à instância atual são controladas automaticamente.
- Sessões de outra instância não podem receber comandos concorrentes; se forem exibidas, aparecem somente para leitura.

Risco: **médio/alto**, concentrado em sincronização, identidade e limites entre workspaces.

### Revisão visual de planos

O Pit já tem o backend necessário. A melhoria é uma superfície de revisão:

- prévia rolável de tela cheia;
- navegação por etapas e dependências;
- comentário ligado a etapa específica;
- solicitação de alterações com comentários estruturados;
- aprovação somente por ação explícita.

O modo continua somente leitura até aprovação. Todo comentário aberto bloqueia a aprovação até ser resolvido ou descartado explicitamente pelo usuário. O plano aprovado deve ser exatamente o exibido, e comentários precisam sobreviver às revisões.

Risco: **médio**.

### Restauração de conversa e arquivos

#### Valor

Permitir experimentar uma abordagem e voltar a um ponto anterior sem reconstruir manualmente a sessão.

#### Estado atual

O Pit possui árvore de sessão e mudança de ramo conversacional, mas não registra snapshots dos arquivos modificados.

#### Proposta

- Antes da implementação, produzir uma especificação dedicada e uma prova de conceito somente leitura para medir cobertura e custo de captura.
- Criar ponto de restauração (`checkpoint` no código) por mensagem do usuário.
- Usar armazenamento próprio do Pit, baseado em conteúdo e independente de Git.
- Capturar toda alteração iniciada pelo agente, inclusive mudanças produzidas por comandos de terminal.
- Exibir prévia de arquivos criados, modificados e removidos.
- Restaurar conversa e workspace como operação única.
- Preferir criar ramo a destruir o ramo atual.
- Proteger arquivos modificados antes da sessão.
- Definir retenção e limite de armazenamento.

#### Critérios de aceite

- A prévia corresponde exatamente às mudanças aplicadas.
- Arquivos anteriores não são sobrescritos silenciosamente.
- Falha parcial não separa estado da conversa e do workspace.
- É possível retornar ao estado posterior quando a restauração cria ramo.
- Binários e arquivos grandes têm política explícita.
- Se o estado atual de qualquer arquivo divergir do esperado, abortar a restauração inteira e mostrar conflitos.
- Se um ponto de restauração não puder ser completo ou exceder o orçamento, marcar o ponto como `não restaurável` e permitir que a tarefa continue.
- Nunca oferecer restauração parcial como se fosse segura.

Risco: **alto**. A fase de restauração só pode entrar em planejamento de implementação depois que o design dedicado e a prova de conceito somente leitura forem aprovados.

## Decisões da frente visual

- A abertura aparece a cada ativação interativa de sessão: inicialização, retomada, `/new` e anexação ou troca de sessão.
- Em sessões retomadas, a abertura é temporária e oculta visualmente o histórico já carregado até a primeira nova mensagem dessa ativação.
- Um prompt inicial fornecido pela linha de comando conta como primeira mensagem e pula a abertura, evitando um lampejo da tela.
- O layout usa o AMP como referência, mas preserva identidade, modos e linguagem do Pit.
- O globo de `spinning-ascii-globe-animation` sempre gira, inclusive em terminais estreitos e quando o ambiente indica movimento reduzido.
- A abertura desaparece somente quando uma mensagem real ao agente é enviada ou enfileirada. Comandos, ajuda e painéis não encerram a abertura.
- Depois dessa primeira mensagem, a área de abertura desaparece, o histórico é revelado e a sessão assume o fluxo normal de conversa.
- A implementação será nativa na TUI; React, Vite e Tailwind não entram no runtime do Pit.
- A caixa de digitação atual continua sendo o motor de edição. A mudança principal está em sua composição visual e nos metadados ao redor dela.

## Resultado esperado

Ao ativar uma sessão interativa sem prompt inicial já submetido, o usuário encontra uma tela calma e intencional:

- globo ASCII animado à esquerda;
- boas-vindas e ajuda essencial à direita;
- espaço livre suficiente para evitar aparência de painel congestionado;
- divisor discreto separando identidade e ação;
- caixa de digitação ampla e claramente focada no rodapé;
- modo e nível de raciocínio, além do workspace, visíveis de forma adaptativa; modelo e fila aparecem apenas quando relevantes.

A tela deve comunicar três coisas imediatamente: **onde o usuário está**, **como começar** e **em qual configuração o agente executará**.

## Referência visual

As imagens do AMP fornecidas para esta proposta estabelecem estes princípios:

- hierarquia baseada em espaço, não em muitas bordas;
- área de abertura assimétrica em duas colunas;
- animação pequena como identidade, sem dominar a tela;
- ajuda curta e contextual;
- divisor horizontal antes da área de ação;
- caixa de entrada larga, baixa e com borda sutil;
- metadados fora do buffer editável, mas dentro da mesma moldura visual;
- paleta escura com poucos acentos luminosos.

Não devem ser copiados literalmente o nome AMP, sua frase de boas-vindas, sua paleta exata ou a moldura gráfica de uma janela macOS.

## Abordagens consideradas

### 1. Composição nativa na TUI — escolhida

Reutiliza o editor, o sistema de temas, o render diferencial, o foco e o ticker do Pit. O globo é convertido em componente TUI. É a opção com menor risco arquitetural e mantém a CLI portátil.

### 2. Tela fornecida por extensão ou tema

Oferece isolamento, mas não controla com consistência o ciclo da tela inicial, a caixa de digitação permanente e a transição para a conversa. Pode permanecer como extensão futura, mas não é a base recomendada.

### 3. Incorporação da aplicação React

Preservaria o protótipo quase literalmente, porém criaria um segundo sistema de renderização e adicionaria dependências sem necessidade. Foi descartada.

## Composição da tela

### Estrutura ampla

Em largura suficiente, a tela segue esta composição:

```text
┌──────────────────────────────────────────────────────────────────────┐
│                                                                      │
│          globo ASCII              Bem-vindo ao Pit                   │
│          animado                  /help para ajuda                    │
│                                                                      │
│──────────────────────────────────────────────────────────────────────│
│                                                     auto · modelo    │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  Digite uma tarefa…                                            │  │
│  └────────────────────────────────────────────────────────────────┘  │
│  anexos · fila                                      cwd · branch     │
└──────────────────────────────────────────────────────────────────────┘
```

O desenho representa regiões funcionais, não caracteres obrigatórios. A TUI deve usar as primitivas e o tema do Pit.

### Área de abertura

A área de abertura ocupa o espaço disponível acima da caixa de digitação sem empurrá-la para fora da tela.

- O globo fica à esquerda e não recebe foco.
- O texto fica à direita, alinhado verticalmente ao centro visual do globo.
- O texto é fixo e contém exatamente duas linhas: `Bem-vindo ao Pit` e `/help para ajuda`.
- Não há frase de personalidade, citação aleatória, versão ou terceiro texto nessa região.

### Divisor

O divisor marca a transição entre apresentação e interação.

- Usa cor muted do tema.
- Não deve parecer borda de card.
- Permanece uma linha acima dos metadados da caixa de digitação.
- Some junto com a área de abertura depois da primeira mensagem enviada ou enfileirada.

### Caixa de digitação

A caixa de digitação é a área permanente da interface. Na abertura, ela recebe mais respiro; durante a conversa, mantém a mesma identidade em formato compacto.

Ele é formado por quatro regiões:

1. **Linha de contexto superior** — modo e modelo, alinhados à direita.
2. **Área editável** — texto, cursor, seleção e placeholder.
3. **Linha de estado opcional** — anexos, mensagens na fila, autocomplete ou aviso local.
4. **Linha de workspace inferior** — cwd e branch, alinhados à direita.

Essas regiões pertencem à moldura visual da caixa de digitação (`ComposerChrome` no código). O conteúdo de texto continua sendo responsabilidade do editor existente.

## Globo ASCII animado

### Fonte

O protótipo local contém:

- mapa-múndi simplificado de baixa resolução;
- projeção de uma esfera com inclinação axial;
- rotação longitudinal;
- iluminação e esmaecimento nas bordas;
- rampas de densidade formadas por pontos e círculos;
- cores separadas para terra e oceano.

A lógica matemática pode ser portada. O componente React e seus estilos não devem ser copiados para o runtime.

### Comportamento

- Tamanho amplo de referência: 44 colunas por 22 linhas.
- Cadência máxima: 10 frames por segundo.
- A rotação começa depois que a abertura da sessão é montada.
- Digitar não pausa a animação.
- Abrir overlay pode pausar a animação para reduzir ruído visual.
- A primeira mensagem real enviada ou enfileirada encerra o agendador e remove o globo.
- Comandos de barra, ajuda e abertura de painéis não removem o globo.
- O componente não permanece oculto consumindo atualizações.
- Ao redimensionar, a próxima renderização escolhe uma variante apropriada.

### Variantes responsivas

- **Ampla:** globo completo ao lado do texto.
- **Intermediária:** globo menor, com menos colunas e linhas.
- **Estreita:** globo animado compacto acima da saudação.
- **Mínima:** globo animado mínimo, preservando apenas a silhueta legível.

Os limites exatos devem ser derivados da largura real de conteúdo, não de um número fixo que ignore padding e largura visível de caracteres.

### Animação obrigatória

O globo permanece animado mesmo quando o terminal ou o ambiente indica preferência por movimento reduzido. Esta é uma decisão explícita de identidade do produto: não haverá variante estática nem omissão automática. A cadência máxima de 10 frames por segundo e o tamanho compacto reduzem o custo, mas não alteram esse comportamento.

### Cores e compatibilidade

- Usar cores semânticas do tema, não valores RGB fixos do AMP.
- Terra usa progressão do acento principal.
- Oceano usa tons muted e secundários.
- Terminais sem true color recebem uma rampa ANSI reduzida.
- Modo sem cor mantém densidade legível apenas pelos caracteres.
- Caracteres com largura incerta devem possuir fallback ASCII.

## Caixa de digitação refinada

### Princípio

Refinar não significa substituir o editor. Histórico, undo/redo, multiline, autocomplete, anexos, paste, seleção, comandos e atalhos atuais devem continuar funcionando.

### Forma

- Largura igual à região útil da interface.
- Uma linha vazia inicialmente, crescendo conforme o conteúdo.
- Altura máxima configurada pelo espaço disponível; depois disso, scroll interno.
- Padding horizontal constante.
- Borda completa e discreta na tela inicial.
- Durante a conversa, pode usar a mesma borda ou uma variante mais compacta, sem mudar controles e atalhos.
- Placeholder curto: `Digite uma tarefa…`.

### Estados de borda

| Estado | Tratamento |
|---|---|
| Ocioso e focado | Cor do modo atual em intensidade baixa |
| Digitando | Acento levemente mais evidente |
| Plan | Cor semântica de Plan |
| Auto | Cor semântica de Auto |
| Fusion | Gradiente ou acento já usado por Fusion, sem animação contínua na borda |
| Bash | Cor já associada ao modo bash |
| Erro local | Cor de erro até a próxima edição válida |
| Sem foco | Cor muted |

A borda não deve piscar durante streaming nem disputar atenção com o indicador de trabalho.

### Modo e modelo

Os metadados aparecem de forma adaptativa ao redor da caixa, sem reservar espaço para informação irrelevante.

- O modo vem primeiro por afetar permissões e orquestração.
- O nível de raciocínio aparece junto ao modo quando estiver disponível.
- O modelo aparece quando difere do padrão da sessão ou quando uma troca de modelo precisa ser confirmada; pode ser abreviado quando faltar espaço.
- A fila aparece somente quando houver itens pendentes ou um estado que exija atenção.
- O workspace permanece visível, abreviado conforme o espaço.
- As informações são texto/chips compactos, não botões obrigatoriamente clicáveis.
- Alterações feitas por atalhos atualizam a linha sem reconstruir o editor.

Exemplo:

```text
                                              auto · deep
```

### Workspace

Na região inferior da mesma moldura da caixa de digitação, à direita:

- cwd abreviado em relação ao home;
- branch quando houver repositório;
- indicador compacto de mudanças somente quando relevante;
- nota do cwd do shell apenas quando diferente do cwd da sessão.

A área de abertura não repete essas informações.

### Anexos e fila

Abaixo ou imediatamente acima do editor, à esquerda:

- arquivos e imagens anexados como itens compactos;
- quantidade de mensagens aguardando envio;
- estado da fila escrito como `2 na fila`, nunca apenas um ícone ambíguo;
- aviso de paste truncado ou arquivo inválido próximo à caixa de digitação;
- itens devem poder ser revisados pelo teclado antes do envio.

A fila segue a regra definida para mensagens durante execução: enviar enquanto o agente trabalha coloca a mensagem na fila e não interfere no turno atual.

### Ajuda contextual

Não exibir uma parede permanente de atalhos. A área pode mostrar uma única dica contextual:

- vazio: ajuda ou anexar arquivo;
- com autocomplete aberto: navegar e confirmar;
- agente trabalhando: mensagem será adicionada à fila;
- com itens pendentes: atalho para abrir a fila;
- bash: como sair do modo bash.

### Cursor e foco

- O cursor continua sob controle do editor.
- A nova borda não altera cálculo de coluna visível.
- Abrir um overlay move o foco corretamente e restaura o editor ao fechar.
- A caixa de digitação nunca perde texto ao alternar modo, modelo, painel ou tamanho do terminal.

## Ciclo de vida da tela

### Entrada

A composição completa aparece a cada ativação de sessão em modo interativo: inicialização, retomada, `/new` e anexação ou troca de sessão. Em sessão retomada, o histórico permanece carregado, mas temporariamente oculto atrás da abertura.

Exceções:

- se a linha de comando já trouxe um prompt inicial, ele conta como primeira mensagem e a abertura não é montada;
- modos headless e RPC não exibem a abertura;
- pouca altura ou largura seleciona a variante compacta animada, nunca remove o globo.

Perguntas, aprovações e erros críticos aparecem em uma camada própria sobre a abertura, sem revelar o restante do histórico nem remover o globo. Responder ao agente conta como a primeira mensagem e conclui a transição.

### Durante a digitação

- O globo continua girando.
- A caixa de digitação cresce dentro do limite disponível.
- A área de abertura reduz primeiro se o texto precisar de mais altura.
- Autocomplete e sobreposições aparecem acima da caixa de digitação sem cobrir o cursor.

### Primeira mensagem da ativação

Na mesma atualização visual do envio ou enfileiramento:

1. parar e descartar a animação;
2. remover a área de abertura e o divisor;
3. revelar o histórico já carregado, quando for uma sessão retomada;
4. mostrar a mensagem como enviada ou pendente na fila;
5. manter a caixa de digitação no rodapé;
6. mostrar o indicador de trabalho sem quadro intermediário vazio.

Comandos de barra, ajuda, troca de modo e abertura de painéis não contam como mensagem ao agente e não acionam essa transição.

Essa transição não deve limpar, recriar ou perder o estado do editor.

### Resize

- Recalcular apenas a composição, não o conteúdo do editor.
- Trocar entre variantes do globo sem acumular timers.
- Quando altura for insuficiente, priorizar caixa de digitação, estados críticos e histórico.
- Nunca esconder pergunta, aprovação ou erro para preservar a área de abertura.

## Arquitetura proposta

### `StartupScreen`

Componente responsável pela composição da área de abertura, divisor e escolha responsiva. Recebe dados prontos e não consulta sessão, Git ou configurações diretamente.

### `AsciiGlobe`

Componente puramente visual. Recebe dimensão, fase de rotação e tema. Produz linhas renderizáveis sem conhecer o ciclo da sessão.

### `ComposerChrome` — moldura da caixa de digitação

Nome interno da moldura visual ao redor do editor existente. Organiza contexto superior, borda, estado local, anexos, fila e workspace. Não possui o conteúdo de texto.

### `ComposerMetadata` — metadados da caixa de digitação

Nome interno do modelo de dados estável contendo modo, modelo, nível de raciocínio, diretório de trabalho, branch, anexos, fila e avisos. Evita que o componente visual dependa de vários serviços internos.

### Controlador interativo

O modo interativo continua responsável por:

- decidir se a tela inicial está ativa;
- fornecer dados aos componentes;
- encerrar a animação na primeira mensagem enviada ou enfileirada da ativação;
- preservar foco e editor durante a transição;
- atualizar metadados quando o estado da sessão muda.

## Fluxo de dados

```text
sessão + settings + Git + modo/modelo
                  │
                  ▼
          ComposerMetadata
             │         │
             ▼         ▼
      StartupScreen  ComposerChrome ── editor existente
             │
             ▼
         AsciiGlobe
```

Nenhum componente visual deve iniciar consultas de Git, carregar modelos ou alterar configurações.

## Performance e robustez

- Limitar o globo a no máximo 10 atualizações por segundo.
- Reutilizar o agendador compartilhado da TUI quando possível.
- Marcar somente a região do globo como stale.
- Não provocar render completo do histórico a cada frame.
- Cancelar assinatura e timer na primeira mensagem, suspensão e encerramento.
- Depois que a abertura desaparecer, não pode restar timer, assinatura ou trabalho de animação.
- O custo de render em estado estável, depois da abertura, não pode regredir mais de 5% em relação ao baseline medido no mesmo ambiente.
- Sessões retomadas exibem a animação durante a abertura; modos headless e RPC não adicionam trabalho de animação.
- Manter o custo do cálculo do frame limitado pela dimensão visível.
- Não carregar React, React DOM, Vite ou Tailwind no pacote publicado do coding agent.

## Acessibilidade e terminais

- Todas as ações continuam disponíveis por teclado.
- Cor nunca é a única indicação de modo ou estado.
- O globo permanece animado mesmo sob preferência de movimento reduzido, conforme decisão explícita desta proposta.
- Sem cor usa caracteres com contraste por densidade.
- Larguras Unicode passam pelo cálculo de largura visível da TUI.
- Terminais estreitos recebem composição compacta, não conteúdo truncado de forma ilegível.
- Leitores de terminal não devem receber o globo como conteúdo conversacional ou copiável.

## Tratamento de erros

- Falha ao criar o globo mostra um erro visual compacto e mantém a caixa de digitação utilizável; não inicia a sessão silenciosamente sem o elemento obrigatório.
- Tema sem cores esperadas usa acentos semânticos padrão.
- Erro ao obter Git ou modelo não bloqueia a tela; omite somente o metadado afetado.
- Resize durante um frame não deve lançar nem deixar o terminal parcialmente desenhado.
- Qualquer saída da TUI restaura cursor, foco e estado do terminal normalmente.

## Testes necessários

### Unidade

- projeção e frame determinísticos para uma fase conhecida;
- seleção de variante por largura e altura útil;
- fallback ASCII e sem cor;
- composição de metadados e abreviação do modelo/cwd;
- crescimento e limite visual da caixa de digitação;
- cancelamento idempotente da animação.

### Componente

- render amplo, intermediário, estreito e mínimo, todos animados;
- preferência de movimento reduzido mantém a animação;
- editor vazio, multiline, anexos e mensagens na fila;
- modos Plan, Auto, Fusion e Bash;
- overlays e autocomplete sem cobrir o cursor;
- troca de tema e resize durante animação.

### Integração

- inicialização, retomada, `/new` e anexação ou troca de sessão exibem a abertura;
- sessão retomada mantém o histórico carregado e o revela na primeira nova mensagem;
- prompt inicial da linha de comando pula a abertura sem lampejo;
- primeira mensagem enviada ou enfileirada remove a área de abertura e mantém o editor funcional;
- comandos de barra, ajuda e painéis não removem a abertura;
- nenhum frame vazio entre envio e indicador de trabalho;
- fila durante execução aparece na caixa de digitação;
- mensagens na fila são consumidas automaticamente em FIFO, uma por novo turno;
- itens restaurados após reinício voltam como rascunhos e exigem confirmação, sem envio automático;
- `/steer <mensagem>` e sua ação remapeável orientam explicitamente o turno atual;
- `Esc` cancela primeiro; uma mensagem só é enviada em uma segunda ação;
- suspensão, retomada e encerramento não deixam timer ativo;
- modo headless permanece inalterado.

### Performance

- benchmark de render do globo isolado;
- benchmark da tela inicial animada;
- comparação da caixa de digitação com e sem a nova moldura visual;
- verificação de que o histórico não é rerenderizado integralmente por frame.
- confirmação de no máximo 10 frames por segundo para o globo;
- confirmação de no máximo 5% de regressão no render em estado estável;
- confirmação de zero timer ou assinatura do globo depois que ele desaparece.

### Validação por plataforma

- A aceitação visual manual obrigatória é feita no Windows.
- Os testes automatizados existentes de compatibilidade e não regressão continuam obrigatórios em Linux e macOS.

## Entregas da frente visual

### Entrega 1 — caixa de digitação e fila previsível

- Extrair os metadados atuais para um modelo único.
- Adicionar linha superior, borda completa, linha de workspace e estado explícito da fila.
- Fazer `Enter` durante execução enfileirar por padrão, preservando `/steer` como ação explícita.
- Restaurar pendências como rascunhos confirmáveis após reinício.
- Manter o editor existente sem regressões.

### Entrega 2 — globo e abertura da sessão

- Portar mapa e projeção para `AsciiGlobe`.
- Implementar todas as variantes animadas e os limites de desempenho.
- Criar `StartupScreen`.
- Exibir a abertura em toda ativação interativa de sessão, salvo prompt inicial já submetido.
- Implementar a transição na primeira mensagem enviada ou enfileirada.
- Adicionar testes determinísticos e benchmarks.

### Entrega 3 — responsividade e compatibilidade final

- Fechar variantes de largura/altura.
- Validar temas, preferência de movimento reduzido, terminais sem cor e aceitação visual no Windows.
- Manter os testes automatizados de compatibilidade em Linux e macOS.

## Roadmap unificado

### Fase 1 — entrada refinada e fila previsível

- Entregar primeiro a caixa de digitação refinada e sua moldura visual.
- Fazer o envio durante execução entrar na fila por padrão.
- Exibir mensagens pendentes e suas ações básicas.
- Restaurar pendências como rascunhos confirmáveis.

Resultado: o usuário passa a confiar no comportamento do envio durante trabalho ativo antes que a abertura animada altere o ciclo visual da sessão.

### Fase 2 — identidade de abertura

- Implementar `AsciiGlobe` isolado e testável.
- Criar a abertura temporária em toda ativação interativa de sessão.
- Implementar a transição na primeira mensagem enviada ou enfileirada.
- Validar as variantes animadas e os critérios de desempenho.

Resultado: o Pit ganha uma identidade visual consistente sem mudar as regras já estabilizadas da caixa de digitação e da fila.

### Fase 3 — observabilidade operacional

- Expor gerenciamento completo de jobs.
- Criar o painel unificado de tarefas.
- Adicionar seleção e ações individuais ao histórico.
- Integrar anexos, fila e estados operacionais à caixa de digitação.

Resultado: trabalho em background e histórico deixam de ser superfícies passivas.

### Fase 4 — coordenação visual

- Criar painel de agentes e sessões.
- Enfileirar mensagens para agentes ocupados.
- Responder perguntas e aprovações pelo painel.
- Adicionar prévia e comentários estruturados ao Plan.

Resultado: o Coordinator se torna operável pela interface, não apenas por comandos.

### Fase 5 — controle persistente

- Produzir design dedicado de pontos de restauração.
- Validar uma prova de conceito somente leitura antes de autorizar qualquer implementação de restauração.
- Somente depois desses critérios, planejar a restauração transacional com prévia e ramo seguro.

Resultado: o Pit só assume o risco de restauração depois de provar cobertura e consistência sem alterar arquivos.

## Fora do escopo

- substituir o editor de texto;
- manter o globo durante a conversa;
- desenhar uma janela macOS falsa dentro do terminal;
- incorporar o aplicativo React ao monorepo como dependência do Pit;
- alterar o comportamento de Plan, Auto ou Fusion;
- redesenhar histórico, painel de tarefas ou painel de agentes nesta mesma entrega.

## Critérios de aceite da frente visual

- A abertura aparece em toda ativação interativa de sessão e oculta temporariamente o histórico retomado.
- Um prompt inicial fornecido pela linha de comando pula a abertura sem lampejo.
- A composição ampla corresponde ao princípio visual AMP adaptado ao Pit.
- O globo permanece animado em todas as larguras e preferências de movimento até a primeira mensagem enviada ou enfileirada.
- Comandos, ajuda e painéis não removem o globo.
- Depois de desaparecer, o globo não mantém timer, assinatura ou trabalho residual.
- A caixa de digitação preserva todas as funções atuais do editor.
- Modo, modelo e workspace ficam legíveis sem ocupar o buffer editável.
- Anexos e fila aparecem quando existem e não poluem o estado vazio.
- A interface adapta corretamente o globo animado a terminais estreitos, sem cor e com preferência de movimento reduzido.
- A animação não força rerender integral do histórico.
- Headless e RPC mantêm o comportamento atual; sessões retomadas recebem a abertura temporária definida nesta proposta.
- A implementação não adiciona React, Vite ou Tailwind ao runtime publicado.

## Critérios finais da proposta unificada

- A nova interface preserva todas as capacidades atuais do editor e da sessão.
- Enviar durante execução enfileira a mensagem sem alterar o turno corrente.
- A fila é consumida em FIFO, uma mensagem por novo turno; após reinício, itens não enviados retornam somente como rascunhos confirmáveis.
- Jobs, agentes e mensagens pendentes apresentam estado e destino inequívocos.
- O painel de tarefas não cria uma segunda fonte de verdade para jobs ou agentes.
- O histórico permanece virtualizado e estável durante streaming.
- O painel de agentes não cancela agentes ocupados ao receber novas mensagens.
- A aprovação de plano continua explícita e somente leitura até confirmação.
- A restauração nunca sobrescreve trabalho anterior à sessão silenciosamente.
- A restauração não entra em implementação sem design dedicado e prova de conceito somente leitura aprovados.
- Teclado continua suficiente para operar todas as superfícies.
- Animações e painéis não degradam o hot path de render da TUI.
- Headless e RPC mantêm compatibilidade e semântica equivalente.
- Cada fase pode ser entregue e validada sem depender da conclusão das fases posteriores.

## Recomendação

Começar pela Fase 1: caixa de digitação refinada e fila de mensagens como comportamento padrão durante execução. Essa entrega resolve primeiro a ambiguidade operacional de envio, preserva o editor existente e cria a base visual usada pelas fases seguintes.

Globo e abertura vêm na Fase 2, já apoiados em uma entrada estável. Painel de tarefas e histórico selecionável vêm em seguida porque reaproveitam o runtime existente. A restauração permanece por último, separada e condicionada a design e prova de conceito próprios, pois é a única frente com risco direto de perda de trabalho.
