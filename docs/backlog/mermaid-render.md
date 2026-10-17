# Renderizar diagramas Mermaid

> **Característica:** Enhancement

Blocos ` ```mermaid ` de arquivos Markdown aparecem hoje como código cru na página de revisão. A ideia é desenhar o diagrama acima do código-fonte, que continua anotável.

## Alinhamento ao produto

- Cabe em "Markdown primeiro" (§14 de `docs/claude-code-review-mod-mvp.md`): a página já renderiza Markdown com `marked` (GFM), e diagramas são parte comum de docs de design revisados no cotext.
- Só afeta a superfície de revisão (`server/index.html`); o motor (`hooks/register.tsx`), o rascunho e o diário não mudam.
- Arquivos de código (`syntax: 'code'`) ficam como estão: só Markdown renderiza diagramas.

## Motivação

- **Problema:** um diagrama Mermaid num doc revisado não é desenhado; a pessoa precisa ler a fonte para entender o diagrama que está revisando.
- **Outcome:** o diagrama aparece desenhado, a fonte segue embaixo para perguntar, comentar ou excluir trechos, e uma edição do Claude no diagrama se vê no desenho.
- **Restrições / não-objetivos:**
  - Anotar sobre o SVG não é possível: seleção dentro do SVG não mapeia para offsets do arquivo. A âncora segue sendo a fonte.
  - O HTML do próprio arquivo nunca roda (regra atual do `marked.use`): Mermaid com `securityLevel: 'strict'`.
  - Não piscar: `render()` refaz o DOM a cada versão nova do `poll()`.

## Decisões de domínio (DDD)

- **Agregados envolvidos:** nenhum novo. O diagrama é uma **projeção de leitura** do texto de trabalho de um segmento (`Segment.text`), sem estado próprio nem persistência.
- **Invariante:** o diagrama desenha o mesmo texto que a fonte mostra, isto é, a versão do rascunho (o que Revisar gravaria), sem os marcadores de span (U+E000/U+E001/U+E1xx) que `render()` injeta.
- **Escritas:** zero; nenhum save, nada no diário (`.review/`).
- **Vocabulário:** *bloco Mermaid* = um fence ` ```mermaid ` dentro de um segmento Markdown; *diagrama* = o SVG derivado dele.

## Decisões de arquitetura (CA)

- **Escape hatch:** o repo não segue CA em camadas; a página é um script único em `server/index.html`. Seguir o estilo local.
- **Onde mora:** só na página (camada de apresentação). Nenhum port novo; o motor continua mandando `segments` como hoje.
- **Dependência externa:** Mermaid carregado do mesmo CDN do `marked` (jsDelivr), como dependência opcional: sem `window.mermaid`, a página se comporta como hoje.
- **Cache:** mapa texto-do-diagrama → SVG na página, limpo quando o tema muda.

## Spec / MVP (rascunho)

- Diagrama sempre visível **acima** do bloco de código-fonte; a fonte continua selecionável e anotável.
- Diagrama com erro de sintaxe: só a fonte + um aviso curto com a mensagem do Mermaid.
- O SVG desenha a versão do rascunho do segmento (`seg.text`, sem marcadores).
- Tema `dark` / `default` conforme o modo da página (`prefers-color-scheme` e `data-theme`).
- SVGs em cache pelo texto do diagrama para redesenhos sem custo.

## Decisões a fechar

- Diagramas grandes: limitar altura com rolagem ou deixar no tamanho natural?
- Mermaid servido do CDN (como o `marked`) ou embutido, para revisar offline?

## Fora (por enquanto)

- Anotar sobre o SVG (clicar num nó e abrir uma thread).
- Alternar entre diagrama e código, ou diagrama recolhível.
- Outros renderizadores (PlantUML, Graphviz, KaTeX).

## Quando for

- `server/index.html`: `<script>` do Mermaid, `render()` (depois de `marked.parse` e `paintMarks`), CSS do bloco do diagrama e do aviso de erro.
