# ComposerChrome — caixa única do Pit

## Objetivo

Substituir a entrada aberta atual por um único retângulo inspirado na segunda imagem de referência. O texto digitável, o modelo/modo e o workspace ficam dentro da mesma moldura; o editor existente continua responsável por edição, cursor, autocomplete, histórico, anexos e envio.

## Causa do estado atual

O `Editor` em `packages/tui/src` já possui a opção experimental `closedFrame`, mas o launcher resolve `@pit/tui` pelo diretório compilado `packages/tui/dist`, que ainda não contém essa implementação. Por isso os testes diretos do fonte mostravam uma moldura fechada enquanto a execução real continuava exibindo apenas a linha superior.

Atualizar somente o `dist` fecharia o editor, mas deixaria os metadados fora da caixa. Isso não atende à referência aprovada.

## Design aprovado

Criar um `ComposerChrome` no pacote `coding-agent`. Ele recebe o componente editável e o rodapé existente, renderiza ambos na largura interna e desenha uma única moldura arredondada ao redor do conjunto.

```text
╭──────────────────────────── modelo · nível · modo ╮
│ mensagem e cursor                                 │
│                                                   │
│ workspace · branch                      estados   │
╰───────────────────────────────────────────────────╯
```

O rodapé continua sendo a única fonte dos metadados. O `ComposerChrome` apenas o move para dentro da moldura; não reconstrói modelo, cwd, branch ou métricas. Em terminais estreitos, o rodapé mantém suas regras atuais de quebra e truncamento.

## Composição

- O `Editor` deixa de desenhar sua própria moldura no Pit para evitar borda dupla.
- Um contêiner interno agrupa `editorContainer` e `FooterComponent`.
- `ComposerChrome` desenha os quatro lados em verde de destaque e preserva a largura visível de cada linha.
- Seletores e inputs temporários continuam substituindo o conteúdo de `editorContainer` dentro da mesma caixa.
- Rodapés customizados permanecem suportados dentro do retângulo.
- A abertura com globo e o histórico não entram na caixa.

## Ciclo e comportamento

- A caixa existe antes e depois do desaparecimento do globo.
- Crescimento multiline aumenta a altura interna sem perder a borda inferior.
- Autocomplete e busca do histórico permanecem dentro da largura útil.
- Troca de tema, Bash e Plan atualiza a cor da moldura pelo mesmo sinal já usado no editor.
- Não haverá opção para alternar entre a caixa antiga e a nova.

## Validação

- Teste unitário do `ComposerChrome` em largura ampla e estreita.
- Teste com múltiplas linhas e metadados, garantindo quatro lados e largura exata.
- Teste de integração da composição do modo interativo, garantindo editor e rodapé dentro do mesmo componente.
- Build obrigatório para atualizar `packages/tui/dist` e eliminar a divergência entre teste e execução.
- Verificação visual no launcher real do Windows.

## Fora do escopo

- Reescrever o editor ou o rodapé.
- Duplicar metadados em um novo modelo.
- Alterar fila, envio, globo, histórico ou comportamento dos modos.
- Copiar cores amarelas ou o rótulo `deep` literalmente; o Pit mantém seus dados e verde de destaque.
