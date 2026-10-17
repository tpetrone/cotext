# Cascata de Aceitar / Desfazer nas rodadas de uma thread

> **Característica:** Fix

Numa thread com várias rodadas que alteraram o texto, Desfazer, Refazer e Aceitar passam a respeitar a ordem das rodadas: desfazer uma antiga desfaz as seguintes; aceitar uma recente aceita as anteriores pendentes.

## Alinhamento ao produto

- Corrige o ciclo de revisão (§11–12 de `docs/claude-code-review-mod-mvp.md`): cada resposta a um Comentário é uma rodada, com ✓ Aceitar e ↶ Desfazer / ↷ Refazer no card da thread.
- Toca o motor (`hooks/register.tsx`: `stepRound`, `acceptRound`) e o card da thread na página (`server/index.html`).

## Motivação

- **Problema:** cada rodada é tratada isolada, mas as rodadas de uma thread se empilham — a seguinte foi escrita sobre o texto que a anterior deixou.
  - Desfazer uma rodada antiga reescrita depois falha com "o texto mudou desde essa rodada"; se não foi reescrita, desfaz e deixa as seguintes aplicadas sobre um texto que não existe mais.
  - Aceitar uma rodada recente grava só os hunks dela, deixando de fora as anteriores das quais ela depende.
- **Outcome:** as rodadas aplicadas de uma thread são sempre uma sequência contínua a partir da primeira; o que está no arquivo é sempre um prefixo dessa sequência.
- **Restrições / não-objetivos:**
  - Tudo ou nada: se alguma rodada da cadeia não puder ser revertida, nada muda.
  - A cascata inteira é um passo do ↶ global (Desfazer da barra / ⌘Z).
  - Rodadas de threads diferentes seguem independentes.

## Decisões de domínio (DDD)

- **Agregado:** a **thread** com suas rodadas (mensagens com `round`, `edits`, `undone`, `onDisk`), junto do **rascunho** (`hunks` sobre a base). Rodada não é agregado próprio: sua validade depende das anteriores da mesma thread.
- **Invariantes:**
  1. Rodadas aplicadas formam um prefixo contínuo: se a rodada *n* está aplicada, todas as anteriores estão.
  2. Rodadas gravadas no arquivo (`onDisk`) formam um prefixo das aplicadas e não podem mais ser desfeitas pela rodada.
- **Operações (intenções):**
  - *Desfazer rodada n* → desfaz n e todas as posteriores, da mais nova à mais antiga, parando em rodada gravada.
  - *Refazer rodada n* → refaz todas as anteriores desfeitas e depois n, da mais antiga à mais nova.
  - *Aceitar rodada n* → grava n e todas as anteriores pendentes no arquivo.
- **Um save por agregado:** a cadeia inteira se calcula antes e entra como um único `change` (rascunho + marcas das rodadas) ou um único `commit`; sem estado intermediário onde só parte da cadeia mudou.
- **Intermediário entre agregados:** n/a — uma escrita só (rascunho + threads no mesmo passo); o diário (`.review/`) segue o estado como hoje.

## Decisões de arquitetura (CA)

- **Escape hatch:** o repo não segue CA em camadas; o motor é `hooks/register.tsx` com funções puras em `hooks/draft.ts`. Seguir o estilo local.
- **Onde mora a regra:** no motor, não na página. A página só mostra o alcance (quantas rodadas) e pede confirmação; a cadeia é decidida em `stepRound` / `acceptRound`.
- **Corte:** separar o cálculo de uma rodada (texto → novos hunks, ou falha) numa função pura e aplicar a cascata por cima dela, para testar a cadeia sem a página.
- **Contrato motor ↔ página:** as ações (`undoRound`, `redoRound`, `acceptRound`) não mudam de forma; a view pode passar a dizer, por rodada, se ela ainda pode ser desfeita (não gravada) e o alcance de cada botão.

## Spec / MVP (rascunho)

- Desfazer em cascata para frente; Refazer em cascata para trás; Aceitar em cascata para trás.
- Rodada já gravada no arquivo perde o botão ↶ Desfazer (vira histórico); o ↶ global continua até o próximo Revisar.
- Aceitar que afeta mais de uma rodada pede confirmação ("Gravar esta resposta e as 2 anteriores?"); Desfazer não pede, pois o ↶ global reverte.
- Tooltips dizem quantas rodadas cada botão afeta; passar o mouse destaca as mensagens afetadas.
- Falha em qualquer rodada da cadeia → nada muda, toast de hoje.
- Testes da cadeia em `hooks/loop.test.ts` / `hooks/draft.test.ts`.

## Decisões a fechar

- Threads restauradas do diário com rodadas fora do prefixo (estado salvo antes desta regra): normalizar ao abrir ou só aplicar a regra dali em diante?
- Excluir manual (hunk sem thread) sobre o texto de uma rodada: deve bloquear a cascata ou ser ignorado?

## Fora (por enquanto)

- Dependência entre rodadas de threads diferentes que tocam o mesmo trecho.
- Desfazer seletivo de uma rodada do meio mantendo as seguintes (rebase das rodadas).
