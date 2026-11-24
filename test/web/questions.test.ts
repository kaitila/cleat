// The page side of an agent's questions (src/web/questions.js, D0039): what the card draws, and the answer it sends.
import { describe, expect, test } from "bun:test";
import { answerOf, MAX_ANSWER, questionDecidedLabel, questionsOf } from "../../src/web/questions.js";
import { toolSummary } from "../../src/web/chat-format.js";
import { FAKE_QUESTIONS } from "../../src/runner/agent-fake";
import { MAX_ANSWER as RUNNER_MAX_ANSWER } from "../../src/runner/questions";

describe("questionsOf", () => {
  test("reads the SDK's input: each question, its header, its options and whether several can be picked", () => {
    const qs = questionsOf("AskUserQuestion", FAKE_QUESTIONS)!;
    expect(qs.map((q) => [q.question, q.header, q.multiSelect, q.options.map((o) => o.label)])).toEqual([
      ["Which colour should the button be?", "Colour", false, ["Blue", "Green"]],
      ["Which pages should get it?", "Pages", true, ["Chat", "Dock", "Settings"]],
    ]);
    expect(qs[0]!.options[0]!.description).toBe("The accent, as the rest of the app");
  });

  test("anything else is drawn as a plain approval", () => {
    expect(questionsOf("Bash", FAKE_QUESTIONS)).toBeNull();
    expect(questionsOf("AskUserQuestion", { questions: [] })).toBeNull();
    expect(questionsOf("AskUserQuestion", { questions: [{ question: "a?" }, { question: "a?" }] })).toBeNull();
    expect(questionsOf("AskUserQuestion", "?")).toBeNull();
    // A question without options is answered in words only.
    expect(questionsOf("AskUserQuestion", { questions: [{ question: "Why?", options: [{ label: "" }, 3] }] })).toEqual([{ question: "Why?", header: "", multiSelect: false, options: [] }]);
  });
});

describe("answerOf and the decided label", () => {
  test("labels then own words, joined as Claude Code joins a multiSelect answer", () => {
    expect(answerOf(["Blue"], "")).toBe("Blue");
    expect(answerOf(["Chat", "Dock"], "  the menu too ")).toBe("Chat, Dock, the menu too");
    expect(answerOf([], "  ")).toBe("");
    expect(answerOf([], "red")).toBe("red");
  });

  test("Answered, Skipped, Not answered", () => {
    expect([questionDecidedLabel("allow"), questionDecidedLabel("deny"), questionDecidedLabel(undefined), questionDecidedLabel("toString")]).toEqual(["Answered", "Skipped", "Not answered", "Not answered"]);
  });

  test("the page's longest answer is the runner's", () => {
    expect(MAX_ANSWER).toBe(RUNNER_MAX_ANSWER);
  });

  test("a tool row for questions shows the first question", () => {
    expect(toolSummary("AskUserQuestion", FAKE_QUESTIONS)).toBe("Which colour should the button be?");
  });
});
