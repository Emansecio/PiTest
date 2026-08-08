# Oportunidades de polimento da TUI/CLI

> Auditoria inicial realizada em 2026-08-07 e revalidada contra o código atual antes da implementação. Itens já resolvidos ou falsos positivos foram preservados sem mudanças desnecessárias.

## Objetivo e escopo

Foram revisadas cinco áreas independentes: renderização da TUI, editor e input, animações e loaders, tema e layout, além de resiliência de terminal/CLI.

A ordem abaixo combina impacto para o usuário, risco de corrupção visual ou de dados e custo provável de implementação. Os achados devem ser confirmados com testes de reprodução antes de qualquer alteração.

## Resultado da revalidação

| Item | Classificação | Resultado |
| --- | --- | --- |
| 1–4 | Confirmados | Implementados com regressões focadas. |
| 5 | Já resolvido | `TUI.stop()` já limpa callbacks de animação; o teardown interativo já descarta timers e subscriptions relevantes. |
| 6–8 | Confirmados | Navegação visual Unicode, invalidação contextual e mouse do autocomplete corrigidos. |
| 9 | Já resolvido | `wordWrapLine()` já força quebra segura de whitespace/graphemes longos. |
| 10–15 | Confirmados | Seleção por teclado, larguras extremas, erro virtualizado, fallback ASCII, clamps de estado e modo sem cor implementados. |
| 16–21 | Confirmados | Queries em terminal dumb, bytes UTF-8, editor externo, caches, JPEG e `selectedPrefix` corrigidos. |
| 22 | Já resolvido | Os três selectors já usam `beginSelectorSurface(..., true)` e compartilham a superfície inline. |
| 23–25 | Confirmados | Schema de diff, elapsed sem frames e cadência cromática dos loaders corrigidos. |


## Ordem recomendada

### 1. Corrigir cópia de pastes grandes

- **Prioridade:** Alta
- **Área:** Editor / clipboard
- **Local:** `packages/tui/src/components/editor.ts:1381-1382,1823-1835`
- **Problema:** Ao copiar um paste grande, o clipboard pode receber o marcador `[paste #1 ...]` em vez do conteúdo expandido.
- **Melhoria:** Expandir marcadores antes de `copySelection`.
- **Validação:** Colar mais de 10 linhas, selecionar o marcador e copiar por Alt+C e clique direito; comparar o clipboard com o conteúdo original.

### 2. Preservar pastes grandes ao trocar de editor

- **Prioridade:** Alta
- **Área:** Editor customizado
- **Local:** `packages/coding-agent/src/modes/interactive/interactive-mode.ts:3413,3426,3466`
- **Problema:** A troca entre editor padrão e customizado pode transferir o marcador como texto literal e perder o mapa do paste.
- **Melhoria:** Usar texto expandido (`getExpandedText?.() ?? getText()`) na transferência.
- **Validação:** Fazer paste grande, ativar/restaurar editor customizado e confirmar que o conteúdo enviado permanece idêntico.

### 3. Tornar `--mode text` realmente headless

- **Prioridade:** Alta
- **Área:** Inicialização CLI
- **Local:** `packages/coding-agent/src/main.ts:179-189`
- **Problema:** Com stdin TTY, `--mode text` pode iniciar a TUI e parecer travado.
- **Melhoria:** Tratar explicitamente esse modo como print/headless.
- **Validação:** Executar com stdin TTY, pipe e redirecionamento; confirmar ausência de cursor, queries e loop interativo.

### 4. Corrigir contraste da seleção no tema claro

- **Prioridade:** Alta
- **Área:** Tema / acessibilidade
- **Local:** `packages/coding-agent/src/modes/interactive/theme/theme.ts:1563-1568`, `light.json:29-31`
- **Problema:** O runtime usa `accent` sobre `selectedBg`, estimado em aproximadamente 3.1:1.
- **Melhoria:** Usar foreground escuro para texto selecionado e reservar `accent` para cursor/borda/indicador.
- **Validação:** Adicionar teste de contraste específico para texto selecionado nos temas claro e escuro.

### 5. Completar teardown de animações

- **Prioridade:** Alta
- **Área:** Lifecycle / animação
- **Local:** `packages/coding-agent/src/modes/interactive/interactive-mode.ts:9552-9595`
- **Problema:** Componentes e callbacks ativos podem permanecer retidos após shutdown ou restart.
- **Melhoria:** Auditar e centralizar `dispose()` para `fusionLive`, `agentsLive`, componentes de chat e eases.
- **Validação:** Iniciar/parar/reiniciar a TUI e verificar que callbacks e timers não continuam ativos.

### 6. Corrigir navegação vertical com CJK e emoji

- **Prioridade:** Média
- **Área:** Editor / largura visual
- **Local:** `packages/tui/src/components/editor.ts:2458-2482,2835-2853`
- **Problema:** O mapa visual mistura índices UTF-16 com colunas visuais.
- **Melhoria:** Armazenar comprimento lógico e largura visual separadamente; converter com `sliceByColumn()`.
- **Validação:** Usar linhas ASCII, CJK e emoji com wrap; comparar a coluna do cursor após ↑/↓.

### 7. Invalidar autocomplete ao mover o cursor

- **Prioridade:** Média
- **Área:** Editor / autocomplete
- **Local:** `packages/tui/src/components/editor.ts:1400-1608`
- **Problema:** Sugestões e prefixo podem continuar associados à posição anterior.
- **Melhoria:** Cancelar ou recalcular autocomplete após movimento, seleção ou mudança de contexto.
- **Validação:** Abrir sugestões, usar ←/Home/Alt+← e confirmar que Tab/Enter não altera o trecho errado.

### 8. Delegar mouse do dropdown de autocomplete

- **Prioridade:** Média
- **Área:** Editor / mouse
- **Local:** `packages/tui/src/components/editor.ts:1183-1190,2323-2367`
- **Problema:** Clique no dropdown pode ser tratado como seleção do texto principal.
- **Melhoria:** Encaminhar as coordenadas ao `SelectList` ou criar alvo de mouse próprio.
- **Validação:** Selecionar sugestões por clique em diferentes linhas e confirmar o item escolhido.

### 9. Corrigir wrap de sequências longas de espaços

- **Prioridade:** Média
- **Área:** Editor / layout
- **Local:** `packages/tui/src/components/editor.ts:157-186`
- **Problema:** Um trecho de whitespace pode exceder `maxWidth` e gerar overflow.
- **Melhoria:** Validar `wrapOppWidth <= maxWidth` e quebrar runs de espaços quando necessário.
- **Validação:** Exercitar `wordWrapLine` com espaços, tabs e largura 1–10; garantir que cada linha respeita a largura.

### 10. Adicionar seleção por teclado

- **Prioridade:** Média
- **Área:** Editor / acessibilidade
- **Local:** `packages/tui/src/keybindings.ts:18-32,129`; `editor.ts:1378-1382`
- **Problema:** Sem mouse, não há seleção completa para copiar texto.
- **Melhoria:** Adicionar Shift+setas e Ctrl/Alt+Shift para seleção por palavra, mantendo Alt+C.
- **Validação:** Selecionar, expandir, reduzir e copiar usando somente teclado.

### 11. Tornar componentes seguros em larguras extremas

- **Prioridade:** Média
- **Área:** Layout base
- **Locais:** `packages/tui/src/components/box.ts:97,117-124`; `truncated-text.ts:57,72-74`; `input.ts:471-474,546-549`
- **Problema:** Padding e prompt podem ultrapassar `width=1`.
- **Melhoria:** Clampar padding efetivo e truncar o prompt ao viewport.
- **Validação:** Adicionar casos de `narrow-width-invariant` para larguras 0, 1, 2 e 3.

### 12. Sanitizar erros do container virtualizado

- **Prioridade:** Média
- **Área:** Renderização / robustez
- **Local:** `packages/tui/src/virtualized-container.ts:9-16`
- **Problema:** `error.message` pode conter newline, ANSI e largura arbitrária.
- **Melhoria:** Reutilizar sanitização de falhas do `tui.ts` e truncar pela largura disponível.
- **Validação:** Lançar erros com ANSI, newline e texto longo; garantir uma linha segura e width-safe.

### 13. Uniformizar fallback ASCII de `TERM=dumb`

- **Prioridade:** Média
- **Área:** Terminal degradado
- **Locais:** `packages/coding-agent/src/modes/interactive/components/todo-overlay.ts:160,205,213`; `goal-overlay.ts:113,135,147`
- **Problema:** Spinners podem ser ASCII, mas overlays continuam emitindo box-drawing Unicode.
- **Melhoria:** Usar `glyph-resolver` também para conectores e molduras.
- **Validação:** Renderizar overlays com `TERM=dumb` e confirmar saída ASCII consistente.

### 14. Proteger footer e corpo de activity em terminais estreitos

- **Prioridade:** Média
- **Área:** Layout / mensagens de estado
- **Locais:** `footer.ts:791-797`; `activity-line.ts:367-373`
- **Problema:** Alertas e linhas do corpo podem exceder a largura; estados `✓`/`✗` podem desaparecer por truncamento.
- **Melhoria:** Proteger prefixo/ícone de estado e aplicar clamp final a todas as linhas.
- **Validação:** Testar larguras de 1 a 40, estados de sucesso/erro e mensagens longas.

### 15. Respeitar `NO_COLOR` em todos os caminhos

- **Prioridade:** Média
- **Área:** Tema / acessibilidade
- **Locais:** `todo-overlay.ts:36-37`; `theme.ts:1538`; `editor.ts:1075,1896`
- **Problema:** SGR direto e `chalk` podem emitir ANSI quando o modo de cor é `none`.
- **Melhoria:** Centralizar estilos em helpers conscientes de `ColorMode`.
- **Validação:** Executar com `NO_COLOR`, modo `none` e terminal normal; verificar ausência/presença correta de ANSI.

### 16. Bloquear queries visuais em `TERM=dumb`

- **Prioridade:** Média
- **Área:** Terminal / inicialização
- **Local:** `packages/tui/src/tui.ts:1025-1052`
- **Problema:** O TUI ainda pode emitir `CSI 16t`, `CSI 14t` e `CSI c` em terminais mínimos.
- **Melhoria:** Desativar probes de tamanho, Kitty e Sixel sem capacidade ANSI confirmada.
- **Validação:** Capturar stdout em `TERM=dumb` e confirmar ausência de queries.

### 17. Corrigir contagem de bytes de paste

- **Prioridade:** Média
- **Área:** Input / Unicode
- **Locais:** `packages/tui/src/components/editor.ts:370,2101-2104`; `input.ts:17,444-447`
- **Problema:** `string.length` conta UTF-16, não bytes reais, e pode cortar surrogate pairs.
- **Melhoria:** Usar `Buffer.byteLength` e truncamento em fronteira Unicode segura.
- **Validação:** Testar emoji, CJK e conteúdo próximo ao limite; comparar bytes reportados e preservados.

### 18. Corrigir resolução de editor externo com espaços

- **Prioridade:** Média
- **Área:** Integração CLI
- **Local:** `packages/coding-agent/src/modes/interactive/interactive-mode.ts:6646`
- **Problema:** `split(" ")` quebra executáveis/caminhos com espaços e falhas podem ser silenciosas.
- **Melhoria:** Reutilizar o resolvedor de `components/extension-editor.ts:38-60` e reportar erro de processo.
- **Validação:** Testar `$VISUAL` e `$EDITOR` com caminhos entre aspas, argumentos e falha de execução.

### 19. Limitar caches de renderização por memória

- **Prioridade:** Baixa/Média
- **Área:** Performance
- **Local:** `packages/tui/src/tui.ts:646,694,2089,2426`
- **Problema:** Chaves de linha podem ser enormes; o limite atual é por quantidade de entradas.
- **Melhoria:** Não cachear linhas acima de limite ou usar orçamento aproximado em bytes.
- **Validação:** Sessão com linhas grandes e muitas larguras; medir heap e GC.

### 20. Aceitar marcadores JPEG adicionais

- **Prioridade:** Baixa/Média
- **Área:** Imagens no terminal
- **Local:** `packages/tui/src/terminal-image.ts:406-433`
- **Problema:** JPEGs progressivos e outros SOF válidos podem cair no fallback 800×600.
- **Melhoria:** Aceitar todos os SOF relevantes e continuar parsing até encontrar dimensões, mantendo teto de segurança.
- **Validação:** Fixtures JPEG baseline, progressivo e marcadores suportados; comparar dimensões detectadas.

### 21. Usar `selectedPrefix` do tema

- **Prioridade:** Baixa
- **Área:** Selectors / tema
- **Local:** `packages/tui/src/components/select-list.ts:62-71,388-396`
- **Problema:** A API expõe `selectedPrefix`, mas o componente renderiza `→ ` fixo.
- **Melhoria:** Aplicar o token configurado ou removê-lo da API.
- **Validação:** Tema de teste com prefixo customizado e snapshot da lista selecionada.

### 22. Padronizar superfícies de selectors

- **Prioridade:** Baixa
- **Área:** Hierarquia visual
- **Locais:** `components/selector-surface.ts:1-4`; `settings-selector.ts:578`; `tree-selector.ts:1315`; `extension-selector.ts:55`
- **Problema:** Selectors inline e overlays usam bordas, backgrounds e títulos inconsistentes.
- **Melhoria:** Definir padrão para superfície inline e reservar card completo para modal.
- **Validação:** Comparar selectors lado a lado em tema claro/escuro e largura estreita.

### 23. Alinhar tokens de diff ao schema

- **Prioridade:** Baixa
- **Área:** Tema / extensibilidade
- **Local:** `packages/coding-agent/src/modes/interactive/theme/theme.ts:71-74,197-206,726-735`; `dark.json:71-72`; `light.json:70-71`
- **Problema:** `toolDiffAddedBg` e `toolDiffRemovedBg` existem no runtime/JSON, mas não no schema local.
- **Melhoria:** Atualizar schema, tipos e validação de temas customizados.
- **Validação:** Carregar tema customizado que declare ambos os tokens e validar sem cast/fallback silencioso.

### 24. Manter elapsed com indicador vazio

- **Prioridade:** Baixa
- **Área:** Loader / estado temporal
- **Local:** `packages/tui/src/components/loader.ts:384-395,436-445`
- **Problema:** Sem frames, o ticker não é criado e o elapsed pode congelar.
- **Melhoria:** Separar atualização do relógio da animação de glyphs.
- **Validação:** Loader com `frames: []`, elapsed habilitado e duração simulada; confirmar atualização contínua.

### 25. Reduzir repaint cromático dos loaders

- **Prioridade:** Baixa
- **Área:** Performance visual
- **Local:** `packages/tui/src/components/loader.ts:389-395,430-455`; `interactive-mode.ts:2567-2569`; `working-palette.ts:89-106`
- **Problema:** A cor pode recalcular a cada 16 ms enquanto o glyph muda a cada 80 ms.
- **Melhoria:** Sincronizar a atualização cromática com mudanças visíveis ou com uma frequência menor.
- **Validação:** Instrumentar callbacks e bytes emitidos; comparar ritmo atual e otimizado sem alterar a aparência percebida.

## Sequência sugerida de execução

1. **Integridade de dados e fluxo principal:** itens 1–3.
2. **Acessibilidade e legibilidade:** itens 4, 10, 14 e 15.
3. **Lifecycle e terminal degradado:** itens 5, 13 e 16.
4. **Editor e Unicode:** itens 6–9 e 17.
5. **Integrações externas:** item 18.
6. **Robustez de renderização:** itens 11–12.
7. **Tema e consistência visual:** itens 21–23.
8. **Performance e casos especializados:** itens 19, 20, 24 e 25.

## Observações

- A severidade é uma priorização de produto/UX, não uma confirmação de bug em todos os ambientes.
- Os itens devem ser implementados em mudanças pequenas, cada um com teste de regressão.
- A auditoria inicial foi somente leitura; as correções posteriores foram aplicadas após a revalidação registrada acima.
