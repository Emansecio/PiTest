# Goal Contract + Evidence Receipt — desenho aprovado

## Leitor e ação esperada

Este documento é destinado à pessoa que implementará a próxima melhoria nativa
do Goal no Pit. Ao terminar a leitura, ela deve conseguir implementar o contrato
de aceite e o recibo de evidências sem criar um segundo orquestrador, adicionar
configuração de ativação ou enfraquecer os gates já existentes.

## Decisão

Todo novo Goal terá, por padrão, um contrato de aceite persistente derivado do
próprio objetivo. `goal_complete` deixará de aceitar apenas uma afirmação livre de
conclusão: exigirá um resultado curto para cada critério, validará as referências
fornecidas, executará as barreiras nativas atuais e persistirá um recibo final.

O recurso será sempre ativo. Não haverá feature flag, variável de ambiente,
serviço, daemon, modelo verificador obrigatório ou etapa posterior de setup.

Fluxo final:

```text
/goal
  -> contrato de aceite persistente
  -> execução normal
  -> mutações e gates alimentam evidências observáveis
  -> goal_complete cobre cada critério
  -> barreiras atuais validam o estado final
  -> recibo persistente e auditável
```

## Problema

O Pit já instrui o agente a verificar cada requisito, porém o estado persistente
do Goal conhece apenas o objetivo e um `summary` livre. Na prática, o runtime não
consegue distinguir estes casos:

- todos os requisitos foram cobertos e verificados;
- apenas a parte principal foi implementada;
- os testes passaram, mas um requisito lateral foi esquecido;
- a conclusão contém uma afirmação sem referência verificável;
- self-review ou análise de impacto foram liberados pelo limite de recusas.

O pipeline atual é forte como barreira global: espera checks em background,
executa gates do projeto, consulta self-review e revisa impacto de imports. O que
falta é ligar essas barreiras aos requisitos explícitos do objetivo e registrar
o que realmente sustentou a conclusão.

## Objetivos

1. Tornar explícito o que precisa estar verdadeiro antes de o Goal concluir.
2. Impedir conclusão com critério omitido, duplicado ou sem evidência declarada.
3. Separar evidência observada pelo runtime de afirmação feita pelo modelo.
4. Registrar gates, mutações, revisões e consumo no estado persistente do Goal.
5. Produzir ganho imediato sem chamada LLM adicional obrigatória.
6. Manter compatibilidade com sessões antigas e com `/goal <objetivo>`.

## Fora de escopo

- substituir Todo ou Plan;
- criar um novo modo de sessão;
- exigir subagente verificador em todo Goal;
- gerar requisitos semanticamente por uma chamada LLM interna;
- provar formalmente que um arquivo satisfaz um requisito;
- armazenar saída bruta de comandos ou diffs completos no recibo;
- gravar recibos dentro do repositório do usuário;
- criar rollback automático, snapshots ou um segundo mecanismo de rewind;
- adicionar flag de ativação ou dependência externa.

O Goal Contract descreve condições de conclusão. Todo continua sendo o rastreador
universal de trabalho e Plan continua sendo o DAG versionado para execução
multifásica. Nenhum dos dois será usado como substituto do contrato.

## Alternativas consideradas

### 1. Somente recibo final

Seria a menor mudança, mas registraria o que o agente decidiu relatar somente no
fim. Não impediria deriva de escopo nem omissão silenciosa de requisito.

### 2. Extração semântica por outro modelo

Produziria critérios melhores para objetivos vagos, ao custo de latência, tokens,
falhas de provider e mais uma decisão probabilística antes de o trabalho começar.
Viola a meta de ganho nativo simples e sem chamada adicional obrigatória.

### 3. Contrato determinístico + recibo validado

É a abordagem escolhida. O runtime extrai somente estrutura explícita, nunca
inventa requisito. Objetivos simples viram um critério único; objetivos com lista
explícita preservam cada item. O ganho de qualidade vem da cobertura obrigatória,
da validação das referências e da composição com os gates existentes.

## Invariantes

### Zero configuração

- Todo Goal novo nasce com contrato.
- Todo Goal novo exige cobertura estruturada na conclusão.
- O recibo é persistido automaticamente.
- Não existe estado “instalado, mas desativado”.
- `/goal receipt` é apenas uma forma opcional de consultar o resultado; não ativa
  nada.

### Honestidade da evidência

- O modelo nunca envia um campo `verified` ou escolhe o nível de confiança.
- O runtime deriva a classificação de cada referência.
- Arquivo citado não é apresentado como prova comportamental; significa apenas
  que o caminho foi observado e, quando aplicável, alterado no Goal.
- Gate verde é registrado como verificação global real, não como prova semântica
  de um critério específico.
- Waiver de self-review ou impacto aparece como `waived`, nunca como `passed`.
- Ausência de toolchain aparece como `inapplicable`, nunca como sucesso inventado.

### Estado limitado

- O contrato nunca excede o objetivo original de 4.000 caracteres mais metadados
  pequenos.
- O parser admite no máximo 16 critérios estruturados. Se houver mais, usa o
  objetivo inteiro como um único critério, evitando omissão silenciosa.
- Cada critério aceita no máximo seis referências.
- `outcome`, notas, resumo e recibo têm limites explícitos de tamanho.
- Saída de gate, stack trace, diff e conteúdo de arquivo não entram no recibo.

### Compatibilidade

- Campos novos são opcionais ao ler sessão antiga.
- Goal ativo restaurado sem contrato recebe um contrato derivado do objetivo.
- `summary` continua existindo para exibição e compatibilidade.
- `goal_complete({ summary })` continua válido no schema, mas recebe uma recusa
  acionável enquanto não trouxer a cobertura dos critérios.
- Goal concluído antigo não é reescrito nem recebe evidência fabricada.

## Contrato de aceite

### Modelo de dados

Adicionar ao domínio do Goal:

```ts
interface GoalCriterion {
  id: string;       // c1, c2, ...
  text: string;
}

interface GoalContract {
  version: 1;
  revision: number;
  source: "explicit-list" | "whole-objective" | "legacy-restore";
  criteria: GoalCriterion[];
}
```

`GoalState` passa a possuir `contract?: GoalContract` e
`receipt?: GoalCompletionReceipt`.

Os IDs são posicionais e estáveis dentro da mesma revisão. Editar o objetivo cria
uma nova revisão e recalcula os IDs; nenhuma evidência da revisão anterior pode
ser usada na conclusão.

### Derivação determinística

Uma função pura `deriveGoalContract(objective, revision, source?)` aplica esta
ordem:

1. Se houver checkboxes Markdown, usar seus textos como critérios.
2. Senão, procurar listas sob cabeçalhos reconhecidos como `Requisitos`,
   `Critérios de aceite`, `Acceptance criteria` ou `Requirements`.
3. Senão, se houver pelo menos dois itens numerados ou com marcadores, usar os
   itens como critérios.
4. Senão, usar o objetivo completo como `c1`.

Marcadores aceitos: `-`, `*`, `+`, `1.`, `1)` e checkboxes `[ ]`/`[x]`. O estado
inicial do checkbox não determina satisfação; ele é apenas sintaxe do objetivo.
Itens vazios são ignorados. O parser normaliza quebras de linha e espaços, mas
preserva o texto substantivo e a ordem.

O parser não resume, reescreve, deduplica semanticamente nem cria requisitos
implícitos. Se uma extração produzir mais de 16 itens, o contrato cai para um
critério único contendo o objetivo completo e registra diagnóstico local de
fallback.

### Edição do Goal

`/goal edit <novo objetivo>`:

1. atualiza o objetivo;
2. incrementa `contract.revision`;
3. deriva o novo contrato;
4. persiste imediatamente o estado;
5. invalida qualquer rascunho de conclusão, mas não altera o histórico de
   mutações nem o cache de gates por si só.

O agente não recebe uma ferramenta separada para mudar os critérios. Assim, ele
não pode reduzir o contrato no meio do trabalho para facilitar a conclusão. A
mudança de escopo continua sob controle explícito do usuário via `/goal edit`.

### Presença no prompt

O bloco dinâmico do Goal passa a mostrar status, revisão e critérios com IDs. Não
deve repetir o objetivo inteiro e depois repetir todos os itens. Para objetivos
estruturados, renderiza o preâmbulo uma vez e anota os itens; para objetivo
simples, renderiza apenas `[c1] <objetivo>`.

O renderer escapa pelo menos `&`, `<` e `>` antes de inserir texto do usuário no
bloco delimitado. O parser trabalha com o texto original; o escape pertence
somente à apresentação no prompt.

Exemplo:

```xml
<goal status="active" contract_revision="1">
Objetivo: melhorar a conclusão do Goal
[c1] exigir cobertura requisito por requisito
[c2] persistir evidências reais
[c3] funcionar sem configuração
</goal>
```

O texto imutável de regras continua no prefixo cacheável. O contrato fica no
sufixo dinâmico porque pode mudar por `/goal edit`, mas seu tamanho permanece
equivalente ao objetivo que já era enviado.

## Entrada estruturada de `goal_complete`

### Schema

Expandir o input sem remover `summary`:

```ts
interface GoalCompleteCriterionInput {
  id: string;
  outcome: string;
  evidence: Array<
    | { kind: "path"; path: string; note?: string }
    | { kind: "claim"; note: string }
  >;
}

interface GoalCompleteToolInput {
  summary?: string;
  contractRevision?: number;
  criteria?: GoalCompleteCriterionInput[];
}
```

`contractRevision` e `criteria` permanecem opcionais no TypeBox somente para
oferecer uma mensagem de migração útil a clientes/modelos que ainda enviem apenas
`summary`. No runtime, ambos são obrigatórios enquanto o Goal possuir contrato.
`contractRevision` deve ser inteiro positivo e igual à revisão atualmente
persistida; uma chamada iniciada antes de `/goal edit` é recusada como stale e
recebe o contrato novo.

`GoalCompleteToolDetails` passa a expor `receipt?: GoalCompletionReceipt` quando
`completed` for true. Recusas podem expor códigos estruturados e IDs pendentes,
mas nunca um recibo parcial persistido.

Limites propostos:

| Campo | Limite |
|---|---:|
| `summary` | 1.200 caracteres |
| `outcome` | 600 caracteres por critério |
| `note` | 400 caracteres |
| referências | 6 por critério |
| payload canônico do recibo | 24 KiB |

### Validação de cobertura

Antes de executar gates potencialmente caros, `goal_complete` valida:

1. a revisão do contrato ainda é a mesma usada para renderizar o prompt;
2. todos os IDs do contrato aparecem exatamente uma vez;
3. não há ID desconhecido;
4. todo `outcome` é não vazio;
5. todo critério possui pelo menos uma evidência;
6. toda referência cabe nos limites;
7. todo path está normalizado e contido em `cwd`;
8. quando `mutatedPaths` contém paths conhecidos, um Goal mutante cita ao menos
   um deles.

Falha retorna a lista exata de critérios ausentes, duplicados ou inválidos. Essa
recusa não consome o waiver de self-review ou impacto e não executa os gates.

### Classificação de paths

O runtime resolve cada `path` sem usar shell e produz uma destas classificações:

- `changed-file`: existe e consta em `mutatedPaths`;
- `deleted-file`: consta em `mutatedPaths`, mas não existe mais;
- `referenced-file`: existe dentro de `cwd`, mas não foi alterado pelo Goal;
- inválido: sai de `cwd`, é vazio ou não existe e também não consta nas mutações.

Referências inválidas bloqueiam a conclusão. `claim` é permitido para condições
sem representação em arquivo, mas fica explicitamente marcado como
`attested`. Um claim nunca é convertido em evidência observada.

Para paths existentes, a referência deve apontar para arquivo, não diretório. A
contenção considera `resolve`, `relative` e o caminho real do arquivo, impedindo
escape por `..`, volume diferente ou symlink. No Windows, a comparação respeita
a semântica case-insensitive. Para um path deletado, que já não possui `realpath`,
a contenção lexical e a presença exata em `mutatedPaths` são obrigatórias.

Uma mutação pode ser detectada sem path atribuível, por exemplo em um Bash que o
sentinela reconheceu como mutante. Nesse caso o recibo preserva
`mutationRevision > 0`, registra `attribution: "unknown"` e continua exigindo os
gates globais; ele não força o agente a inventar um arquivo.

## Recibo de conclusão

### Modelo de dados

```ts
interface GoalEvidenceReceipt {
  kind: "changed-file" | "deleted-file" | "referenced-file" | "attested";
  ref?: string;
  note?: string;
}

interface GoalCriterionReceipt {
  id: string;
  text: string;
  outcome: string;
  evidence: GoalEvidenceReceipt[];
  grounding: "observed" | "attested";
}

interface GoalGateReceipt {
  id: string;
  label: string;
  source: string;
  status: "passed";
  cached: boolean;
  durationMs?: number;
}

interface GoalCompletionReceipt {
  version: 1;
  goalId: string;
  objective: string;
  contractRevision: number;
  criteria: GoalCriterionReceipt[];
  mutations: {
    revision: number;
    paths: string[];
    attribution: "known" | "unknown" | "not_applicable";
  };
  verification: {
    mechanism: "goal-gates" | "legacy-probe" | "none";
    status: "passed" | "inapplicable";
    reason?: string;
    gates: GoalGateReceipt[];
  };
  safeguards: {
    pendingVerificationChecks: "clear";
    selfReview: "passed" | "not_applicable" | "waived";
    impactReview: "passed" | "not_applicable" | "waived";
  };
  usage: {
    tokens: number;
    iterations: number;
    activeMs: number;
  };
  completedAt: number;
}
```

Tipos concretos podem ser ajustados durante a implementação, mas os estados de
honestidade (`inapplicable`, `attested`, `waived`, `cached`) são requisitos e não
podem ser colapsados em `passed`.

Para Goal sem mutação, `mutations.revision` é `0` e `attribution` é
`not_applicable`. O campo `verification.mechanism` impede que um probe legado
verde seja confundido com o pipeline completo de gates.

### Composição dos gates

O recibo é construído a partir dos dados do runtime:

- gates executados nesta tentativa usam status e duração retornados por
  `runGoalGates`;
- gates verdes reaproveitados da mesma `mutationRevision` aparecem com
  `cached: true` e sem duração inventada;
- se não houver toolchain aplicável, o motivo real vira `inapplicable`;
- no Goal read-only, o probe legado continua sendo usado e seu resultado é
  representado como verificação global, sem guardar output bruto;
- uma nova mutação invalida o cache de gates como já ocorre hoje.

Não é necessário expandir `GoalGateProgress` para guardar output ou duração. Na
conclusão, a definição detectada dos gates e os IDs verdes atuais são suficientes
para reconstruir entradas cached honestas.

### Self-review e impacto

As regras de terminação existentes continuam válidas: self-review e impacto
podem recusar uma vez e liberar a segunda tentativa. A implementação deve manter
um booleano local para cada barreira durante a chamada de conclusão:

- condição ausente: `passed` ou `not_applicable`, conforme a barreira rodou;
- primeira recusa: não há recibo, pois o Goal permanece ativo;
- liberação após recusa já consumida: `waived` no recibo e diagnóstico warn.

Se self-review ou impact guard estiver explicitamente desabilitado pelos
kill-switches já existentes, o recibo usa `not_applicable`; nunca `passed`.

O recibo guarda a existência do waiver, não o conteúdo integral de findings ou
listas de impacto. O transcript e os diagnósticos continuam sendo a fonte de
detalhe.

### Persistência e restauração

`GoalManager.complete(summary?, receipt?)` passa a aceitar o recibo canônico e o
persiste junto do `summary`. Manter o segundo argumento opcional preserva os
callers e testes internos que hoje chamam somente `complete("...")`. Quando há
receipt, `completedAt` do recibo e do estado são definidos pelo mesmo relógio e
no mesmo commit de estado. O custom entry `goal` existente continua sendo o
único mecanismo de persistência.

O restore da sessão deve carregar também o último Goal concluído no
`GoalManager`, mas ativar `goal_complete`, governador e auto-continuação somente
quando o status não for `complete`. Isso permite consultar o último recibo após
reiniciar sem reabrir o Goal.

Sessões antigas:

- Goal ativo sem contrato: deriva contrato com `source: legacy-restore`;
- Goal completo sem recibo: mantém summary e mostra “receipt unavailable for
  legacy goal”;
- custom entry nulo de `/goal clear`: continua removendo o estado visível;
- nenhum arquivo de migração é criado.

## Ordem final de `goal_complete`

1. Confirmar que existe Goal ativo.
2. Validar cobertura e referências do contrato.
3. Recusar checks de verificação ainda em background.
4. Para Goal mutante, detectar e executar o pipeline de gates.
5. Para Goal read-only, consultar o probe legado quando disponível.
6. Aplicar a barreira de self-review.
7. Aplicar a barreira de impacto de imports.
8. Canonicalizar evidências e reconstruir gates cached/executados.
9. Criar e limitar o recibo.
10. Persistir receipt + summary e marcar o Goal como `complete`.
11. Limpar bookkeeping de recusas e parar auto-continuação.
12. Retornar recibo compacto no texto e completo em `details.receipt`.

Essa ordem evita gastar tempo com testes quando a própria cobertura está
incompleta e impede persistir um recibo para uma tentativa recusada.

## UX

### Durante o Goal

- O prompt recebe IDs estáveis dos critérios.
- `/goal status` mostra `contract: N criteria · revision R`.
- O overlay mostra apenas a contagem, sem inserir o texto inteiro no rodapé.
- `/goal edit` informa que gerou uma nova revisão do contrato.

### Na conclusão

O resultado textual de `goal_complete` permanece curto:

```text
Goal complete: melhorar conclusão do Goal
Contract: 3/3 covered · verification passed · 4 changed files
Safeguards: self-review passed · impact waived
```

`details.receipt` fornece a estrutura completa para RPC, exportadores e testes.

### Consulta posterior

Adicionar `/goal receipt`:

- mostra critérios, outcomes e referências em formato compacto;
- identifica evidência `attested`, gate cached e waiver;
- funciona após restore do último Goal concluído;
- em Goal legado, explica que somente o summary está disponível.

O painel interativo de `/goal` pode oferecer “View receipt” quando houver recibo,
sem criar um novo fluxo obrigatório.

## Diagnósticos e privacidade

Registrar somente diagnósticos locais estruturados:

- `quality.goal-contract` para derivação, fallback e revisão;
- `quality.goal-receipt` para conclusão, contagem de critérios e estado dos
  safeguards.

Não registrar conteúdo completo do objetivo, outcomes, paths absolutos ou output
de comandos em telemetria. O recibo permanece na sessão local já pertencente ao
usuário. Paths persistidos são relativos e normalizados.

## Arquivos previstos

### Novos

- `packages/coding-agent/src/core/goal/goal-contract.ts`
  - tipos, parser puro, limites e renderização compacta;
- `packages/coding-agent/src/core/goal/goal-receipt.ts`
  - tipos, canonicalização e validação de evidências;
- `packages/coding-agent/test/goal-contract.test.ts`
  - parser, revisão, limites e fallback;
- `packages/coding-agent/test/goal-receipt.test.ts`
  - validação de paths, honestidade e limite de payload.

### Alterados

- `packages/coding-agent/src/core/goal/goal-manager.ts`
  - contrato/recibo no estado, start/edit/restore/complete, prompt e resumo;
- `packages/coding-agent/src/core/tools/goal-complete.ts`
  - schema, cobertura, ordem das barreiras e montagem do recibo;
- `packages/coding-agent/src/core/agent-session.ts`
  - persistência e restauração read-only de Goal concluído;
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
  - `/goal receipt` e mensagens de edição;
- `packages/coding-agent/src/modes/interactive/components/goal-overlay.ts`
  - contagem compacta de critérios;
- `packages/coding-agent/src/modes/interactive/goal-dialog.ts`
  - ação opcional “View receipt”;
- `packages/coding-agent/docs/goals.md`
  - contrato, schema de conclusão, recibo e exemplos atuais;
- `packages/coding-agent/test/goal-manager.test.ts`
  - lifecycle, clone, edit, complete e restore;
- `packages/coding-agent/test/goal-complete-tool.test.ts`
  - cobertura por critério e details do recibo;
- `packages/coding-agent/test/goal-complete-gate.test.ts`
  - gates executados, cached, inapplicable e background;
- `packages/coding-agent/test/goal-complete-impact.test.ts`
  - impacto passed/refused/waived no recibo;
- `packages/coding-agent/test/self-review.test.ts`
  - self-review passed/refused/waived no recibo;
- `packages/coding-agent/test/goal-overlay.test.ts`
  - UI compacta;
- `packages/coding-agent/test/goal-dialog.test.ts`
  - consulta opcional do recibo;
- `packages/coding-agent/test/goal-auto-continue.test.ts`
  - conclusão estruturada continua encerrando o loop.

Não editar `CHANGELOG.md`.

## Plano de implementação com TDD

### Fase 1 — contrato puro

1. Escrever testes vermelhos para objetivo simples, checkboxes, listas sob
   cabeçalho, listas genéricas, CRLF, itens vazios e mais de 16 critérios.
2. Implementar `deriveGoalContract` até os testes ficarem verdes.
3. Adicionar testes de GoalManager para start, edit, clone e restore legado.
4. Integrar contrato ao prompt sem duplicar o objetivo.

Gate local:

```powershell
cd packages/coding-agent
npx vitest --run test/goal-contract.test.ts test/goal-manager.test.ts
```

### Fase 2 — validação de evidências

1. Escrever testes vermelhos para IDs ausentes, extras e duplicados.
2. Cobrir path alterado, referenciado, deletado, inexistente e fora de `cwd`.
3. Cobrir claim attested, path mutado conhecido e mutação sem path atribuível.
4. Implementar canonicalização sem shell e sem ler conteúdo dos arquivos.
5. Cobrir limites por campo e payload total.

Gate local:

```powershell
cd packages/coding-agent
npx vitest --run test/goal-receipt.test.ts test/goal-complete-tool.test.ts
```

### Fase 3 — composição com barreiras nativas

1. Validar cobertura antes de qualquer gate.
2. Montar entradas de gates executados e cached.
3. Representar ausência de toolchain como `inapplicable`.
4. Registrar honestamente self-review e impacto waived.
5. Garantir que tentativa recusada não persiste recibo.
6. Garantir que mutação posterior invalida gates e exige nova conclusão.

Gate local:

```powershell
cd packages/coding-agent
npx vitest --run test/goal-complete-gate.test.ts test/goal-complete-impact.test.ts test/self-review.test.ts test/goal-mutation-tracking.test.ts
```

### Fase 4 — persistência, UI e documentação

1. Persistir Goal concluído com receipt no custom entry existente.
2. Restaurar o último Goal concluído sem reativar autonomia.
3. Implementar `/goal receipt` e a visualização compacta.
4. Atualizar `goals.md` com exemplos reais e limites atuais.
5. Atualizar os testes de UI e auto-continue.

Gate local:

```powershell
cd packages/coding-agent
npx vitest --run test/goal-overlay.test.ts test/goal-dialog.test.ts test/goal-auto-continue.test.ts test/goal-manager.test.ts
```

### Fase 5 — integração

Executar a escada do projeto:

```powershell
npm run check:fast
npm run check
./test.ps1
```

Falhas fora dos arquivos tocados devem ser registradas separadamente, com prova
de que os testes focados do recurso passaram. Não corrigir WIP paralelo como
parte desta entrega.

## Matriz mínima de testes

| Cenário | Resultado obrigatório |
|---|---|
| Objetivo simples | contrato `c1` com texto integral |
| Objetivo com três checkboxes | três critérios estáveis |
| Mais de 16 itens | fallback para objetivo integral, sem omissão |
| `/goal edit` | revisão incrementada e contrato recalculado |
| Restore ativo antigo | contrato `legacy-restore`, autonomia preservada |
| Restore completo antigo | summary disponível, recibo marcado indisponível |
| Critério ausente | conclusão recusada antes dos gates |
| ID desconhecido/duplicado | conclusão recusada com mensagem exata |
| Path fora de `cwd` | conclusão recusada |
| Arquivo deletado pelo Goal | evidência `deleted-file` válida |
| Goal mutante com paths conhecidos, sem citar nenhum | conclusão recusada |
| Goal mutante sem nenhum path conhecido | receipt com attribution unknown, gates ainda obrigatórios |
| Goal read-only com claim | conclusão permitida como `attested` após probe |
| Gate novo verde | receipt `passed`, `cached: false`, duração real |
| Gate verde reaproveitado | receipt `passed`, `cached: true`, sem duração falsa |
| Sem toolchain | receipt `inapplicable` com motivo |
| Self-review libera na segunda tentativa | receipt `selfReview: waived` |
| Impacto libera na segunda tentativa | receipt `impactReview: waived` |
| Tentativa recusada | nenhum receipt persistido |
| Goal completo restaurado | `/goal receipt` funciona, auto-continue desligado |
| Payload excessivo | conclusão recusada sem corromper sessão |

## Critérios de aceite do recurso

- `/goal <objetivo>` cria contrato sem argumento extra.
- O agente vê IDs e texto de todos os critérios no prompt.
- `goal_complete` não conclui se algum critério estiver ausente ou sem evidência.
- Paths externos ou inexistentes não são aceitos como referência.
- Claims permanecem explicitamente attested.
- Gates, cache, inapplicability e waivers são representados com honestidade.
- O recibo sobrevive ao reload da sessão sem reativar o Goal.
- A conclusão continua terminando em tempo finito sob as regras atuais de waiver.
- O recurso não adiciona chamada LLM, daemon, download ou configuração.
- O prompt não duplica o objetivo e mantém crescimento limitado.
- Sessões antigas abrem sem migração manual.
- Testes focados, `check:fast`, `check` e `test.ps1` passam, ou bloqueios externos
  são separados com evidência.

## Riscos e contenções

### Parser confundir passos com requisitos

Contenção: precedência para checkboxes e seções nomeadas, extração genérica apenas
com dois ou mais itens e fallback para objetivo integral. Não há inferência
semântica invisível.

### Recibo criar falsa sensação de prova

Contenção: vocabulário explícito (`observed`, `attested`, `inapplicable`,
`waived`) e gates globais separados da cobertura semântica.

### Tool schema aumentar atrito para modelos fracos

Contenção: critérios com IDs aparecem no prompt, schema permanece pequeno e uma
chamada antiga recebe erro acionável com o formato esperado, não falha genérica.

### Recibo aumentar a sessão

Contenção: sem outputs/diffs, limites por campo, paths relativos, máximo de seis
referências por critério e teto total de 24 KiB.

### Restore de Goal completo alterar comportamento

Contenção: restaurar somente para leitura; não registrar ferramenta, governador,
spinner ou continuação. Testar explicitamente todos esses negativos.

## Rollback

A implementação deve permanecer concentrada nos dois módulos novos e nas seams
de Goal existentes. O rollback remove:

1. contract/receipt opcionais de `GoalState`;
2. validação estruturada de `goal_complete`;
3. restauração read-only de Goal completo;
4. `/goal receipt` e indicadores de UI.

Como não há migração de arquivo nem configuração nova, versões anteriores
ignoram os campos extras do JSON. Nenhum dado do projeto do usuário precisa ser
revertido.
