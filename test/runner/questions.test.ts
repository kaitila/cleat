// An agent's questions (AskUserQuestion, D0039): the approval is answered with the person's answers,
// which the runner checks against the questions and hands back to the call.
import { afterAll, describe, expect, test } from "bun:test";
import type { EventsResponse, SessionEvent } from "../../src/shared/protocol";
import type { ApprovalAsk } from "../../src/runner/agent";
import { claudeOptions, SKIPPED } from "../../src/runner/agent-claude";
import { ASK_ME, FAKE_QUESTIONS, fakeAnswered } from "../../src/runner/agent-fake";
import { approvalBody } from "../../src/runner/notifications";
import { ANSWERS_NEEDED, ANSWERS_REFUSED, answersRefusal, cleanAnswers, MAX_ANSWER, questionTexts } from "../../src/runner/questions";
import { connect, settled, testRunner, type Socket } from "./helpers";

const [colour, pages] = FAKE_QUESTIONS.questions.map((q) => q.question) as [string, string];

describe("questionTexts and answersRefusal", () => {
  test("only an AskUserQuestion input with distinct questions is read", () => {
    expect(questionTexts("AskUserQuestion", FAKE_QUESTIONS)).toEqual([colour, pages]);
    expect(questionTexts("Bash", FAKE_QUESTIONS)).toBeNull();
    expect(questionTexts("AskUserQuestion", { questions: [] })).toBeNull();
    expect(questionTexts("AskUserQuestion", { questions: [{ question: "" }] })).toBeNull();
    expect(questionTexts("AskUserQuestion", { questions: [{ question: "a?" }, { question: "a?" }] })).toBeNull();
    expect(questionTexts("AskUserQuestion", null)).toBeNull();
  });

  test("allowing questions needs an answer to each; answers come with nothing else", () => {
    const both = { [colour]: "Blue", [pages]: "Chat, Dock" };
    expect(answersRefusal("AskUserQuestion", FAKE_QUESTIONS, "allow", both)).toBeNull();
    expect(answersRefusal("AskUserQuestion", FAKE_QUESTIONS, "allow", undefined)).toBe(ANSWERS_NEEDED);
    expect(answersRefusal("AskUserQuestion", FAKE_QUESTIONS, "allow", { [colour]: "Blue" })).toBe(ANSWERS_NEEDED);
    expect(answersRefusal("AskUserQuestion", FAKE_QUESTIONS, "allow", { [colour]: "Blue", [pages]: "  " })).toBe(ANSWERS_NEEDED);
    expect(answersRefusal("AskUserQuestion", FAKE_QUESTIONS, "allow", { [colour]: "Blue", other: "x" })).toBe(ANSWERS_NEEDED);
    expect(answersRefusal("AskUserQuestion", FAKE_QUESTIONS, "allow", { [colour]: "Blue", [pages]: 3 })).toBe(ANSWERS_NEEDED);
    expect(answersRefusal("AskUserQuestion", FAKE_QUESTIONS, "allow", { ...both, [pages]: "x".repeat(MAX_ANSWER + 1) })).toContain(String(MAX_ANSWER));
    expect(answersRefusal("AskUserQuestion", FAKE_QUESTIONS, "allow", ["Blue"])).toBe("answers must be an object");
    // Skipped: no answers.
    expect(answersRefusal("AskUserQuestion", FAKE_QUESTIONS, "deny", undefined)).toBeNull();
    expect(answersRefusal("AskUserQuestion", FAKE_QUESTIONS, "deny", both)).toBe(ANSWERS_REFUSED);
    // Any other tool: Allow and Deny as before, never answers.
    expect(answersRefusal("Bash", { command: "ls" }, "allow", undefined)).toBeNull();
    expect(answersRefusal("Bash", { command: "ls" }, "allow", both)).toBe(ANSWERS_REFUSED);
    // Questions the runner can't read are answered like any call.
    expect(answersRefusal("AskUserQuestion", { questions: "?" }, "allow", undefined)).toBeNull();
  });

  test("answers are trimmed and kept in the questions' order", () => {
    expect(Object.entries(cleanAnswers([colour, pages], { [pages]: " Dock ", [colour]: "Blue\n" }))).toEqual([
      [colour, "Blue"],
      [pages, "Dock"],
    ]);
  });

  test("a peek for questions says the first one", () => {
    expect(approvalBody("AskUserQuestion", FAKE_QUESTIONS)).toBe(`AskUserQuestion: ${colour}`);
  });
});

describe("canUseTool for AskUserQuestion", () => {
  const base = { agent: "claude" as const, prompt: "hi", cwd: "/tmp/work", resume: null, permissionMode: "auto" as const, signal: new AbortController().signal };
  type CallOptions = Parameters<NonNullable<ReturnType<typeof claudeOptions>["canUseTool"]>>[2];
  const call = { signal: new AbortController().signal, toolUseID: "q1", requestId: "r1" } as CallOptions;

  test("allowed, the call gets the person's answers as updatedInput.answers", async () => {
    const answers = { [colour]: "Green", [pages]: "Dock" };
    const approve = async (ask: ApprovalAsk) => {
      ask.answered?.(answers);
      return "allow" as const;
    };
    const { canUseTool } = claudeOptions({ ...base, approve }, new AbortController(), () => {});
    expect(await canUseTool!("AskUserQuestion", FAKE_QUESTIONS, call)).toEqual({ behavior: "allow", updatedInput: { ...FAKE_QUESTIONS, answers } });
  });

  test("skipped, the model is told so", async () => {
    const { canUseTool } = claudeOptions({ ...base, approve: async () => "deny" as const }, new AbortController(), () => {});
    expect(await canUseTool!("AskUserQuestion", FAKE_QUESTIONS, call)).toEqual({ behavior: "deny", message: SKIPPED });
  });
});

describe("the fake agent's questions", () => {
  const runner = testRunner();
  afterAll(() => runner.stop());

  type Ask = Extract<SessionEvent, { kind: "approval_request" }>;
  const asked = async (socket: Socket, id: string): Promise<Ask> => {
    const first = () => socket.messages.flatMap((m) => (m.type === "event" && m.sessionId === id && m.event.kind === "approval_request" ? [m.event] : []))[0];
    await socket.waitFor(() => first() !== undefined);
    return first()!;
  };
  const eventsOf = async (id: string) => ((await (await runner.get(`/api/sessions/${id}/events`)).json()) as EventsResponse).events;
  const answer = (id: string, approvalId: string, body: unknown) => runner.post(`/api/sessions/${id}/approvals/${approvalId}`, body);

  test("answered: refused without every answer, then stored and handed to the call", async () => {
    const socket = await connect(runner);
    const session = await runner.startSession(`please ${ASK_ME}`);
    const ask = await asked(socket, session.id);
    expect(ask).toMatchObject({ toolName: "AskUserQuestion", input: FAKE_QUESTIONS });
    const missing = await answer(session.id, ask.approvalId, { decision: "allow" });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: ANSWERS_NEEDED });
    expect((await answer(session.id, ask.approvalId, { decision: "allow", answers: { [colour]: "Blue" } })).status).toBe(400);
    const answers = { [colour]: "Blue", [pages]: "Chat, Dock" };
    expect((await answer(session.id, ask.approvalId, { decision: "allow", answers })).status).toBe(200);
    await settled(socket, session.id);
    const all = await eventsOf(session.id);
    expect(all.find((e) => e.kind === "approval_resolved")).toMatchObject({ decision: "allow", answers });
    expect(all.find((e) => e.kind === "assistant_text")).toMatchObject({ text: fakeAnswered(answers) });
    socket.close();
  });

  test("skipped: Deny with no answers, and the call is told", async () => {
    const socket = await connect(runner);
    const session = await runner.startSession(`now ${ASK_ME} again`);
    const ask = await asked(socket, session.id);
    expect((await answer(session.id, ask.approvalId, { decision: "deny", answers: { [colour]: "Blue", [pages]: "Chat" } })).status).toBe(400);
    expect((await answer(session.id, ask.approvalId, { decision: "deny" })).status).toBe(200);
    await settled(socket, session.id);
    const all = await eventsOf(session.id);
    const resolved = all.find((e) => e.kind === "approval_resolved");
    expect(resolved).toMatchObject({ decision: "deny" });
    expect(resolved && "answers" in resolved).toBe(false);
    expect(all.find((e) => e.kind === "assistant_text")).toMatchObject({ text: fakeAnswered(undefined) });
    socket.close();
  });
});
