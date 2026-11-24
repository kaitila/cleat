// Types for src/web/questions.js, so the tests typecheck (see chat-format.d.ts).
declare module "*/web/questions.js" {
  interface Question { question: string; header: string; multiSelect: boolean; options: { label: string; description: string }[] }
  export const ASK_USER_QUESTION: string;
  export const MAX_ANSWER: number;
  export function questionsOf(toolName: string, input: unknown): Question[] | null;
  export function answerOf(picked: string[], own: string): string;
  export function questionDecidedLabel(decision: unknown): string;
}
