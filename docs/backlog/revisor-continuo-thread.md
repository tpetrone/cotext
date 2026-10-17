# O mesmo revisor dentro de uma thread

> **Característica:** Enhancement

Hoje cada mensagem de uma thread cria um revisor novo, que recebe a conversa transcrita. A ideia é retomar o mesmo subagente nas mensagens seguintes, para ele guardar o que leu e raciocinou.

## Alinhamento ao produto

- Fica no ciclo de threads e rodadas (§11–12 de `docs/claude-code-review-mod-mvp.md`): só muda quem responde a mensagem seguinte de uma thread, não a superfície.
- Usa `$.session.send({ to: { agentId } })`: um subagente encerrado é retomado a partir da própria transcrição, com o mesmo id.

## Motivação

- **Problema:** um revisor novo a cada mensagem perde os arquivos que leu e o raciocínio das respostas anteriores, repete a investigação e pode mudar de rumo entre rodadas.
- **Outcome:** a thread conversa com um interlocutor só; as mensagens seguintes ficam mais baratas e mais coerentes.
- **Restrições / não-objetivos:**
  - O rascunho muda entre rodadas: o revisor retomado recebe o trecho atual, as rodadas dele desfeitas e o rascunho inteiro quando ele mudou.
  - Se o revisor não puder ser retomado, volta-se a criar um novo com a conversa transcrita, como hoje.

## Decisões de domínio (DDD)

- **Agregado envolvido:** a thread. Ela passa a guardar o id do seu revisor (`reviser`) e um resumo do rascunho que ele viu por último (`seen`); nenhum outro agregado muda.
- **Invariante:** a resposta de um revisor retomado entra na thread pelo mesmo caminho (`takeProposal`), com o mesmo id de agente.

## Decisões de arquitetura (CA)

- **Escape hatch:** seguir o estilo local (`hooks/register.tsx`, `hooks/reviser.ts`).
- O texto do follow-up é montado em `hooks/reviser.ts` (puro, testável); a escolha entre retomar e criar fica em `runReviser`.

## Spec / MVP (entregue)

- Primeira mensagem: `agent.spawn` com a tarefa completa; o id fica na thread (do `spawn`, ou do `turn.complete` da resposta).
- Mensagens seguintes: `session.send` ao mesmo id com a mensagem nova, o modo, o trecho atual, as rodadas desfeitas e o rascunho se mudou.
- Entrega recusada ou erro: `agent.spawn` com a tarefa completa. Um revisor que falhou ou parou antes de responder é esquecido.
- Um reload do mod reconstrói quais agentes são revisores a partir das threads.
- O id não vai para o diário em `.review/` (outra sessão não o retoma), e Cancelar o esquece.

## Fora (por enquanto)

- Encerrar o agente ao Arquivar ou apagar a thread (a API não expõe isso); a thread só esquece o id.
