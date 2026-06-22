# Relatorio: camadas nativas para elevar a qualidade do Pit

## Leitor e objetivo

**Leitor-alvo:** mantenedor do Pit que quer transformar o agente em um harness
mais confiavel, capaz de entregar qualidade alta mesmo quando usa modelos mais
baratos, menores ou inconsistentes.

**Acao apos leitura:** priorizar as camadas nativas que devem ser implementadas
no Pit para reduzir erro de codigo, melhorar revisao pos-edicao, usar LSP como
verificador estruturado e escalar modelo apenas quando necessario.

## Tese central

O ganho principal nao vem de chamar um modelo de "forte" ou "fraco". Isso e
relativo ao tipo de tarefa, ao contexto, ao provedor, ao custo, ao latency budget
e ao comportamento real em uso local.

O Pit deve tratar qualidade como uma decisao operacional:

- qual e o risco desta tarefa;
- que sinais o modelo ja demonstrou nesta sessao;
- quais arquivos e APIs estao envolvidos;
- quais validacoes estao disponiveis;
- quanto erro novo foi introduzido;
- se vale continuar com o modelo atual ou escalar.

Em vez de um rotulo fixo, o Pit deveria ter um perfil dinamico de capacidade e
confianca por tarefa. O harness decide quanto trilho, verificacao e escalonamento
aplicar em cada turno.

## Estado atual relevante

O Pit ja tem varias pecas que apontam para um harness de alta qualidade:

- roles de modelo, como perfis para trabalho rapido, planejamento ou trabalho
  mais profundo;
- LSP habilitado por padrao, com diagnosticos apos escrita;
- verificacao configuravel apos mudancas de codigo;
- tool discovery e frequent files para reduzir superficie ativa e melhorar
  contexto;
- hindsight para memoria operacional;
- Fusion e subagentes para analise, planejamento e revisao;
- guards de ferramentas, permissao, grounding e loops de erro.

O problema e que essas pecas ainda nao parecem compor uma politica unica de
qualidade. Algumas funcionam como avisos, outras como gates, outras dependem do
modelo reagir bem. Modelos mais baratos costumam falhar exatamente nesse ponto:
recebem um aviso, repetem a mesma acao com pequena variacao e passam pelo buraco
entre as camadas.

O objetivo e transformar essas pecas em uma camada nativa e inseparavel do Pit.

## Principio de desenho

O Pit deve ter padrao "quality by default":

- nativo, ligado por padrao;
- sem exigir que o usuario ative modo especial;
- opt-out apenas quando houver custo claro;
- fail-open em sinais incertos;
- fail-closed quando houver erro novo comprovado;
- medido por resultado, nao por intuicao;
- mais trilhos para tarefas arriscadas;
- menos ruido para tarefas simples.

O harness deve compensar limites do modelo, mas nao infantilizar todo modelo em
todo turno.

## 1. Perfil de capacidade por dimensao

Evitar `weak | strong` como classificacao principal. Usar um perfil mais granular:

```ts
type ModelCapabilityProfile = {
  cost: number;
  latency: number;
  contextWindow: number;
  toolUse: number;
  codeEdit: number;
  debugging: number;
  planning: number;
  longContext: number;
  instructionFollowing: number;
  uncertainty: number;
};
```

Esse perfil nao precisa ser perfeito. Ele deve combinar tres fontes:

- metadados estaticos: custo, contexto, provider, thinking, suporte a tools;
- benchmarks locais do Pit: edicao, debug, LSP, testes, diff pequeno;
- telemetria viva: erros introduzidos, retries, checks verdes, loops, rollback.

O resultado pratico nao deve ser "modelo fraco". Deve ser:

> Para esta tarefa, com este risco, este modelo tem confianca suficiente ou
> precisa de mais trilhos, verificacao ou escalonamento.

## 2. Classificador nativo de risco da tarefa

Antes de decidir como executar, o Pit deveria classificar o risco do turno.

Sinais de baixo risco:

- leitura e resumo;
- edicao local pequena;
- mudanca em comentario, texto ou docs;
- arquivo isolado;
- teste especifico disponivel.

Sinais de medio risco:

- alteracao em codigo TypeScript;
- import novo;
- mudanca em contrato de funcao;
- alteracao em teste;
- arquivo ja frequente no projeto;
- uso de ferramenta com historico de erro.

Sinais de alto risco:

- mudanca cross-file;
- refactor;
- alteracao em permissao, LSP, provider, agent loop ou settings;
- alteracao sem teste obvio;
- diff grande;
- erro repetido;
- loop de ferramenta;
- diagnostics LSP novos;
- falha de `check`.

O risco do turno define o nivel de harness aplicado. Isso e mais correto do que
decidir apenas pelo modelo.

## 3. Quality Orchestrator

A principal sugestao e criar uma camada conceitual chamada aqui de
`Quality Orchestrator`.

Ela ficaria entre modelo, ferramentas, LSP, verificacao e estado da sessao.

Responsabilidades:

- receber perfil do modelo;
- receber risco da tarefa;
- escolher nivel de rigor;
- decidir quando usar LSP;
- decidir quando rodar verificacao;
- decidir maximo de retries;
- decidir quando chamar revisao interna;
- decidir quando escalar modelo;
- bloquear conclusao quando houver erro novo confirmado;
- registrar padroes de falha para hindsight.

Essa camada evita espalhar heuristicas por prompt, LSP, verification, model
resolver e tool guards. Sem ela, cada modulo acaba criando sua propria nocao de
"modelo bom", "tarefa dificil" e "erro aceitavel".

## 4. Prompt adaptativo por perfil e risco

O system prompt nao deveria ser identico para todos os cenarios.

Para tarefas simples ou modelo confiavel:

- prompt mais curto;
- menos checklist;
- menos narracao;
- menos tokens de controle;
- foco em velocidade.

Para modelo barato, tarefa arriscada ou sessao com erro recente:

- passos menores;
- leitura obrigatoria antes de editar;
- checagem apos ferramenta;
- plano curto antes de patch;
- proibicao explicita de declarar pronto com validacao vermelha;
- incentivo a usar LSP e testes focados.

Isso deve ser automatico. O usuario nao deveria escolher "modo cuidadoso".

O ponto importante: nao inflar o prompt global. O prompt forte demais em todo
turno vira custo fixo, atrapalha modelos bons e reduz contexto util.

## 5. LSP como catraca pos-escrita

Sim, eu mexeria no LSP, mas nao como cerebro principal. O LSP deve ser uma
catraca corretiva e deterministica apos criacao de codigo.

Fluxo recomendado:

1. Capturar diagnosticos baseline antes da edicao.
2. Aplicar patch.
3. Sincronizar arquivo com LSP.
4. Capturar diagnosticos apos a edicao.
5. Comparar apenas erros novos.
6. Se houver erro novo de alta severidade, marcar o turno como nao concluivel.
7. Oferecer ao modelo um resumo curto do erro e exigir correcao antes de novas
   mudancas amplas.
8. Quando houver code action simples e segura, aplicar ou sugerir como primeira
   tentativa.

Regras importantes:

- nao punir erros pre-existentes;
- nao bloquear por warning incerto;
- nao depender de texto longo do LSP;
- nao deixar o modelo finalizar quando ele mesmo introduziu erro novo;
- manter timeout curto;
- se o LSP estiver indisponivel, cair para verificacao alternativa.

Esse e um dos maiores ganhos para modelos baratos: eles podem gerar codigo
razoavel, mas frequentemente erram assinatura, import, tipo, simbolo ou chamada.
O LSP pega isso antes do usuario.

## 6. Filtro automatico de patch

Apos qualquer edicao relevante, o Pit deveria rodar um filtro local de patch.

Esse filtro nao precisa ser inteligente. Ele precisa ser confiavel.

Sinais analisados:

- tamanho do diff;
- arquivos tocados;
- arquivos de teste tocados ou ausentes;
- imports novos;
- dependencias novas;
- chamadas a APIs externas;
- alteracoes em tipos publicos;
- alteracoes em configuracao;
- diagnostics LSP novos;
- comandos de verificacao disponiveis;
- risco visual quando envolver UI.

Resultado esperado:

- baixo risco: continuar;
- medio risco: exigir leitura/revisao curta;
- alto risco: rodar verificacao e impedir conclusao ate resolver;
- risco extremo: escalar modelo ou acionar revisao interna.

Esse filtro e uma forma barata de dar disciplina de engenharia a modelos que nao
tem bom julgamento proprio.

## 7. Fechar o buraco "done on red"

O agente nao deveria declarar conclusao quando a validacao relevante falhou.

Politica recomendada:

- se houve mudanca de codigo, tentar verificacao aplicavel;
- se `check` ou teste focado falhar, nao permitir mensagem final de sucesso;
- resumir a falha em formato curto e acionavel;
- dar ao modelo uma ou mais tentativas de correcao conforme risco/perfil;
- se esgotar, finalizar como bloqueado ou parcialmente concluido, nunca como
  pronto;
- diferenciar erro introduzido pelo patch de erro pre-existente no projeto.

Para modelo barato, aumentar tentativas guiadas pode ser mais barato do que
escalar imediatamente. Para modelo caro, menos retries podem ser suficientes.

## 8. Revisao interna automatica

O Pit deveria ter uma revisao pos-patch nativa, sem depender do usuario pedir
"revise".

Ela nao precisa rodar sempre com outro modelo. Pode ser escalonada:

- patch pequeno e LSP limpo: sem revisao;
- patch medio: checklist local deterministico;
- patch alto risco: revisao por subagente ou modelo julgador;
- patch com falha repetida: escalonamento obrigatorio.

Checklist minimo:

- a mudanca resolve exatamente o pedido;
- nao toca escopo desnecessario;
- nao adiciona API inventada;
- nao ignora erro de teste;
- nao introduz dependencia sem motivo;
- nao troca comportamento publico sem teste;
- nao deixa TODO ou fallback suspeito;
- nao usa `any` ou atalho proibido pelas regras do projeto.

Isso transforma revisao em parte do ciclo de escrita, nao em etapa manual.

## 9. Hindsight corretivo automatico

Hindsight deve ser usado como memoria de erro, nao apenas memoria de sessao.

Quando o Pit observa um ciclo vermelho -> verde, ele pode salvar um padrao curto:

- sintoma;
- comando ou diagnostico;
- causa provavel;
- correcao aplicada;
- arquivos ou modulo afetado;
- confianca.

Quando erro parecido reaparece:

- recuperar apenas o melhor padrao;
- injetar uma dica curta;
- evitar despejar historico longo no prompt;
- descartar padroes com baixa precisao.

Exemplo de entrada util:

```md
Sintoma: TS2322 apos alterar assinatura de funcao.
Causa: callsites antigos mantiveram tipo anterior.
Correcao: buscar referencias via LSP antes de editar retorno.
```

Isso melhora modelos baratos porque substitui "lembranca semantica" por memoria
operacional concreta do projeto.

## 10. Tool surface menor e mais precisa

Modelos baratos sofrem quando veem ferramentas demais, contexto demais e
instrucoes demais.

O Pit deve continuar reduzindo superficie ativa:

- ferramenta escondida por padrao quando nao relevante;
- busca de ferramenta sob demanda;
- arquivos frequentes em formato compacto;
- repo map e simbolos como guia;
- leitura por slice quando possivel;
- resumo de outputs longos antes de devolver ao modelo;
- comandos de verificacao apresentados como opcoes claras.

Regra pratica:

> Modelos menores melhoram mais quando recebem o contexto certo do que quando
> recebem mais contexto.

## 11. Escalonamento invisivel de modelo

O usuario quer qualidade sem ativar modo especial. Entao o escalonamento deve ser
nativo.

Continuar com modelo barato quando:

- tarefa e local;
- diff e pequeno;
- LSP esta limpo;
- teste focado passou;
- nao houve loop;
- nao ha API incerta.

Escalar quando:

- erro de verificacao se repete;
- LSP aponta erro novo dificil;
- patch cresce demais;
- tarefa exige arquitetura;
- varios arquivos mudam;
- o modelo repete acao bloqueada;
- ha conflito entre instrucoes;
- o modelo tenta concluir com validacao vermelha.

Escalonar nao significa trocar sempre para o modelo mais caro. Pode significar:

- chamar modelo forte so para plano;
- chamar modelo forte como revisor;
- chamar subagente read-only;
- usar Fusion em modo planejamento;
- pedir uma sintese curta e devolver a execucao ao modelo barato.

O melhor padrao costuma ser:

1. modelo barato executa;
2. harness mede risco;
3. se necessario, modelo forte revisa ou planeja;
4. modelo barato aplica patch pequeno;
5. LSP e testes validam.

## 12. Fusion e subagentes como qualidade, nao espetaculo

Fusion deve ser usado quando existe ganho real:

- planejamento dificil;
- decisao arquitetural;
- investigacao com hipoteses concorrentes;
- revisao de patch grande;
- erro repetido sem progresso.

Evitar usar varios modelos para escrever o mesmo codigo ao mesmo tempo. Isso
aumenta conflito e custo. Melhor:

- varios agentes leem e propoem;
- um sintetizador escolhe;
- um executor aplica;
- um revisor verifica.

Para modelos baratos, isso cria uma estrutura de qualidade parecida com equipe:
explorador, planejador, executor e revisor.

## 13. Diff limit como diagnostico, nao pausa manual

Um limite de diff ajuda a evitar overengineering, mas nao deve virar uma pausa
interativa constante.

Politica recomendada:

- contar linhas alteradas por turno;
- considerar arquivos e tipo de mudanca;
- emitir diagnostico quando passar limite;
- exigir justificativa curta do modelo;
- em risco alto, rodar revisao/verificacao;
- bloquear apenas quando o diff contradiz claramente o pedido.

Exemplo:

- pedido: "corrigir typo";
- patch: 12 arquivos, 400 linhas;
- acao: bloquear e pedir reducao.

Outro exemplo:

- pedido: "migrar contrato de API";
- patch: 12 arquivos, 400 linhas;
- acao: permitir, mas exigir verificacao forte.

O limite deve entender contexto, nao ser numero cego.

## 14. Grounding de imports, comandos e paths

Modelos baratos inventam:

- pacote que nao esta instalado;
- import com alias errado;
- script npm inexistente;
- path proximo mas incorreto;
- simbolo que nao existe.

Sugestoes nativas:

- validar imports relativos antes de salvar;
- validar bare imports contra dependencias e workspaces;
- validar scripts `npm/pnpm/yarn run` contra `package.json`;
- normalizar aliases de path usados por ferramentas;
- usar LSP para referencias, rename e code actions;
- evitar bloqueio quando o sinal for incerto.

Esses gates devem ser "block-only" quando ha alta confianca. Quando ha baixa
confianca, viram aviso ou steer.

## 15. Verificacao orientada por arquivos tocados

Rodar sempre a suite inteira pode ser caro. Nao rodar nada e perigoso.

O Pit deveria escolher verificacao por escopo:

- docs/texto: leitura final e lint se houver;
- TypeScript isolado: LSP + teste focado quando existir;
- pacote alterado: teste do pacote;
- core do agente: suite relevante;
- UI/render visual: screenshot ou preview;
- mudanca ampla: `npm run check`.

O resultado da verificacao deve ser cacheado dentro do turno para evitar rodar o
mesmo check varias vezes sem necessidade.

## 16. Metricas de qualidade

Sem metricas, as camadas viram opiniao.

Medir:

- taxa de patch verde na primeira tentativa;
- erros LSP novos por arquivo alterado;
- tentativas ate check verde;
- loops de ferramenta;
- tamanho medio de diff por tipo de tarefa;
- quantas vezes o modelo tentou finalizar com erro;
- frequencia de escalonamento;
- custo por tarefa concluida;
- latencia ate primeira resposta util;
- falsos bloqueios dos guards;
- aceite/rejeicao de code actions.

Essas metricas devem alimentar o perfil dinamico do modelo.

## 17. Benchmarks locais do Pit

Benchmarks publicos nao bastam. O Pit precisa medir tarefas que representam o
uso real do agente.

Cenarios recomendados:

1. Editar funcao pequena com teste existente.
2. Corrigir erro TypeScript introduzido.
3. Renomear simbolo cross-file via LSP.
4. Corrigir teste vermelho com causa simples.
5. Evitar alterar arquivo fora do escopo.
6. Nao inventar import.
7. Nao declarar pronto com check vermelho.
8. Fazer patch pequeno para pedido pequeno.
9. Usar ferramenta certa quando ela esta oculta.
10. Recuperar de loop de edit/read/bash.

Cada modelo deve ganhar uma ficha operacional. Nao para ranking publico, mas para
roteamento interno.

## 18. Politica por nivel de rigor

Em vez de "modelo fraco", usar niveis de rigor por turno:

### Rigor 0 - simples

- resposta direta;
- poucas ferramentas;
- sem revisao extra;
- sem escalonamento.

### Rigor 1 - edicao comum

- ler arquivo antes;
- patch pequeno;
- LSP apos escrita;
- teste focado se existir.

### Rigor 2 - risco medio

- plano curto;
- baseline LSP;
- filtro de patch;
- verificacao obrigatoria;
- uma tentativa guiada de correcao.

### Rigor 3 - alto risco

- leitura de contexto ampliada;
- subagente ou revisor;
- LSP estrito para erros novos;
- verificacao por pacote;
- diff audit;
- escalonamento se falhar.

### Rigor 4 - critico

- modelo forte para plano ou revisao;
- patch incremental;
- gates estritos;
- nao finalizar sem validacao;
- registrar hindsight quando corrigir.

O Quality Orchestrator escolheria esse rigor automaticamente.

## 19. O que eu nao faria

Eu nao faria:

- prompt gigante fixo para todos os modelos;
- classificacao manual absoluta de modelo forte/fraco;
- LSP tentando decidir arquitetura;
- diff limit como pausa interativa constante;
- subagente escrevendo codigo em paralelo sem dono unico;
- revisao sempre obrigatoria para patch trivial;
- bloquear por warning incerto;
- rodar suite inteira para qualquer mudanca pequena;
- criar modo especial que o usuario precisa lembrar de ativar.

Isso aumentaria custo e atrito sem garantir mais qualidade.

## 20. Roadmap recomendado

### P0 - Fundacao

1. Criar perfil de capacidade por modelo.
2. Criar classificador de risco do turno.
3. Passar perfil e risco para prompt, LSP, verification e retries.
4. Definir niveis de rigor nativos.

### P1 - Menos erro de codigo

1. LSP baseline vs diagnosticos novos.
2. Bloquear conclusao com erro novo introduzido.
3. Filtro automatico de patch.
4. Verificacao orientada por arquivos tocados.
5. Fechar "done on red".

### P2 - Modelos baratos com qualidade

1. Retentativas guiadas por tipo de erro.
2. Hindsight corretivo vermelho -> verde.
3. Grounding de imports, scripts e paths.
4. Tool surface compacta e sob demanda.
5. Prompt adaptativo por rigor.

### P3 - Escalonamento inteligente

1. Revisor forte apenas quando risco justificar.
2. Fusion para planejamento e investigacao.
3. Subagentes read-only para hipoteses concorrentes.
4. Executor unico aplicando patch.
5. Metricas de custo por tarefa concluida.

### P4 - Otimizacao continua

1. Benchmarks locais por tarefa.
2. Dashboard de qualidade operacional.
3. Ajuste automatico de thresholds.
4. Comparacao de modelos por modulo do projeto.
5. Regressions suite para falhas historicas.

## 21. Criterios de sucesso

A melhoria deve ser considerada real apenas se:

- reduzir erros LSP novos;
- reduzir conclusoes falsas;
- reduzir loops;
- manter ou reduzir custo medio por tarefa;
- melhorar taxa de check verde;
- nao aumentar muito latencia em tarefas simples;
- nao produzir falso bloqueio frequente;
- funcionar sem o usuario ativar modo manual;
- preservar caminho lean para modelos bons;
- melhorar modelos baratos em tarefas reais do Pit.

## 22. Conclusao

Minha recomendacao final e tratar o Pit como um harness de qualidade adaptativa,
nao como um simples cliente de LLM.

A mudanca mais importante e criar uma politica nativa que una perfil do modelo,
risco da tarefa, LSP, verificacao, patch audit, hindsight e escalonamento. O LSP
deve virar catraca pos-escrita para erro novo. A verificacao deve impedir "done
on red". O roteamento deve escalar apenas quando a evidencia pedir.

Com isso, modelos baratos ficam mais uteis porque o harness reduz as chances de
erro silencioso. Modelos fortes tambem melhoram porque deixam de depender apenas
da propria autoconfianca e passam por gates objetivos quando o risco exige.
