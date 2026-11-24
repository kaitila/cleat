# D0039: An agent's questions (AskUserQuestion) are answered in the card: options to pick, own words, Answer and Skip

Date: 2026-11-24. Status: active. No foreman task (asked for in a session by the owner). Builds what [D0004](D0004-approvals.md) left out ("answering its questions in the chat view is not built"). Changes the contract: `ApprovalRequest.answers` and `approval_resolved.answers` (`src/shared/protocol.ts`, [protocol](../protocol.md)).

## Context
The owner, on 2026-11-24: "the askuserquestion doesnt work in the UI??". A Claude Code session that called `AskUserQuestion` got the generic approval card: its input as JSON, Allow and Deny. Allow ran the call with its input unchanged, so Claude Code's tool had no answers to return; there was no way to pick an option.

## Decision
- **The SDK's way to answer.** Claude Code's own prompt hands the answers to the tool through `canUseTool`: allowed, with `updatedInput` = the input plus `answers`, each question's text and its answer (`sdk-tools.d.ts`, `AskUserQuestionInput.answers`; several picked labels joined by ", "). The runner does the same (`agent-claude.ts`): the person's answers arrive with the approval, `ApprovalAsk.answered` hands them to the call, and the call is allowed with them.
- **The runner checks them** (`src/runner/questions.ts`). An `AskUserQuestion` whose input it can read (questions with distinct, non-empty texts) is allowed only with an answer to every question: each a non-empty string of at most 4000 characters, keyed by exactly those texts; otherwise 400. Answers with any other tool, or with Deny, are 400 too. The answers are stored, trimmed, on `approval_resolved`, so a reload shows them.
- **Skip is Deny.** The call is denied and the model is told the person skipped the questions and to ask in its reply or go on without them (`SKIPPED`).
- **The card** (`src/web/questions.js`, shared by the chat view and the dock): "Question", "Needs your answer"; each question with its header, its options as radio buttons (checkboxes when several may be picked), label over description, then a line for the person's own words (with one option to pick, typing there clears the pick and picking clears the words). Answer is off until every question has an answer; Enter in a line of words answers. Decided, the form gives way to each question over its answer, "Answered", "Skipped" or "Not answered".
- **Summaries.** A tool row, a peek and a notification for the call show its first question, not its JSON. The reply box's hint while a card is open says "Waiting for your answer above." for every card.

## Why
- **The SDK's own route** keeps the runner's rule: only the person's POST allows a call, and the answers are what they picked or wrote.
- **Checked in the runner**, not only in the page: a call allowed without answers ran with nothing to return, which was the bug.

## Not done here
- An option's `preview` (a mockup or snippet shown while it is focused) is not drawn.
- The `annotations` (notes on a preview, and how a question went unanswered) are not sent.
- Codex has no such tool: its driver asks nothing (docs/agents.md).

## Risk
- Claude Code's question tool and its `answers` field come from the SDK's types, which change often; a change there shows as a card that answers nothing again. The fake agent's questions (`ask me`) and `test/runner/questions.test.ts` follow the SDK's shape.
