# Proposta — Code-mode + Debug-driven verify (features de liderança)

Data: 2026-06-13. Objetivo: tirar o Pit da paridade e levá-lo à **liderança** explorando forças que os concorrentes não têm. Ambas nativas no `@pit/coding-agent`, reusando infra já existente.

## "Nativo" = zero config, o sistema aciona sozinho

Régua do dono: **você NUNCA entra em settings pra ligar nada nem cria launch.json/escolhe adapter** — o sistema detecta o que pode fazer e aciona por conta própria. Com essa régua:

|feature|você configura algo?|o sistema aciona sozinho?|cobertura|
|-|-|-|-|
|Code-mode|**não, nada**|**sim, sempre** — vem ligado; o model passa a usar quando há workflow multi-tool|universal (qualquer turno)|
|Debug-driven verify|**não, nada**|**sim, onde detecta o ambiente** — vem ligado; auto-detecta adapter + entry-point e dispara; onde não consegue inferir, fica quieto e cai no check-based|parcial por NATUREZA do alvo (não por config tua)|

O "parcial" do debug-driven é **cobertura**, NÃO esforço teu: em nenhum dos dois você liga, configura ou toca em settings. A única diferença real é que o code-mode aciona em 100% dos casos, e o debug-verify aciona onde o sistema CONSEGUE inferir o alvo (adapter instalado + entry-point detectável) — silenciosamente, sem te pedir nada. Onde não dá, ele não te incomoda; só não roda aquele tier extra.

**Princípio de design das duas: default-on, zero-config, auto-acionadas.** Os kill-switches (`PIT_NO_*`) existem só como escape de emergência — vêm desligados (= feature ligada), você nunca precisa tocá-los. Para o debug-verify, a meta de engenharia é **maximizar a auto-detecção** (test runners, scripts de package.json, stack-trace de crash, mains detectados) pra acionar no maior número de repos possível sem nenhuma config tua.

---

## Feature 1 — Code-mode

### O que é
Em vez de uma tool-call JSON por turno, o model escreve um pequeno programa JS que chama as tools como `await tools.read({path})`, `await tools.grep({...})`, compõe/filtra/itera sobre os resultados em código, e devolve só o que importa. Um loop de "ler 20 arquivos e achar os que casam X" colapsa de ~20 turnos (cada um: tool-call → resultado no contexto → próximo) para **1 turno** com um `for`.

### Por que importa (impacto: ALTO)
- **Token economy** (eixo onde o Pit já é forte): N resultados intermediários de tool nunca entram no contexto — só o resultado final do programa. Ataca o vetor dominante de inchaço (tool-output no histórico).
- **Latência**: N round-trips com o LLM viram 1.
- É o "single biggest architectural differentiator" que o codex tem e o resto não. Implementar = liderança vs cline/crush/opencode/forge/etc.

### Arquitetura no Pit (o que reusa, o que adiciona)
O Pit **já tem 80% disto**. O kernel JS (`eval-kernel/javascript.ts`) já é um `node` child com `node:vm` (`vm.createContext`) e um canal JSON-RPC linha-a-linha stdin/stdout (`{id, code}` → reply). Hoje o fluxo é unidirecional: main → child (código) → reply (output).

O que falta é o **protocolo bidirecional**: o código JS no vm-context precisa poder chamar de volta o agente (main process) pra executar uma tool real.

```
  main (agent)                         child (node:vm kernel)
     │   {id, code: "await tools.read({...}); ..."}   →
     │                                        executa no vm; ao chamar tools.read:
     │   ←   {toolCall: {callId, name:"read", args}}
     │  executa o ToolDefinition.execute real (fs/lsp/etc.)
     │   {toolResult: {callId, content}}     →
     │                                        a promise tools.read() resolve no vm
     │   ←   {id, result: <valor do programa>}
```

### Onde encaixa (arquivos)
- **`eval-kernel/javascript.ts`** (estende, NÃO substitui): o `DRIVER_SOURCE` ganha um objeto `tools` injetado no `vm.createContext`. Cada `tools.<name>(args)` emite `{toolCall}` no stdout e retorna uma Promise que resolve quando o `{toolResult}` chega no stdin. Precisa de um message-pump no driver pra casar `callId`s.
- **Novo `core/code-mode/bridge.ts`**: o lado-main do protocolo. Recebe `{toolCall}` do kernel, resolve o `ToolDefinition` pelo nome na lista de tools ativas da sessão, chama `.execute(callId, args, signal)`, devolve `{toolResult}`. **CRÍTICO**: passar pelo MESMO pipeline das tool-calls normais (permission-gate, tool-rewrite, learned-error, doom-loop) — o code-mode NÃO pode ser um bypass do harness anti-erro.
- **Nova tool `core/tools/code-mode.ts`** (ou um 2º modo na `eval.ts`): expõe ao model `{ code }` e roda via a bridge. Schema lista os `tools.*` disponíveis no `promptGuidelines`.
- **`agent-session.ts`** (wire): passa a lista de tools ativas + o dispatcher pro kernel; orça o tamanho dos tool-results re-injetados (um `tools.read` de 10MB não pode estourar o vm).
- **System-prompt** (`system-prompt.ts`): guideline curta "para workflows multi-tool (ler/filtrar/compor sobre muitos resultados), prefira `code` a N tool-calls". Isto é o que o torna **automático** — default-on, o model passa a usar sozinho.

### O que substitui
Nada é removido. O `eval` (computação stateful) e as tool-calls JSON normais continuam. Code-mode é um caminho ADICIONAL que o model escolhe para orquestração multi-tool. Na prática, com o tempo, muitos turnos de "tool-call em sequência" migram naturalmente para 1 turno de code-mode — mas isso é o model decidindo, não código deletado.

### Esforço / risco
- Esforço: **M-G**. O grosso é o protocolo bidirecional + o pump de `callId`s + a serialização segura de tool-results (com budget). A bridge e a tool são pequenas.
- Risco: **M**. (1) O vm-context já tem `require`/`process` (não é sandbox) — code-mode herda isso; aceitável no uso autônomo (já roda bash sem jail), mas as tool-calls do code-mode DEVEM passar pelo permission-gate. (2) Re-entrância/abort: cancelar um turno code-mode tem que matar o kernel + abortar tool-calls em voo. (3) Tool-results grandes precisam de cap antes de voltar ao vm.

### Como testar
Kernel com um `tools` fake que ecoa; programa que faz `await tools.echo()` × N e retorna agregado; assert que os resultados intermediários NÃO entram no contexto da sessão; abort no meio mata o kernel; tool-result acima do budget é truncado.

---

## Feature 2 — Debug-driven verify

### O que é
Hoje o verification-gate (`agent-session.ts` `_runVerificationGate` ~:2816 + `verification.ts`) re-roda o check do projeto (tsgo/biome/test) e re-injeta a falha como fix-prompt. Debug-driven adiciona um tier: quando o agente corrige um **bug com repro** (um teste/comando que crasha ou falha numa asserção), o gate pode **lançar o programa sob o debugger nativo**, parar no ponto suspeito, **inspecionar o estado real** (variables/stack/watch) e confirmar que o fix produz o estado esperado — em vez de confiar só no "o check passou".

### Por que importa (impacto: ALTO em ineditismo)
- **NENHUM dos 8 concorrentes tem debugger** (codex/cline/crush/opencode/forge/composio/ruflo/openclaude — todos marcaram DAP como ausência). É a vantagem mais difícil de copiar — exige portar um DAP client inteiro (o Pit já tem, 27 actions).
- Eleva a verificação de "passou o check" para "provei que o estado em runtime está correto" — qualidade de fix que ninguém entrega.

### Arquitetura no Pit (o que reusa, o que adiciona)
Reusa tudo que já existe: a tool `debug` (`tools/debug.ts`, 27 actions), o `dapSessionManager` e `selectLaunchAdapter` (`dap/`), e o verification-gate. Não há protocolo novo a inventar — é orquestração dos blocos existentes.

### Onde encaixa (arquivos)
- **`verification.ts`** (estende): um detector `isDebuggableRepro(touchedFiles, checkResult)` que reconhece o caminho feliz — há um adapter disponível (`getAvailableAdapters`) E um launch target inferível (test runner: `debugpy`/pytest, `dlv`/go test, `lldb-dap`; ou um crash com stack-trace cujo entry-point é conhecido).
- **Novo `core/debug-verify.ts`**: a rotina — `selectLaunchAdapter` → `debug.launch` no entry-point → `set_breakpoint` no ponto do fix → `continue` → `variables`/`evaluate` pra capturar o estado → `terminate`. Devolve um veredito + o snapshot de estado.
- **`agent-session.ts`** (wire, perto de `_runVerificationGate` ~:2816): após o check-based passar, SE `isDebuggableRepro`, roda o `debug-verify` como tier extra; o estado capturado vira contexto pro próximo turno ("no breakpoint, `x` era `undefined` — o fix não cobre o caso null").

### O que substitui
Nada. É um **tier adicional e opcional** sobre o verification-gate. Se o adapter não existe, o launch falha, ou o repro não é debugável → **cai graciosamente** no check-based atual (nunca bloqueia, nunca quebra um fluxo que funcionava). Default-on mas auto-desativável quando não aplicável; env `PIT_NO_DEBUG_VERIFY=1`.

### Esforço / risco
- Esforço: **M**. Os blocos existem; o trabalho é a heurística `isDebuggableRepro` + a sequência de launch/breakpoint/inspect + o fallback.
- Risco: **M**. O DAP é frágil (adapter ausente, launch trava, timeout). Mitigação: timeout curto, fail-open absoluto (qualquer erro → segue com o check-based), e começar só com 1-2 ecossistemas onde a inferência é robusta (pytest+debugpy, go test+dlv) antes de generalizar.

### Honestidade sobre "automático"
- **Automático** quando: adapter instalado + launch target inferível (test runner padrão, ou crash com stack). Aí o agente valida em runtime sem o usuário fazer nada.
- **NÃO automático** quando: linguagem sem adapter, projeto sem entry-point claro, app que precisa de setup (servidor/env). Aí o debug-verify se auto-desativa (o gate segue check-based) — e a tool `debug` continua disponível pro agente invocar manualmente.

---

## Plano de implementação sugerido (faseado)

1. **Code-mode primeiro** (maior ROI, automático de verdade, infra pronta):
   - Fase 1: protocolo bidirecional no kernel JS + `code-mode/bridge.ts` (com fake-tools nos testes).
   - Fase 2: tool `code-mode.ts` + wire no agent-session, passando pelo permission-gate/harness.
   - Fase 3: guideline no system-prompt (liga o "automático") + budget/abort/cap de tool-results.
2. **Debug-driven verify depois** (mais inédito, mas semi-automático):
   - Fase 1: `debug-verify.ts` + `isDebuggableRepro` restrito a pytest+debugpy e go+dlv.
   - Fase 2: wire no verification-gate como tier opcional, fail-open absoluto.
   - Fase 3: generalizar ecossistemas conforme a inferência se prova robusta.

Ambas seguem o padrão das levas anteriores: workflow de lanes disjuntas (code-mode toca `eval-kernel`+`code-mode`+`tools`; debug-driven toca `verification`+`debug-verify`+`agent-session`) → revisão adversarial → gate → commit/push 2 remotes.

## Riscos transversais
- **Code-mode não pode ser um bypass do harness**: as tool-calls de dentro do `tools.x()` precisam passar pelo permission-gate, tool-rewrite, learned-error e contar nos detectores de loop — senão o code-mode vira um buraco no harness anti-erro que é uma das maiores forças do Pit.
- **Debug-driven nunca bloqueia**: qualquer falha do DAP cai no check-based. O gate continua confiável.
