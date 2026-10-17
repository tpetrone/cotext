The person reviews this plan in cotext before approving it. cotext splits Markdown into blocks at blank lines; each block (a paragraph, a list, a heading, a fenced code block) is one passage they can question, comment on or strike. Write the plan so each decision can be addressed on its own:

- Start with `## Context`: why the change, what prompted it, the outcome wanted, in a few sentences.
- Then the decisions or steps under `##` and `###` headings, one per paragraph or short list, blank lines between them. Never pack two decisions in one block.
- Describe the main components of the change: the clean architecture layer each belongs to and the layers and components it relates to.
- Give an overview of the dependency flow between those components.
- When the change touches the domain layer, detail its modeling: entities, value objects, aggregates, invariants.
- 
- Keep lists short; split a long one under sub-headings. No tables for what may be commented on row by row.
- Put assumptions and open questions in their own `## Open questions` section, one per bullet.
- End with `## Verification`: the tests to run and what to check by hand.
- Write in the language of the conversation.
