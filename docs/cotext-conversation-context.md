# Cotext --- Contexto para continuar a conversa

## Objetivo original

A ideia começou como uma ferramenta para interagir com um coding agent
diretamente sobre texto --- especialmente Markdown, specs e código ---
sem precisar transformar cada observação em um novo prompt.

Fluxo desejado:

``` text
ler artefato
→ selecionar/grifar
→ comentar/anotar rapidamente
→ continuar revisando
→ enviar revisão acumulada ao coding agent
```

A intenção é que o **documento seja a interface de colaboração
humano↔agente**.

------------------------------------------------------------------------

## Cotext atual

Projeto:

https://github.com/tpetrone/cotext

O Cotext implementa a ideia de revisar Markdown em um pane: selecionar,
anotar e depois enviar a revisão inteira ao Claude.

Ele está sendo pensado como um **Claude Code Mod/plugin**, aproveitando
a nova infraestrutura de Mods do Claude Code.

Primitivas de annotation já estão funcionando razoavelmente, embora
ainda possam existir problemas.

Conceito:

``` text
Claude Code
    │
    ├── conversation
    │
    └── Cotext Review Surface
            │
            ├── select
            ├── highlight
            ├── comment
            ├── question
            ├── reject
            └── investigate
```

A ideia não é competir em features com ferramentas completas de review,
mas criar uma primitive nativa de interação com o artefato.

------------------------------------------------------------------------

# Evolução principal: Voice-native Cotext

A percepção mais importante da conversa foi que **annotation talvez não
seja o produto final**.

O ganho real seria transformar Cotext em uma ferramenta de
**revisão/edição por voz centrada no artefato**.

O usuário poderia ouvir um arquivo sendo lido e interromper
naturalmente.

Exemplo:

``` text
Cotext:
🔊 "O sistema utilizará SQLite como banco principal..."

Usuário:
"Espera. Não tenho certeza disso.
Investiga se DuckDB faria mais sentido."

Cotext:
⏸ pausa

→ cria annotation ancorada naquele trecho

Cotext:
"Anotado."

🔊 continua leitura
```

Ou:

``` text
Usuário:
"Troca isso para Postgres."

→ Claude gera alteração
→ Cotext atualiza o texto
→ opcionalmente lê a nova versão
→ continua
```

O modelo central passa a ser:

``` text
READ
 ↓
INTERRUPT
 ↓
UNDERSTAND INTENT
 ↓
ANNOTATE / EDIT / NAVIGATE
 ↓
CONTINUE
```

Não é simplesmente "Claude Code com voz".

É:

> conversar com o artefato enquanto ele está sendo revisado.

------------------------------------------------------------------------

# Voice Cursor / Playhead

Uma primitive importante é um **cursor textual associado à leitura
TTS**.

O sistema precisa saber exatamente o que estava sendo lido quando o
usuário disse:

-   "isso"
-   "essa frase"
-   "marca isso"
-   "repete"
-   "volta"
-   "o último parágrafo"
-   "reescreve essa parte"

Modelo:

``` text
Document
  └── Section
       └── Paragraph
            └── Sentence
                  ↑
              Voice Cursor
```

O TTS não deveria tratar o arquivo como um blob único.

A leitura deve acontecer em unidades endereçáveis.

Isso permite resolver referências de voz contra ranges reais do
documento.

------------------------------------------------------------------------

# Intent Router

Interrupções de voz devem cair em três classes principais:

``` text
                    Voice
                      │
                Intent Router
                      │
       ┌──────────────┼──────────────┐
       │              │              │
    NAVIGATE       ANNOTATE         ACT
       │              │              │
    repeat          comment       rewrite
    rewind          question      replace
    continue        reject        simplify
    skip            highlight     remove
```

## Navigate

Operações locais, sem LLM:

-   "volta"
-   "repete"
-   "continua"
-   "pula esse parágrafo"
-   "volta para a parte do banco"

## Annotate

Também devem ser rápidas e preferencialmente locais:

-   "marca isso"
-   "tenho dúvida aqui"
-   "isso está errado"
-   "investiga depois"
-   "comentário: isso parece overengineering"

## Act

Podem chamar o coding agent:

-   "troca isso por Postgres"
-   "simplifica esse parágrafo"
-   "reescreve isso"
-   "remove essa parte"

------------------------------------------------------------------------

# Princípio importante de UX

Evitar diálogos constantes de confirmação.

Ruim:

``` text
Usuário: simplifica isso

Cotext:
"Você gostaria que eu aplicasse essa alteração?"
```

Melhor: a própria linguagem indica intenção.

``` text
"marca isso"
→ annotation

"investiga isso"
→ annotation/investigate

"não gostei disso"
→ reject

"troca isso por X"
→ edição imediata

"reescreve mais simples"
→ edição imediata

"depois precisamos rever isso"
→ annotation
```

Depois o usuário pode dizer:

``` text
"aplica minhas observações até aqui"
```

para executar annotations acumuladas em batch.

------------------------------------------------------------------------

# A ideia de Git / Versionamento

Surgiu depois uma evolução arquitetural importante:

**Cotext pode usar a ideia do Git --- e possivelmente Git literalmente
--- como transaction/version engine.**

O objetivo é permitir edição agressiva por voz sem medo, porque tudo é
reversível.

Modelo:

``` text
BASE VERSION
     │
     ▼
WORKING VERSION
     │
     ├── patch #1
     ├── patch #2
     └── patch #3
```

Então comandos naturais passam a ter semântica clara:

-   "desfaz"
-   "volta essa parte"
-   "mantém essa"
-   "quais mudanças eu fiz?"
-   "lê só o que mudou"
-   "descarta minhas alterações"
-   "aplica tudo"

------------------------------------------------------------------------

# Git não deve ser a UI

A divisão proposta:

``` text
Git
├── baseline
├── versions
├── diff
├── patch
├── revert
└── history

Cotext
├── textual anchors
├── annotations
├── comments
├── questions
├── voice cursor
├── intent
└── semantic actions
```

Git seria o **transaction engine**.

Cotext seria a camada semântica.

Não usar cada intervenção como commit necessariamente.

------------------------------------------------------------------------

# Três entidades fundamentais

A arquitetura começou a convergir para três conceitos:

## Annotation

O humano expressou uma intenção, dúvida ou observação.

``` text
"investiga se DuckDB seria melhor"
```

## Patch

O agente propôs ou executou uma alteração.

``` diff
- SQLite
+ Postgres
```

## Version

Estado resultante do documento.

Fluxo:

``` text
Annotation
    │
    ▼
 Agent
    │
    ▼
 Patch
    │
 ┌──┴─────┐
accept   reject
  │
  ▼
Version
```

------------------------------------------------------------------------

# Edit Transaction / VoiceAction

A ideia mais recente foi não fazer cada intervenção virar um commit Git.

Em vez disso, criar uma primitive semântica acima do Git:

**Edit Transaction** (ou `VoiceAction`).

Exemplo:

``` text
VoiceAction #17
   │
   ├── utterance
   │    "simplifica esse parágrafo"
   │
   ├── anchor
   │    architecture.md:§4:p2
   │
   ├── intent
   │    rewrite
   │
   ├── patch
   │    abc123 → def456
   │
   └── status
        applied
```

Então:

``` text
Usuário:
"desfaz"
```

pode simplesmente executar:

``` text
revert VoiceAction #17
```

sem chamar LLM novamente.

Essa primitive parece importante porque transforma voz em uma interface
segura e transacional.

------------------------------------------------------------------------

# Arquitetura conceitual atual

``` text
                         COTEXT
                            │
                     Artifact Model
                            │
                       Voice Cursor
                            │
                  ┌─────────┴─────────┐
                  │                   │
                 TTS                 STT
                  │                   │
               read              interrupt
                                      │
                                Intent Router
                                      │
              ┌───────────────────────┼───────────────────────┐
              │                       │                       │
           NAVIGATE                ANNOTATE                  ACT
              │                       │                       │
            local                   local                  Agent
              │                       │                       │
              │                       │                     Patch
              │                       │                       │
              └───────────────────────┼───────────────────────┘
                                      │
                               Edit Transaction
                                      │
                           ┌──────────┴──────────┐
                           │                     │
                        accept                revert
                           │                     │
                           └──────────┬──────────┘
                                      │
                               Version Engine
                                      │
                                     Git
```

------------------------------------------------------------------------

# Experiência desejada

Exemplo completo:

``` text
🔊 Cotext:
"O sistema utilizará SQLite como banco principal..."

Usuário:
"Espera. Simplifica esse parágrafo."

→ pausa TTS
→ resolve Voice Cursor
→ intent = rewrite
→ coding agent gera patch
→ cria Edit Transaction
→ aplica patch

Cotext:
"Reescrevi. Quer ouvir?"

Usuário:
"Sim."

🔊 lê nova versão

Usuário:
"Melhor. mantém."

→ transaction accepted

🔊 continua leitura
```

Depois:

``` text
Usuário:
"O que eu alterei até agora?"
```

Cotext usa as transactions/diff para resumir.

Finalmente:

``` text
"fecha a revisão"
```

ou:

``` text
"aplica tudo"
```

------------------------------------------------------------------------

# Ferramentas/projetos semelhantes encontrados

Nenhum parece juntar exatamente toda a proposta.

## attend

Voz + contexto temporal do código.

A fala é associada ao contexto que estava sendo manipulado.

https://github.com/oxidecomputer/attend

## ReVoicer

Anotação de PDF por voz ancorada em trecho selecionado.

Útil como referência para:

``` text
voice → annotation → textual anchor
```

https://github.com/mott-lab/ReVoicer

## semantic-review

Git diff reorganizado semanticamente + comentários + feedback para
coding agent.

Referência importante para:

``` text
patch → review → agent
```

https://github.com/mikker/semantic-review

## VoiceCode

STT/TTS para coding agents.

Mais focado em conversar com o agente do que conversar com o artefato.

https://github.com/gitmarsh/voicecode

## Heard

Hands-free conversation com coding agents.

Também agent-centric, não artifact-centric.

https://github.com/heardlabs/heard

## Remarc

Feedback layer com seleção de texto/elementos e comentários, inclusive
voz.

Próximo da ideia de annotation contextual.

https://github.com/metedata/Remarc

## Plannotator

Review visual de Markdown/specs/diffs com annotations e integração com
agentes.

Importante como referência/concorrente do Cotext tradicional.

https://github.com/backnotprop/plannotator

------------------------------------------------------------------------

# Diferenciação proposta

Outras ferramentas tendem a cair em três categorias:

``` text
VoiceCode / Heard
→ converse com o coding agent por voz

Talon / Cursorless
→ edite código por voz

Plannotator / review tools
→ revise visualmente artefatos
```

Cotext poderia ocupar outra categoria:

> **Review an artifact by having a conversation with the artifact.**

Ou:

> **Voice-native artifact review for coding agents.**

O artefato --- não o chat --- permanece como objeto central.

------------------------------------------------------------------------

# Direção sugerida para implementação

Antes de adicionar simplesmente TTS/STT, consolidar a semântica de:

1.  `Voice Cursor`
2.  `Annotation`
3.  `Patch`
4.  `Edit Transaction`
5.  `Version`
6.  `accept / revert`

Depois conectar:

``` text
TTS
STT
Intent Router
```

Isso evita que Cotext vire apenas um wrapper de voz sobre Claude Code.

A camada de versionamento/transação define o significado de:

``` text
muda
desfaz
mantém
volta
compara
aplica
```

e torna edição por voz segura.

------------------------------------------------------------------------

# Questão para continuar no próximo chat

Projetar uma **spec técnica incremental para evoluir o Cotext atual para
esse modelo voice-native + transactional**, preservando as primitives
existentes e evitando reescrita desnecessária.

Idealmente investigar primeiro o repositório atual:

https://github.com/tpetrone/cotext

e então propor:

-   modelo de domínio;
-   mudanças arquiteturais;
-   Voice Cursor;
-   Edit Transaction;
-   integração Git;
-   TTS/STT;
-   Intent Router;
-   fases de implementação;
-   critérios de sucesso;
-   o que explicitamente não construir no MVP.
