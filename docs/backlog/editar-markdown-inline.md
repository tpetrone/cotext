# Editar o texto direto na página, em Markdown

> **Característica:** Enhancement

Hoje a pessoa só muda o texto na página excluindo um trecho ou pedindo ao Claude. A ideia é deixar editar um bloco ali mesmo: o bloco renderizado vira sua fonte Markdown, a pessoa digita, e a mudança entra no rascunho como as outras, desfazível e gravada só no Revisar.

## Alinhamento ao produto

- Generaliza o **Excluir** (`deletePassage` em `hooks/register.tsx`): uma alteração feita pela pessoa, sem thread, que já vira hunk no rascunho e ganha card próprio na rail (`changeCard` em `server/index.html`) para desfazer ou aceitar.
- Tensiona o §19 de `docs/claude-code-review-mod-mvp.md` ("Evitar: editor completo"): o recorte fica em correções pontuais durante a leitura (typo, palavra, frase), não em virar um editor. Reescrita grande continua sendo comentário para o Claude.
- Encaixa no ciclo atual (§11–12): a edição da pessoa e as rodadas do Claude convivem no mesmo rascunho; Revisar grava tudo, Cancelar descarta tudo.

## Motivação

- **Problema:** para corrigir um typo ou trocar uma palavra a pessoa precisa escrever um comentário e gastar uma rodada do Claude, ou sair para o editor, onde o arquivo muda no disco e a revisão fica `stale` (Revisar bloqueado).
- **Outcome:** a pessoa corrige o texto sem sair da página nem gastar uma inferência; a correção aparece riscada/colorida como as demais e segue o mesmo desfazer, aceitar e Revisar.
- **Restrições / não-objetivos:**
  - Nunca escrever no disco antes do Revisar (o rascunho é a única via).
  - O HTML do próprio arquivo continua nunca rodando.
  - Não piscar nem perder o que está sendo digitado: `poll()`/`render()` não podem redesenhar o bloco em edição (estender `busy()`).
  - Não virar editor completo (§19).

## Decisões de domínio (DDD)

- **Agregado envolvido:** o **rascunho** (base + hunks, `hooks/draft.ts`). Uma edição da pessoa é uma escrita só nesse agregado, como o Excluir; não cria thread.
- **Invariante:** a edição parte do **texto de trabalho** do bloco (`working(base, hunks)` no recorte do segmento) e volta como hunks sobre a **base** (`diffHunks` + `workingToBase`), para que threads ancoradas na base continuem válidas.
- **Conflito com hunks existentes:** editar por cima de uma rodada do Claude ainda não aceita mexe em hunks que pertencem a uma thread. Rascunho: a edição da pessoa vira hunk(s) próprio(s) sem thread; o que cruzar um hunk de rodada precisa de regra (ver Decisões a fechar).
- **Escritas:** uma por edição confirmada, no rascunho; nada no diário (`.review/`) até o Revisar, como hoje.
- **Vocabulário:** *edição da pessoa* = alteração do rascunho feita na página, sem thread (o Excluir é um caso: texto novo vazio); *bloco* = um segmento Markdown (`Segment`).

## Decisões de arquitetura (CA)

- **Escape hatch:** o repo não segue CA em camadas; motor em `hooks/register.tsx` + `hooks/draft.ts`, página em script único em `server/index.html`. Seguir o estilo local.
- **Onde mora:**
  - Página: entrar/sair do modo de edição de um bloco, mostrar a fonte do texto de trabalho, mandar a ação.
  - Motor: nova ação (ex.: `{ kind: 'edit', segment, from, text }`, irmã de `delete`) que calcula os hunks com as funções puras de `draft.ts` e grava pelo mesmo caminho do `deletePassage`.
- **Regra no motor, não na página:** o diff e a tradução de offsets ficam em `draft.ts` (puro, testável como os demais `*.test.ts`); a página só manda o texto novo do bloco.
- **Sem port novo nem dependência nova.**

## Spec / MVP (entregue)

- Duplo clique num bloco, ou "Editar" na toolbar de seleção, ao lado de Questionar / Comentar / Excluir.
- O bloco renderizado é trocado por um campo com a fonte Markdown do texto de trabalho do segmento (`segments[i].work` na view); ⌘Enter ou sair do campo manda a ação `edit`; Esc descarta.
- A mudança aparece como as do Excluir: riscado + inserido, com card próprio na rail (desfazer / aceitar) ou rodada sob a do Claude, e entra no ⌘Z global.
- Revisar grava; Cancelar descarta, como hoje.
- Bloqueado com `view.stale`, como o Revisar; um bloco que mudou enquanto a pessoa editava (`was` diferente) é recusado com aviso.
- Só Markdown, fora do frontmatter.

## Decisões a fechar

- Edição que cruza o limite do segmento (juntar/partir parágrafos, criar um bloco novo): hoje o texto novo pode ter linhas em branco, mas a edição parte de um bloco só.
- Vale também para arquivos de código (`syntax: 'code'`)?
- Edições seguidas no mesmo bloco: hoje cada uma é um passo próprio (e, sobre uma rodada, uma rodada própria); fundir num card só?

## Decisões fechadas

- **Edição na fonte Markdown do bloco** (2026-10-17): o bloco renderizado vira um campo com o Markdown do texto de trabalho; confirmar volta a renderizar. WYSIWYG sobre o HTML fica fora.
- **Edição sobre uma rodada do Claude não aceita é permitida** (2026-10-17), pelo mesmo caminho do Excluir: sobre texto só do arquivo, vira uma alteração com card próprio; sobre texto de uma rodada, vira uma rodada da pessoa sob ela, no balão da thread, desfazível sozinha. Um card solto nesse caso exigiria hunks sobrepostos, que o rascunho funde.

## Fora (por enquanto)

- Editor completo do arquivo (§19).
- WYSIWYG: digitar sobre o HTML renderizado (`contenteditable`) e converter de volta para Markdown.
- Editar o frontmatter na página.
- Formatação por toolbar (negrito, listas, links).
- Colaboração simultânea com o Claude no mesmo bloco.

## Quando for

- `hooks/register.tsx`: ação `edit` ao lado de `delete`; `hooks/draft.ts`: diff do bloco → hunks na base.
- `server/index.html`: modo de edição do bloco em `render()`, `busy()`, toolbar de seleção, `changeCard`.
