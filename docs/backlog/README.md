# Backlog — cotext

Melhorias percebidas no uso do cotext. Cada item tem um doc estruturado em `docs/backlog/<slug>.md`.

## Legenda

**Status:** ✅ entregue · 🟡 parcial · ⬜ aberto

**Característica:** Feature · Enhancement · Refactor · Fix · Docs · Pipeline

## Visão geral

| Item | Característica | Status | Backlog | Produto |
|------|----------------|--------|---------|---------|
| [Renderizar diagramas Mermaid](#renderizar-diagramas-mermaid) | Enhancement | ⬜ | [mermaid-render.md](mermaid-render.md) | [§14 Markdown primeiro](../claude-code-review-mod-mvp.md) |
| [Cascata de Aceitar / Desfazer nas rodadas](#cascata-de-aceitar--desfazer-nas-rodadas) | Fix | ⬜ | [cascata-rodadas-thread.md](cascata-rodadas-thread.md) | [§11–12 Ciclo e Resolution](../claude-code-review-mod-mvp.md) |
| [Editar o texto direto na página](#editar-o-texto-direto-na-página) | Enhancement | ✅ | [editar-markdown-inline.md](editar-markdown-inline.md) | [§19 O que não construir](../claude-code-review-mod-mvp.md) |
| [O mesmo revisor dentro de uma thread](#o-mesmo-revisor-dentro-de-uma-thread) | Enhancement | ✅ | [revisor-continuo-thread.md](revisor-continuo-thread.md) | [§11–12 Ciclo e Resolution](../claude-code-review-mod-mvp.md) |

## Superfície de revisão

### Renderizar diagramas Mermaid

**Status:** ⬜

Blocos ` ```mermaid ` aparecem como código cru. Desenhar o diagrama acima da fonte, que segue anotável; erro de sintaxe vira aviso.

→ Backlog: [mermaid-render.md](mermaid-render.md)

### Editar o texto direto na página

**Status:** ✅

Dois cliques num bloco (ou Editar na seleção) abrem seu Markdown no lugar; ⌘Enter ou clicar fora grava no rascunho, Esc descarta. Como o Excluir: sobre texto do arquivo, um card próprio; sobre uma rodada do Claude, uma rodada da pessoa sob ela. Desfazível, gravada só no Revisar.

→ Backlog: [editar-markdown-inline.md](editar-markdown-inline.md)

## Threads e rodadas

### Cascata de Aceitar / Desfazer nas rodadas

**Status:** ⬜

Rodadas de uma thread são tratadas isoladas. Desfazer uma antiga passa a desfazer as seguintes; Aceitar uma recente passa a gravar as anteriores pendentes; rodada gravada não se desfaz mais pela rodada.

→ Backlog: [cascata-rodadas-thread.md](cascata-rodadas-thread.md)

### O mesmo revisor dentro de uma thread

**Status:** ✅

A primeira mensagem de uma thread cria o revisor; as seguintes o retomam (`session.send`) com a mensagem nova, o trecho atual, as rodadas dele desfeitas e o rascunho só quando mudou. Revisor inalcançável ou que falhou: cria-se outro com a conversa transcrita.

→ Backlog: [revisor-continuo-thread.md](revisor-continuo-thread.md)

## Contagem rápida

| ✅ | 🟡 | ⬜ |
|----|----|----|
| 2 | 0 | 2 |

### Por característica

| Característica | Todos | Aberto |
|----------------|-------|--------|
| Feature | 0 | 0 |
| Enhancement | 3 | 1 |
| Refactor | 0 | 0 |
| Fix | 1 | 1 |
| Docs | 0 | 0 |
| Pipeline | 0 | 0 |

_Última revisão: 2026-10-17 — entregues Editar o texto direto na página e O mesmo revisor dentro de uma thread._

## Como usar

- `/backlog` registra um item novo (doc estruturado + entrada neste índice).
- `/backlog list` resume feito vs pendente; `/backlog audit` confere o índice contra o código.
