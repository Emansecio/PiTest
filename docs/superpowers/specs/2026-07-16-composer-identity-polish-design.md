# Composer identity polish

## Objetivo

Simplificar a linha de identidade dentro da caixa de digitação do Pit. O rótulo `User (home)` deixa de ser exibido e o ID técnico do modelo passa a usar um nome curto, sem alterar o modelo selecionado nem os comandos que o gerenciam.

## Design aprovado

- Não renderizar o diretório quando a sessão estiver exatamente no diretório pessoal e não houver branch, nome de sessão ou divergência do shell que precise ser comunicada.
- Manter informações relevantes de workspace quando existirem, como projeto, branch, sessão nomeada ou shell em outro diretório.
- Exibir modelos conhecidos em formato curto: `claude-opus-4-8` vira `Opus 4.8`, `claude-sonnet-4-6` vira `Sonnet 4.6` e IDs equivalentes de GPT/Codex perdem prefixos técnicos redundantes.
- Preservar o ID original internamente. A abreviação é exclusivamente visual e o seletor `/model` continua mostrando a identificação completa quando necessário.
- Manter os chips de raciocínio e modo, mas usar somente texto: `High · auto`.
- Não usar estrela, emoji de cérebro ou ícone dependente de Nerd Font. Emojis variam entre terminais e fontes especiais não são portáveis; a cor do nível já comunica o estado sem decoração adicional.
- Em modelos desconhecidos, remover somente prefixos reconhecidos e preservar um rótulo legível; não inventar nomes comerciais.

## Composição esperada

```text
╭──────────────────────────────────────────────────────────────╮
│  Describe a task…                                            │
│                                        Opus 4.8 · High · auto│
╰──────────────────────────────────────────────────────────────╯
```

## Validação

- Testar a ausência de `User (home)` no estado inicial.
- Testar nomes curtos para Claude, GPT/Codex e fallback desconhecido.
- Garantir que projeto, branch, sessão e divergência do shell continuem visíveis.
- Verificar largura estreita e executar o build usado pelo comando `pit`.
- Garantir que nenhum `✦` ou emoji seja renderizado ao lado do nível de raciocínio.
