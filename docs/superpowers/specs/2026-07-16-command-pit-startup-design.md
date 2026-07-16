# Command Pit na abertura

## Objetivo

Substituir integralmente o globo da tela inicial pelo **Command Pit**, uma animação ambiental exclusiva do Pit que comunica profundidade e foco. A animação aparece ao iniciar uma sessão interativa e desaparece definitivamente após a primeira mensagem, preservando o ciclo de vida já implementado.

## Escopo

- Remover o globo, seu mapa e a rotação por longitude.
- Manter `Bem-vindo ao Pit` e `/help para ajuda`, sem negrito adicional.
- Preservar a lógica atual que oculta o histórico enquanto a abertura está ativa e desmonta a abertura na primeira mensagem.
- Não usar o Command Pit como logotipo, favicon ou ícone pequeno.
- Não alterar nesta etapa a caixa de digitação nem a configuração de fonte do terminal.

## Geometria aprovada

A variante completa ocupa 24 colunas e 12 linhas. Há quatro níveis simétricos; cada nível recua dois caracteres em relação ao anterior. As três linhas finais convergem diretamente no núcleo, que substitui a junção inferior para não parecer desconectado.

```text
╭──────────────────────╮
 ╲                    ╱
  ╭──────────────────╮
   ╲                ╱
    ╭──────────────╮
     ╲            ╱
      ╭──────────╮
       ╲        ╱
        ╲      ╱
         ╲    ╱
          ╲  ╱
           ●
```

Em terminais estreitos, uma variante de 16 colunas mantém quatro níveis e o núcleo. Abaixo dessa largura, a abertura mostra somente os textos para evitar desenho truncado.

## Ritmo da animação

O ciclo dura 4.780 ms:

1. Quatro níveis ativos por 620 ms cada, de cima para baixo.
2. A convergência final ativa por 520 ms.
3. O núcleo recebe um flash de 260 ms.
4. O núcleo assenta por 620 ms.
5. Todos os níveis descansam por 900 ms antes do reinício.

Somente uma etapa recebe brilho máximo. Durante a descida, apenas a etapa imediatamente anterior permanece como rastro em intensidade intermediária. Não há duas etapas com a mesma intensidade principal.

## Cores e tipografia

- Estrutura inativa: `dim`.
- Rastro: `muted`.
- Foco e núcleo: `accent`.
- Nenhuma parte da animação ou do título usa `theme.bold()`.
- Não são usados emoji, Nerd Font ou caracteres de largura ambígua.

## Arquitetura

`command-pit.ts` será um componente puro e testável. `renderCommandPitFrame(width, elapsedMs)` escolhe a geometria responsiva, calcula a fase pelo tempo decorrido e devolve linhas já coloridas. `StartupScreen` posiciona o componente ao lado do texto em terminais largos e empilha os elementos em terminais estreitos.

`InteractiveMode` continuará usando o ticker compartilhado existente, mas passará tempo decorrido ao componente em vez de incrementar longitude. A assinatura do ciclo de vida permanece a mesma: ativar, animar, desmontar e cancelar a inscrição.

## Validação

- Dimensões e simetria das variantes completa e compacta.
- Um único foco principal por quadro e rastro limitado à etapa anterior.
- Fases de flash, assentamento e descanso do núcleo.
- Mudança determinística entre quadros e reinício exato do ciclo.
- Ausência de conteúdo ou imports relacionados ao globo.
- Larguras estreitas sem estouro.
- Desmontagem após a primeira mensagem.
- Build e execução real com `pit --offline`.
