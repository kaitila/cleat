# D0004: How a tool call waits for the person

Date: 2026-11-13. Status: active.

## Decision
- The driver asks through one function on its turn's input, `approve(ask, signal)` (`src/runner/agent.ts`). The real driver's `canUseTool` and the fake both call it and wait. `Sessions` (`src/runner/sessions.ts`) owns the open approvals: it stores the `approval_request`, and the promise resolves from `POST /api/sessions/:id/approvals/:approvalId` only.
- Nothing but that POST ever answers "allow". Every other way an approval ends is a deny:
  - the SDK's abort signal for the call: stored as `approval_resolved` with `deny`;
  - the turn ends (a result, an error, a driver that throws) with the approval still open: stored as denied just before the turn's last event, so no card is left with buttons that do nothing;
  - the runner stops: the waiting call is denied in memory and nothing is stored, as for the rest of a stopped turn. The next start stores `approval_resolved` with `deny` for each approval left open, before `the runner restarted`.
- An allow returns the call's input unchanged (`updatedInput` is the input the SDK gave), and `updatedPermissions` is never returned: there is no "always allow". The SDK's `suggestions` are not read.
- An approval is answered under its own session: the right `approvalId` with another session's id is a 404, as is an approval that is already answered.
- The chat view's card shows a Bash command whole, however long (it scrolls): the person decides on all of it. A file tool shows its path and a cut preview of the text to be written; other tools their input as JSON, cut. Both have "show all". The card changes only when `approval_resolved` arrives, so two windows on the same session agree.
- This replaces D0002's line that `canUseTool` denies every call until approvals exist.

## Why
- One function keeps the rule checkable in one place: the driver can't allow a call, it can only ask, and the only caller that resolves "allow" is the route.
- A deny is the safe answer when nobody can be asked any more, and storing it keeps the stored events the whole truth: after a reload, every request has its answer.

## Not done here
- "Always allow" and editing a call's input before allowing it.
- A toast when an approval opens: notifications are T-0012.
- `AskUserQuestion` reaches `canUseTool` like any tool and gets the same card; answering its questions in the chat view is not built.
