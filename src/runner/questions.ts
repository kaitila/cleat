// An AskUserQuestion call's questions, and the check of the person's answers to them (D0039).
// The SDK's input: { questions: [{ question, header, options: [{ label, description }], multiSelect }] }
// (node_modules/@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts, AskUserQuestionInput). The answers go
// back to Claude Code as the allowed call's updatedInput.answers: each question's text and its answer.
import { ASK_USER_QUESTION, type ApprovalDecision, type QuestionAnswers } from "../shared/protocol";

/** One answer is at most this long: an option's label, several, or the person's own words. */
export const MAX_ANSWER = 4000;

export const ANSWERS_NEEDED = "answer every question to allow it";
export const ANSWERS_REFUSED = "answers are only for allowing an AskUserQuestion call";

/** The questions' texts of an AskUserQuestion input, or null when it is not one the runner can read. */
export function questionTexts(toolName: string, input: unknown): string[] | null {
  if (toolName !== ASK_USER_QUESTION || typeof input !== "object" || input === null) return null;
  const questions = (input as { questions?: unknown }).questions;
  if (!Array.isArray(questions) || questions.length === 0) return null;
  const texts = questions.map((q) => (typeof q === "object" && q !== null && typeof (q as { question?: unknown }).question === "string" ? (q as { question: string }).question : null));
  return texts.every((t): t is string => t !== null && t.length > 0) && new Set(texts).size === texts.length ? texts : null;
}

/**
 * Why `answers` can't answer this approval, or null. An AskUserQuestion call the runner can read is
 * allowed only with an answer to each of its questions; answers come with nothing else.
 */
export function answersRefusal(toolName: string, input: unknown, decision: ApprovalDecision, answers: unknown): string | null {
  const texts = questionTexts(toolName, input);
  if (answers === undefined) return texts && decision === "allow" ? ANSWERS_NEEDED : null;
  if (!texts || decision !== "allow") return ANSWERS_REFUSED;
  if (typeof answers !== "object" || answers === null || Array.isArray(answers)) return "answers must be an object";
  const given = Object.entries(answers);
  if (given.length !== texts.length || !texts.every((t) => Object.hasOwn(answers, t))) return ANSWERS_NEEDED;
  for (const [, value] of given) {
    if (typeof value !== "string" || !value.trim()) return ANSWERS_NEEDED;
    if (value.length > MAX_ANSWER) return `an answer is at most ${MAX_ANSWER} characters`;
  }
  return null;
}

/** The answers as stored and sent on: each one trimmed, in the questions' order. */
export function cleanAnswers(texts: readonly string[], answers: QuestionAnswers): QuestionAnswers {
  return Object.fromEntries(texts.map((t) => [t, answers[t]!.trim()]));
}
