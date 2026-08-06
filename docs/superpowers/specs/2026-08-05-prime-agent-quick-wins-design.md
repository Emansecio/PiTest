# Quick wins do Prime Agent para o Pit — desenho aprovado

## Objetivo

Elevar imediatamente a confiabilidade do Pit em três pontos observados no
Prime Agent, sem importar sua arquitetura inteira:

1. resolver automaticamente o Python correto para o kernel `eval`;
2. tornar todo Goal autonomamente limitado por tokens, iterações e tempo;
3. exigir um pipeline automático de gates de qualidade antes de concluir um
   Goal que alterou o projeto.

O requisito central é **zero configuração**. As três capacidades funcionam na
primeira execução, com padrões seguros. Configurações e variáveis de ambiente
servem somente como sobrescritas avançadas; nunca como chave de ativação.

## Resultado esperado

Ao iniciar o Pit na raiz de um projeto:

- `eval` usa o Python do ambiente virtual do projeto quando ele existe;
- `/goal <objetivo>` nasce com limites seguros, mesmo sem argumentos;
- um Goal que modificou arquivos só conclui depois que os gates detectados
  passarem;
- falhas repetidas, timeouts e ausência de Python produzem diagnóstico acionável
  e nunca um loop autônomo infinito;
- projetos e sessões existentes continuam carregando sem migração manual.

## O que já existe no Pit

Este desenho estende mecanismos existentes, em vez de criar um segundo runtime:

- o kernel Python persistente já vive em
  `packages/coding-agent/src/core/eval-kernel/python.ts`;
- `GoalManager` já persiste objetivo, estado, tokens, iterações e timestamps;
- `goal_complete` já recusa conclusão com checks em background, probe vermelho,
  self-review pendente ou impacto de imports não revisado;
- a verificação normal já é habilitada por padrão e detecta um único comando do
  `package.json`;
- execução de checks já possui timeout, limite de saída e encerramento da árvore
  de processos no Windows.

Não será criado daemon, ambiente IPython gerenciado, RLM, novo modo de sessão ou
segundo executor de shell.

## Princípios e invariantes

### Zero configuração

- Os padrões são aplicados no runtime, não apenas sugeridos na documentação.
- A ausência de configuração nunca desabilita silenciosamente a capacidade.
- Sobrescritas explícitas inválidas falham com orientação clara; não degradam
  para um executável inesperado sem avisar. Candidatos descobertos
  automaticamente podem cair para o próximo candidato válido.

### Compatibilidade

- Campos novos de sessão são opcionais na leitura e hidratados com padrões.
- `verification.command` mantém o comportamento atual e prevalece quando
  explicitamente definido.
- O formato atual de `/goal <objetivo>` continua válido.
- Nenhuma mudança exige editar arquivos do projeto do usuário.

### Segurança operacional

- Limites são avaliados entre turnos; uma ferramenta em execução não é morta
  somente porque o Goal atingiu o teto.
- Timeout ou cancelamento de gate encerra toda a árvore de processos.
- Saída de gate e erros de Python continuam limitados antes de entrar no prompt.
- A descoberta automática nunca executa downloads (`npx`, `pip install`) nem
  comandos não declarados pelo projeto.

## Prioridade 1 — resolução automática do Python

### Problema atual

O kernel tenta nomes genéricos (`python`/`python3`) diretamente por `spawn`.
Isso ignora o ambiente virtual local e o `VIRTUAL_ENV`. Além disso, erro de
`spawn` é assíncrono: retornar após o primeiro candidato impede que o laço atual
seja um fallback confiável quando o primeiro comando não existe.

### Comportamento proposto

Antes de criar o processo persistente, um resolver puro monta e valida candidatos
na seguinte ordem:

1. `PIT_EVAL_PYTHON`, quando explicitamente definido;
2. interpretador do `VIRTUAL_ENV` ativo;
3. `<cwd>/.venv/Scripts/python.exe` no Windows ou
   `<cwd>/.venv/bin/python` em Unix;
4. `<cwd>/venv/Scripts/python.exe` no Windows ou `<cwd>/venv/bin/python` em
   Unix;
5. primeiro `python3`/`python` realmente encontrado no PATH, respeitando a
   preferência da plataforma.

O resolver retorna o caminho/comando e a origem do candidato. Um override
explícito inválido encerra a resolução com erro acionável. Um candidato
automático ausente ou inválido é registrado e a busca continua. O kernel recebe
um único candidato validado; não tenta interpretar um processo ainda não
iniciado como sucesso.

### Diagnóstico

Se nenhum candidato for utilizável, o erro deve informar:

- o diretório do projeto usado na busca;
- as categorias consultadas (`PIT_EVAL_PYTHON`, `VIRTUAL_ENV`, `.venv`, `venv`,
  PATH), sem despejar variáveis sensíveis;
- a correção mais curta: criar `.venv`, ativar um ambiente ou ajustar o override;
- a causa original quando um caminho explícito existe, mas não pode iniciar.

O runtime registra a origem escolhida em diagnóstico estruturado, sem poluir a
interface em execuções normais.

### Fora de escopo

- instalar Python;
- criar ambiente virtual automaticamente;
- instalar `ipykernel` ou dependências do projeto;
- subir para diretórios pais procurando ambientes;
- trocar o REPL persistente atual por IPython/Jupyter.

Essa contenção evita misturar o ambiente de controle do Pit com dependências do
projeto e mantém a entrega pequena e reversível.

### Critérios de aceite

- `.venv` funciona no Windows e em Unix sem configuração;
- `VIRTUAL_ENV` funciona quando não há override explícito;
- override explícito vence a descoberta automática;
- candidato automático inválido não impede tentar os próximos; override
  explícito inválido falha sem fallback silencioso;
- caminho com espaços é passado diretamente ao `spawn`, sem composição de shell;
- ausência total de Python retorna orientação acionável;
- timeout, abort, limite de saída e persistência de namespace continuam intactos.

## Prioridade 2 — limites padrão para todo Goal

### Problema atual

O Goal contabiliza tokens e iterações, mas somente um orçamento de tokens
explicitamente fornecido integra o estado persistente. Existe também
`goal.maxAutoIterations`, hoje com padrão 50, porém ele limita apenas as
continuações geradas por uma chamada externa de `prompt()`: ao atingir o teto o
Goal vira `paused`, e um `resume` inicia outra janela completa. Não há teto
persistente de iterações nem de tempo ativo para o objetivo inteiro.

### Padrões zero-config

Todo novo Goal recebe automaticamente:

| Limite | Padrão | Motivo |
|---|---:|---|
| Tokens totais | 80.000 | teto já usado pelo Prime Agent e compatível com o governador existente |
| Iterações concluídas | 12 | contém loops sem encerrar cedo demais uma tarefa real |
| Tempo ativo | 30 minutos | limita custo e espera sem penalizar tempo em pausa |

Os valores são deliberadamente conservadores e devem ser constantes nomeadas,
testadas e documentadas. O usuário pode sobrescrevê-los, mas não precisa fazer
nada para obter proteção.

O `goal.maxAutoIterations` atual permanece como backstop legado por janela de
prompt. O novo limite de 12 iterações pertence ao Goal inteiro, sobrevive a
resume/reload e normalmente é atingido primeiro. Uma configuração legada menor
continua podendo pausar a janela antes do teto persistente.

### Modelo de estado

O Goal passa a persistir, além dos campos atuais:

- `maxIterations`;
- `maxActiveMs`;
- tempo ativo acumulado e início do intervalo ativo atual;
- motivo estruturado da última limitação.

O tempo usado para limite é tempo **ativo**, não a idade total da sessão. Pausar
acumula o intervalo corrente; retomar inicia um novo intervalo. `startedAt`
permanece para compatibilidade e exibição histórica.

Sessões antigas sem os campos novos são hidratadas no restore:

- Goal ativo: recebe os padrões e começa a contar tempo ativo a partir do restore;
- Goal pausado: recebe os padrões sem iniciar relógio;
- Goal concluído: permanece imutável;
- orçamento de tokens já explícito é preservado.

### Momento de aplicação

Os limites são reavaliados:

1. após registrar uma iteração;
2. após sincronizar tokens do governador;
3. imediatamente antes de enfileirar a próxima continuação automática;
4. ao retomar ou elevar um limite.

Se qualquer teto for atingido, o turno corrente termina normalmente e a próxima
continuação não é criada. A UI informa qual limite foi alcançado, o valor usado e
como elevar apenas aquele teto.

### Semântica de retomada

`resume` sozinho não reabre um Goal cujo teto continua esgotado. Primeiro é
necessário elevar o limite correspondente. Isso generaliza a regra já existente
para `budget_limited` e evita um turno extra inútil seguido do mesmo bloqueio.

As sobrescritas ficam acessíveis pelo painel de Goal e por comandos compatíveis:

- `--tokens <valor>`;
- `--iterations <n>`;
- `--time <duração>`.

Essas opções são controles avançados, não passos de instalação.

### Critérios de aceite

- `/goal <objetivo>` sem argumentos mostra 80k, 12 iterações e 30 minutos;
- cada limite impede somente a próxima continuação;
- pausas não consomem o teto de tempo ativo;
- restauração de sessões antigas não falha nem expira imediatamente;
- elevar o teto correto reativa o Goal; `resume` isolado não contorna o limite;
- statusline, overlay, resumo e prompt distinguem pausa manual de limite atingido;
- o turno de conclusão continua contado uma única vez.

## Prioridade 3 — pipeline automático de gates do Goal

### Problema atual

O Pit já possui várias barreiras conceituais de conclusão, mas a verificação de
projeto resolve apenas um comando. Em projetos que expõem `typecheck`, `lint` e
`test` separadamente, escolher somente o primeiro deixa sinais importantes fora
da decisão de `goal_complete`.

### Escopo

O novo pipeline vale somente para Goals que alteraram arquivos. A verificação
normal de tarefas comuns mantém seu custo atual. Checks em background, revisão
de impacto e self-review existentes continuam no fluxo e não são duplicados.

Cada Goal mantém uma revisão monotônica de mutação. Toda mutação já reconhecida
pelo harness (`edit`, `write`, Bash efetivo e sentinela de edição externa)
incrementa essa revisão enquanto o Goal estiver ativo. A revisão é persistida
com o Goal, de modo que conclusão, retomada e cache de gates considerem todo o
ciclo do objetivo, não somente o último turno.

### Descoberta zero-config

O detector produz uma lista ordenada, estável e sem duplicatas:

1. Se `verification.command` foi configurado, usar somente esse comando. Ele é a
   decisão explícita do projeto/usuário.
2. Se o `package.json` possui `check`, usar apenas o agregador `check`, pois ele
   normalmente já encadeia os demais sinais.
3. Sem agregador, adicionar no máximo um script de cada categoria, nesta ordem:
   `typecheck`/`type-check`, `lint`, `test`.
4. Sem scripts reconhecidos, usar o fallback local de TypeScript já existente.
5. Sem toolchain local, reutilizar o fallback sintático seguro para arquivos
   alterados; se nada for verificável, o gate fica inerte e registra o motivo.

Não serão inferidos comandos Python destrutivos ou potencialmente caros a partir
de nomes de arquivos. Um projeto Python obtém o fallback `py_compile` somente
quando há interpretador resolvido e arquivos Python alterados. Suites completas
de Python entram quando o projeto as declara explicitamente em uma evolução
posterior.

### Execução

- gates rodam sequencialmente e em ordem determinística;
- o pipeline para no primeiro gate vermelho;
- cada gate reutiliza o executor atual, incluindo cwd, timeout, cap de saída,
  cancelamento e kill da árvore no Windows;
- o resultado identifica `índice/total`, comando, duração, exit code e resumo da
  causa dominante;
- gates verdes anteriores não são repetidos enquanto a revisão de mutação do
  Goal permanecer igual;
- qualquer mutação posterior incrementa a revisão e invalida o cache de gates
  verdes.

### Retentativas e ausência de progresso

Cada gate admite até três falhas consecutivas com o mesmo fingerprint de comando,
saída normalizada e estado relevante do workspace. A falha é reinjetada para
correção. Na terceira repetição idêntica, o Goal é pausado com motivo
`gate_retry_limit`, preserva todo o estado e pede intervenção, em vez de consumir
as 12 iterações repetindo a mesma ação.

Uma falha diferente zera a contagem daquele gate porque indica progresso real.
Os limites globais do Goal continuam soberanos: tokens, iterações ou tempo podem
parar a execução antes das três tentativas.

Timeout não é sucesso: recusa a conclusão e conta como falha do gate. Cancelamento
solicitado pelo usuário interrompe a árvore do comando e pausa o Goal sem consumir
uma tentativa adicional. Isso substitui, somente neste pipeline de Goal com
mutação, o comportamento legado que tratava timeout do probe único como
inconclusivo e permitia continuar.

### Ordem de conclusão

`goal_complete` aplica a seguinte sequência:

1. aguardar ou recusar checks relevantes ainda em background;
2. executar o pipeline automático de comandos do projeto;
3. aplicar self-review e revisão de impacto já existentes;
4. concluir somente quando todas as barreiras estiverem verdes ou legitimamente
   inaplicáveis.

Não existe waiver automático por número de recusas para um gate de comando
vermelho. A saída segura é corrigir, elevar um limite quando apropriado ou pausar
para decisão do usuário.

### Critérios de aceite

- projeto com `check` executa um único agregador;
- projeto sem `check`, mas com `typecheck`, `lint` e `test`, executa os três nessa
  ordem;
- comando explícito continua vencendo a descoberta;
- projeto sem toolchain não baixa dependências nem produz falso erro;
- Goal somente de leitura não dispara pipeline de projeto;
- falha é fail-fast e retorna resumo acionável;
- terceira falha idêntica pausa o Goal;
- alteração relevante invalida gates verdes em cache;
- timeout e cancelamento não deixam processos órfãos.

## Integração entre as três prioridades

A ordem de implementação é obrigatória:

1. **Python automático**, por ser independente e remover a fricção operacional
   mais imediata;
2. **limites de Goal**, porque eles formam o envelope de segurança da automação;
3. **pipeline de gates**, já protegido contra execução ilimitada pelos tetos da
   fase anterior.

Cada fase deve poder ser liberada e revertida isoladamente. A fase seguinte não
pode exigir que o usuário altere configuração para usufruir a anterior.

## Observabilidade

Sem criar telemetria externa, os diagnósticos locais devem registrar:

- origem do Python escolhido e falhas de resolução;
- limite que interrompeu o Goal, valores usados e iteração;
- gates descobertos, duração, status, timeout e número da tentativa;
- razão de pipeline inaplicável.

A UI mostra somente informação operacional curta. Detalhes ficam disponíveis nos
diagnósticos existentes para evitar ruído e custo de contexto.

## Rollout e rollback

### Rollout

- Entregar uma fase por vez, sempre habilitada por padrão.
- Validar primeiro testes unitários do resolver/estado/detector.
- Validar depois os fluxos integrados de kernel, auto-continue e `goal_complete`.
- Rodar `npm run check:fast` após cada fase estável.
- Rodar `npm run check` e `./test.ps1` antes de considerar o conjunto pronto.

### Rollback

- Resolver Python: reverter somente o módulo de descoberta e restaurar os
  candidatos do kernel.
- Limites: manter leitura tolerante dos campos persistidos mesmo se a aplicação
  automática for revertida.
- Gates: restaurar o probe único; campos de cache/retry desconhecidos permanecem
  ignoráveis.

Não serão usados feature flags de ativação, pois violariam o requisito de zero
configuração. Rollback é feito por versão, com schemas forward-tolerant.

## Riscos e mitigação

| Risco | Mitigação |
|---|---|
| escolher Python global em vez do projeto | precedência explícita para ambiente ativo e `.venv` local |
| ambiente local quebrado mascarar PATH funcional | diagnóstico do candidato local e tentativa dos próximos candidatos automáticos |
| novos limites interromperem Goal legítimo | padrões visíveis, elevação por comando/painel e parada somente entre turnos |
| sessão antiga expirar ao restaurar | relógio ativo inicia no restore quando os campos não existem |
| `check` duplicar lint/test | agregador é exclusivo; lista múltipla só quando não há agregador |
| gates aumentarem latência de toda tarefa | pipeline múltiplo limitado a Goals com mutação |
| loop na mesma falha | fingerprint e pausa após três repetições idênticas |
| processo órfão no Windows | reutilizar executor e `killProcessTree` já testados |

## Não objetivos

- replicar o Prime Agent integralmente;
- substituir `code`/`eval` por uma ferramenta IPython única;
- criar ambiente Python gerenciado pelo Pit;
- executar gates externos ou baixar dependências;
- tornar todo turno comum tão caro quanto a conclusão de um Goal;
- alterar os gates existentes de visual, functional web, self-review ou impacto
  além do necessário para compor a ordem de conclusão.

## Definição de pronto do roadmap

O roadmap está concluído somente quando:

- os três recursos funcionam sem qualquer configuração inicial;
- documentação, ajuda de `/goal` e mensagens de erro refletem os padrões reais;
- sessões antigas e configuração `verification.command` continuam compatíveis;
- testes cobrem Windows/Unix, restore, cada limite, descoberta de gates,
  repetição, timeout, cancelamento e ausência de toolchain;
- os gates focados, `npm run check:fast`, `npm run check` e `./test.ps1` passam;
- nenhuma mudança fora das superfícies descritas foi necessária.
