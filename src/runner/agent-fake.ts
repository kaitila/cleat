// The fake agent, used when INTUITION_FAKE_AGENT=1 (tests and CI, which have no Claude Code login).
// It never starts Claude Code and never touches the workspace. One turn is scripted from the prompt:
//
//   1. It reports a made-up Claude Code session id, `fake-<uuid>` (or the id it was asked to resume),
//      then the permission mode in effect: the one it was asked for, or "default" when the prompt
//      contains "no auto mode" (as Claude Code does where auto mode is unavailable).
//   1b. A prompt containing "auto deny" gets a `tool_use` (Bash, `rm -rf fake`) and an `auto_denied`
//      for it, as the auto-mode classifier denies a call without asking, then its denied `tool_result`.
//   2. A prompt containing "use tool" gets a `tool_use` (Bash, `echo fake`) and its `tool_result` ("fake").
//   3. A prompt containing "needs approval" gets a `tool_use` (Write, fake.txt in the workspace) that
//      asks for approval and waits for the answer, as a real call that would prompt does. Allowed,
//      its `tool_result` is "fake: written" (nothing is written); denied, it is the real driver's
//      denial message, as an error.
//   4. It answers `You said: <prompt>`, streamed as three deltas, then stored as one `assistant_text`.
//      It remembers each conversation's prompts by that session id, so a prompt containing
//      "what did I say first" is answered with `You said first: <the conversation's first prompt>`:
//      a reply that resumes the conversation gets the first turn's prompt, a new conversation gets
//      its own. The memory is the process's, as Claude Code's transcripts outlive the runner.
//      After step 3 the answer is instead `The tool call was allowed.` or `The tool call was denied.`
//   5. A prompt containing "fail" then ends in an `error` event ("the fake agent failed");
//      any other prompt ends in a `result` with ok true.
//
// Between steps it waits `stepMs` (5 ms by default), so a test can see the session running.
import type { ApprovalDecision } from "../shared/protocol";
import type { AgentDriver, AgentOutput, TurnInput } from "./agent";
import { DENIED } from "./agent-claude";

export const FAKE_ERROR = "the fake agent failed";

export function fakeReply(prompt: string): string {
  return `You said: ${prompt}`;
}

export const ASK_FIRST = "what did I say first";

export function fakeFirst(firstPrompt: string): string {
  return `You said first: ${firstPrompt}`;
}

export const NEEDS_APPROVAL = "needs approval";
export const NO_AUTO_MODE = "no auto mode";
export const AUTO_DENY = "auto deny";
export const FAKE_CLASSIFIER = "the fake classifier blocks deletions";
export const FAKE_REASON = "the fake agent asks before it writes";

export function fakeDecided(decision: ApprovalDecision): string {
  return `The tool call was ${decision === "allow" ? "allowed" : "denied"}.`;
}

/** Each fake conversation's prompts, by its fake Claude Code session id. */
const conversations = new Map<string, string[]>();

export function fakeDriver(stepMs = 5): AgentDriver {
  return {
    async *run(input: TurnInput): AsyncIterable<AgentOutput> {
      const started = Date.now();
      const id = input.resume ?? `fake-${crypto.randomUUID()}`;
      const prompts = conversations.get(id) ?? [];
      conversations.set(id, prompts);
      prompts.push(input.prompt);
      const mode = input.prompt.includes(NO_AUTO_MODE) ? "default" : input.permissionMode;
      const steps: AgentOutput[] = [{ type: "session_id", id }, { type: "permission_mode", mode }];
      if (input.prompt.includes(AUTO_DENY)) {
        const toolUseId = `fake-tool-${crypto.randomUUID()}`;
        steps.push(
          { type: "event", event: { kind: "tool_use", toolUseId, name: "Bash", input: { command: "rm -rf fake" } } },
          { type: "event", event: { kind: "auto_denied", toolUseId, toolName: "Bash", input: "rm -rf fake", reason: FAKE_CLASSIFIER } },
          { type: "event", event: { kind: "tool_result", toolUseId, content: FAKE_CLASSIFIER, isError: true } },
        );
      }
      if (input.prompt.includes("use tool")) {
        const toolUseId = `fake-tool-${crypto.randomUUID()}`;
        steps.push(
          { type: "event", event: { kind: "tool_use", toolUseId, name: "Bash", input: { command: "echo fake" } } },
          { type: "event", event: { kind: "tool_result", toolUseId, content: "fake", isError: false } },
        );
      }
      let text = input.prompt.toLowerCase().includes(ASK_FIRST.toLowerCase()) ? fakeFirst(prompts[0]!) : fakeReply(input.prompt);
      if (input.prompt.includes(NEEDS_APPROVAL)) {
        const toolUseId = `fake-tool-${crypto.randomUUID()}`;
        const toolInput = { file_path: `${input.cwd}/fake.txt`, content: "fake" };
        steps.push({ type: "event", event: { kind: "tool_use", toolUseId, name: "Write", input: toolInput } });
        for (const step of steps.splice(0)) {
          await Bun.sleep(stepMs);
          if (input.signal.aborted) return;
          yield step;
        }
        const decision = await input.approve({ toolUseId, toolName: "Write", input: toolInput, reason: FAKE_REASON });
        if (input.signal.aborted) return;
        const allowed = decision === "allow";
        steps.push({ type: "event", event: { kind: "tool_result", toolUseId, content: allowed ? "fake: written" : DENIED, isError: !allowed } });
        text = fakeDecided(decision);
      }
      const size = Math.ceil(text.length / 3);
      for (let i = 0; i < text.length; i += size) steps.push({ type: "delta", text: text.slice(i, i + size) });
      steps.push({ type: "event", event: { kind: "assistant_text", text } });
      for (const step of steps) {
        await Bun.sleep(stepMs);
        if (input.signal.aborted) return;
        yield step;
      }
      if (input.prompt.includes("fail")) {
        yield { type: "event", event: { kind: "error", message: FAKE_ERROR } };
      } else {
        yield { type: "event", event: { kind: "result", ok: true, text, costUsd: 0, durationMs: Date.now() - started } };
      }
    },
  };
}
