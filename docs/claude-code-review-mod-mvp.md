# Claude Code Review Mod --- MVP

## 1. Visão

Construir um **Claude Code Mod** que transforme arquivos de texto ---
inicialmente Markdown e código --- em uma superfície de revisão
humano↔agente.

A ideia central é separar dois momentos:

1.  **Revisão rápida humana:** ler, selecionar trechos, grifar e deixar
    comentários curtos.
2.  **Execução agentic:** enviar a revisão acumulada de uma vez para o
    Claude Code investigar, alterar, explicar ou aprofundar os pontos
    marcados.

O objetivo não é criar outro editor nem outro coding agent. O produto é
uma **camada de interação estruturada entre o humano e o agente**.

------------------------------------------------------------------------

## 2. Problema

O fluxo típico de coding agents é:

``` text
selecionar trecho
      ↓
escrever prompt
      ↓
esperar modelo
      ↓
avaliar resposta
      ↓
repetir
```

Isso interrompe a leitura e força o usuário a transformar cada
observação em uma conversa imediatamente.

O Review Mod propõe:

``` text
ler documento
      ↓
marcar vários pontos
      ↓
adicionar feedback mínimo
      ↓
continuar lendo
      ↓
enviar revisão completa
      ↓
agente trabalha nos pontos em conjunto
```

A revisão humana passa a ser **assíncrona em relação à execução do
agente**.

------------------------------------------------------------------------

## 3. Princípio de UX

O documento é a interface.

``` text
┌──────────────────────────── Claude Code ────────────────────────────┐
│                                                                     │
│  Conversation                     Review Surface                    │
│                                                                     │
│  Claude > Criei o plano...         architecture.md                  │
│                                    ───────────────                  │
│                                    SQLite será usado...             │
│                                    ^^^^^^^^^^^^^^^^^^^              │
│                                    ? investigar alternativas        │
│                                                                     │
│                                    Graphiti fará memória...         │
│                                    ^^^^^^^^^^^^^^^^^^^^^^^          │
│                                    ✗ fora do MVP                    │
│                                                                     │
│                                    API será REST...                 │
│                                    ^^^^^^^^^^^^^^^^                 │
│                                    💬 por quê REST?                 │
│                                                                     │
│                                    [ 3 annotations ]                │
│                                    [ Send Review ]                  │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

O usuário deve conseguir fazer uma passada inteira pelo documento sem
iniciar uma nova inferência a cada comentário.

------------------------------------------------------------------------

## 4. Operações do MVP

Ao selecionar um trecho:

``` text
[ ? ] [ ✗ ] [ ✓ ] [ Investigate ] [ Comment ]
```

### `?` --- Question

Marca algo que precisa ser explicado.

Exemplo:

> Por que essa decisão foi tomada?

### `✗` --- Reject

Indica que o usuário discorda da decisão ou quer que ela seja
reconsiderada.

### `✓` --- Accept

Registra explicitamente uma decisão aceita. Pode ser útil para impedir
que uma revisão posterior reverta decisões já aprovadas.

### `Investigate`

Pede ao agente uma análise mais profunda antes de alterar o documento.

### `Comment`

Comentário livre.

Exemplo:

> Isso continua válido se houver múltiplos agentes?

------------------------------------------------------------------------

## 5. Highlight sem comentário

O usuário também pode simplesmente grifar um trecho.

``` text
select → highlight
```

Sem escrever nada.

No envio da revisão, isso significa aproximadamente:

> Revise especialmente este trecho e verifique se há problemas,
> inconsistências ou oportunidades de melhoria.

Isso reduz drasticamente o custo de interação.

------------------------------------------------------------------------

## 6. Modelo de dados

Cada anotação deve ser uma entidade estruturada.

``` ts
type AnnotationType =
  | "highlight"
  | "question"
  | "reject"
  | "accept"
  | "investigate"
  | "comment";

interface Annotation {
  id: string;

  file: string;

  type: AnnotationType;

  anchor: {
    selectedText: string;
    start?: number;
    end?: number;
    lineStart?: number;
    lineEnd?: number;
    contextBefore?: string;
    contextAfter?: string;
  };

  comment?: string;

  status: "open" | "resolved" | "dismissed";

  createdAt: string;
}
```

------------------------------------------------------------------------

## 7. Anchoring

Ranges absolutos são frágeis porque o agente pode editar o arquivo.

Por isso, uma anotação não deve depender apenas de:

``` text
characters 182–247
```

Ela deve guardar também:

``` text
selectedText
contextBefore
contextAfter
```

Exemplo:

``` json
{
  "selectedText": "SQLite será utilizado como storage principal",
  "contextBefore": "Para persistência local,",
  "contextAfter": "durante a primeira versão do produto."
}
```

Isso permite tentar reencontrar semanticamente o trecho após pequenas
modificações.

### Estratégia MVP

1.  tentar range original;
2.  procurar `selectedText`;
3.  usar contexto anterior/posterior;
4.  se houver ambiguidade, marcar annotation como `detached`.

Uma versão posterior pode usar matching fuzzy ou embeddings.

------------------------------------------------------------------------

## 8. Estado da revisão

Sugestão inicial:

``` text
.review/
├── architecture.md.review.json
├── tech_spec.md.review.json
└── src/
    └── agent.ts.review.json
```

Alternativamente:

``` text
.review/review.json
```

com todas as annotations centralizadas.

Para o MVP, um arquivo único simplifica bastante:

``` json
{
  "version": 1,
  "annotations": []
}
```

------------------------------------------------------------------------

## 9. Send Review

O botão principal é:

``` text
Send Review
```

Ele transforma as annotations abertas em contexto estruturado para o
Claude.

Exemplo conceitual:

``` text
Review architecture.md.

The user performed a document review.

ANNOTATION 1
Type: investigate
Text:
"SQLite será utilizado como storage principal"

Instruction:
"Investigue alternativas antes de manter essa decisão."

ANNOTATION 2
Type: reject
Text:
"Graphiti será obrigatório no MVP"

Instruction:
"Reconsidere esta decisão."

ANNOTATION 3
Type: question
Text:
"A API será REST"

Instruction:
"Explique por que REST foi escolhido."

Consider the annotations together rather than independently.

Do not modify accepted decisions unless required by another annotation.
```

------------------------------------------------------------------------

## 10. Dois modos de envio

O MVP deveria suportar dois comportamentos.

### Review

``` text
Send → Review
```

O Claude responde às annotations, mas não altera arquivos
automaticamente.

Bom para:

-   arquitetura;
-   specs;
-   decisões;
-   brainstorming;
-   investigação.

### Apply

``` text
Send → Apply
```

O Claude recebe autorização para modificar o documento/código conforme a
revisão.

Bom para:

-   refactoring;
-   correções;
-   atualização de specs;
-   implementação.

------------------------------------------------------------------------

## 11. Ciclo completo

``` text
Claude gera arquivo
       │
       ▼
Review Surface
       │
       ├── highlight
       ├── question
       ├── reject
       ├── investigate
       └── comment
       │
       ▼
Review Queue
       │
       ▼
Send Review
       │
       ▼
Structured Context
       │
       ▼
Claude Code Agent
       │
       ├── responde
       ├── investiga
       ├── edita
       └── executa ferramentas
       │
       ▼
Annotation Resolution
       │
       ▼
Nova versão do documento
```

------------------------------------------------------------------------

## 12. Resolution

Depois que o Claude processar a revisão, cada annotation pode assumir:

``` text
OPEN
  ↓
RESOLVED
```

ou:

``` text
OPEN
  ↓
NEEDS HUMAN
```

Exemplo:

``` text
✓ #12 — SQLite substituído por embedded Postgres
✓ #13 — justificativa REST adicionada
? #14 — decisão depende do volume esperado
```

O usuário pode então fazer outra passada apenas pelos itens pendentes.

------------------------------------------------------------------------

## 13. Arquitetura

``` text
                    Claude Code
                         │
               ┌─────────┴─────────┐
               │    Review Mod     │
               └─────────┬─────────┘
                         │
          ┌──────────────┼──────────────┐
          │              │              │
          ▼              ▼              ▼
    Review Surface   Annotation      Agent Bridge
                         Store
          │              │              │
          ▼              ▼              ▼
     Renderer        review.json     Claude Context
          │
     ┌────┴────┐
     │         │
 Markdown    Code
```

### Componentes

#### Review Surface

Responsável por:

-   renderizar arquivo;
-   seleção;
-   highlights;
-   comentários;
-   toolbar contextual;
-   navegação entre annotations.

#### Annotation Store

Responsável por:

-   persistência;
-   estado;
-   anchoring;
-   resolution.

#### Agent Bridge

Responsável por:

-   converter annotations em contexto;
-   iniciar Review/Apply;
-   receber resultado;
-   atualizar estado das annotations.

------------------------------------------------------------------------

## 14. Markdown primeiro

O primeiro renderer deve ser Markdown.

Motivo: é onde coding agents frequentemente produzem artefatos que
exigem revisão humana:

``` text
README.md
PLAN.md
SPEC.md
architecture.md
tech_spec.md
tasks.md
agent.md
```

Além disso, Markdown reduz a complexidade inicial de syntax highlighting
e edição de ASTs de linguagens.

------------------------------------------------------------------------

## 15. Código depois

A abstração deve permitir posteriormente:

``` text
Review Surface
      │
      ├── MarkdownRenderer
      └── CodeRenderer
              │
              ├── TypeScript
              ├── Python
              ├── Rust
              └── ...
```

Para código, annotations deveriam poder apontar também para símbolos:

``` ts
{
  symbol: "BookmarkSyncService.sync",
  selectedText: "...",
  lineStart: 83,
  lineEnd: 102
}
```

Isso torna o anchor mais robusto.

------------------------------------------------------------------------

## 16. Quick Review

Uma das funcionalidades mais importantes é permitir revisão quase sem
teclado.

Exemplo:

``` text
selecionar trecho
      ↓
pressionar ?
```

ou:

``` text
selecionar trecho
      ↓
pressionar X
```

Atalhos sugeridos:

``` text
?    question
X    reject
A    accept
I    investigate
C    comment
H    highlight
```

O objetivo é maximizar a velocidade da leitura humana.

------------------------------------------------------------------------

## 17. Review Queue

Uma visão compacta mostra todas as observações:

``` text
REVIEW — architecture.md

[?] L23  Por que SQLite?
[X] L48  Graphiti obrigatório no MVP
[I] L71  Estratégia de sync
[H] L92  Retry mechanism
[C] L104 Isso parece duplicado

5 open annotations

[ Send Review ]
```

Clicar numa annotation leva ao trecho correspondente.

------------------------------------------------------------------------

## 18. Multi-file Review

Não é obrigatório para o primeiro protótipo, mas a arquitetura deve
suportar:

``` text
Review Session
│
├── architecture.md
│     ├── annotation
│     └── annotation
│
├── src/storage.ts
│     └── annotation
│
└── tasks.md
      ├── annotation
      └── annotation
```

Então:

``` text
Send Project Review
```

O agente recebe a revisão como uma unidade lógica.

Isso é particularmente útil quando uma mudança arquitetural implica
mudanças simultâneas em spec, código e tasks.

------------------------------------------------------------------------

## 19. O que NÃO construir no MVP

Evitar:

-   editor completo;
-   colaboração multiplayer;
-   embeddings;
-   banco vetorial;
-   Graphiti;
-   CRDT;
-   comentários em tempo real;
-   integração GitHub;
-   review de PR;
-   semantic diff sofisticado;
-   suporte a dezenas de linguagens;
-   agentes próprios.

O Claude Code continua sendo o agente.

O Mod deve ser apenas:

> **a superfície de revisão humano↔agente.**

------------------------------------------------------------------------

## 20. MVP mínimo

### Fase 1 --- Spike

Provar que um Mod consegue:

-   abrir painel;
-   exibir Markdown;
-   detectar seleção;
-   criar annotation;
-   manter estado local;
-   transformar annotations em contexto para o Claude.

Critério de sucesso:

``` text
selecionar → comentar → Send Review → Claude recebe comentário
```

### Fase 2 --- Review funcional

Adicionar:

-   highlight;
-   question;
-   reject;
-   investigate;
-   comment;
-   Review Queue;
-   persistência;
-   navegação entre annotations.

### Fase 3 --- Agent loop

Adicionar:

-   Review mode;
-   Apply mode;
-   resolução automática;
-   annotations pendentes;
-   re-anchoring após alterações.

### Fase 4 --- Code Review

Adicionar:

-   renderer de código;
-   syntax highlighting;
-   anchors por linha/símbolo;
-   multi-file review.

------------------------------------------------------------------------

## 21. Critério de sucesso do produto

O experimento deve responder:

> É mais rápido revisar o trabalho de um coding agent marcando
> diretamente o artefato do que transformar cada observação em uma
> conversa?

Se a resposta for sim, o Review Mod cria uma nova interação:

``` text
Prompting
   ↓
Reviewing
   ↓
Delegating
```

em vez de:

``` text
Prompt
 ↓
Response
 ↓
Prompt
 ↓
Response
 ↓
Prompt
```

------------------------------------------------------------------------

## 22. Visão futura

O Review Mod pode evoluir para uma camada genérica:

``` text
Human Review Protocol
          │
          ├── Claude Code
          ├── Codex
          ├── Pi
          ├── OpenCode
          └── outros agents
```

Nesse cenário, annotations tornam-se um protocolo independente:

``` text
Artifact
   +
Human Annotations
   +
Intent
   ↓
Agent
```

O Mod do Claude Code seria apenas a primeira implementação.

------------------------------------------------------------------------

## 23. Nome provisório

``` text
Review Mod
```

Alternativas:

-   Annotate
-   Margin
-   Redline
-   Proof
-   Review Layer
-   Agent Review
-   Marginalia

`Margin` captura particularmente bem a ideia: o humano deixa observações
na margem enquanto o agente executa o trabalho pesado depois.
