// The fake agent, used when INTUITION_FAKE_AGENT=1 (tests and CI, which have no Claude Code login).
// It never starts Claude Code and never touches the workspace. One turn is scripted from the prompt:
//
//   1. It reports a made-up Claude Code session id, `fake-<uuid>` (or the id it was asked to resume).
//   2. A prompt containing "use tool" gets a `tool_use` (Bash, `echo fake`) and its `tool_result` ("fake").
//   3. It answers `You said: <prompt>`, streamed as three deltas, then stored as one `assistant_text`.
//   4. A prompt containing "fail" then ends in an `error` event ("the fake agent failed");
//      any other prompt ends in a `result` with ok true.
//
// Between steps it waits `stepMs` (5 ms by default), so a test can see the session running.
import type { AgentDriver, AgentOutput, TurnInput } from "./agent";

export const FAKE_ERROR = "the fake agent failed";

export function fakeReply(prompt: string): string {
  return `You said: ${prompt}`;
}

export function fakeDriver(stepMs = 5): AgentDriver {
  return {
    async *run(input: TurnInput): AsyncIterable<AgentOutput> {
      const started = Date.now();
      const steps: AgentOutput[] = [{ type: "session_id", id: input.resume ?? `fake-${crypto.randomUUID()}` }];
      if (input.prompt.includes("use tool")) {
        const toolUseId = `fake-tool-${crypto.randomUUID()}`;
        steps.push(
          { type: "event", event: { kind: "tool_use", toolUseId, name: "Bash", input: { command: "echo fake" } } },
          { type: "event", event: { kind: "tool_result", toolUseId, content: "fake", isError: false } },
        );
      }
      const text = fakeReply(input.prompt);
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
