# Tool Abort Debug Logging

This document maps the tool abort diagnostics in `packages/opencode/src/session/processor.ts` to the failure modes they identify.

## Error Codes

- `ETOOL001` means a V2 event-system publish failed while handling tool input, tool call, or tool output settlement.
- `ETOOL002` means the legacy/session tool part state failed to update, or the processor halted while a tool call was still active and cleanup marked it aborted.

The user-visible abort strings are defined in `packages/opencode/src/session/processor.ts:36` and `packages/opencode/src/session/processor.ts:37`:

- `ETOOL001: Tool execution aborted` is published to the V2 `Tool.Failed` cleanup event.
- `ETOOL002: Tool execution aborted` is persisted on the legacy/session tool part.

`packages/opencode/src/cli/cmd/run/subagent-data.ts:301` treats both historical and prefixed abort messages as cancelled subagent tasks by checking for messages ending in `Tool execution aborted`.

## Large Tool Input

These logs indicate failures while publishing or persisting tool input data. They are the most relevant entries when raw tool arguments or parsed input are large.

- `tool input delta event publish failed`
  - Code: `ETOOL001`
  - Source: `packages/opencode/src/session/processor.ts:457`
  - Fields: `deltaLength`, `rawLength`, `session.id`, `messageID`, `callID`, `tool`, `error`
  - Meaning: publishing a `SessionEvent.Tool.Input.Delta` event failed.

- `tool input ended event publish failed`
  - Code: `ETOOL001`
  - Source: `packages/opencode/src/session/processor.ts:489`
  - Fields: `rawLength`, `session.id`, `messageID`, `callID`, `tool`, `error`
  - Meaning: publishing an explicit `SessionEvent.Tool.Input.Ended` event failed.

- `tool implicit input ended event publish failed`
  - Code: `ETOOL001`
  - Source: `packages/opencode/src/session/processor.ts:525`
  - Fields: `rawLength`, `inputLength`, `session.id`, `messageID`, `callID`, `tool`, `error`
  - Meaning: the processor reached `tool-call` before seeing `tool-input-end`, then failed while publishing the synthesized input-ended event.

- `tool called event publish failed`
  - Code: `ETOOL001`
  - Source: `packages/opencode/src/session/processor.ts:557`
  - Fields: `rawLength`, `inputLength`, `providerExecuted`, `session.id`, `messageID`, `callID`, `tool`, `error`
  - Meaning: publishing `SessionEvent.Tool.Called` failed, likely while carrying parsed tool input.

- `tool call state update failed`
  - Code: `ETOOL002`
  - Source: `packages/opencode/src/session/processor.ts:587`
  - Fields: `rawLength`, `inputLength`, `providerExecuted`, `session.id`, `messageID`, `callID`, `tool`, `error`
  - Meaning: persisting the tool part as `running` with its parsed input failed.

## Large Tool Output

These logs indicate failures while publishing or persisting completed tool output.

- `tool success event publish failed`
  - Code: `ETOOL001`
  - Source: `packages/opencode/src/session/processor.ts:729`
  - Fields: `outputLength`, `attachmentCount`, `metadataKeyCount`, `session.id`, `messageID`, `callID`, `tool`, `error`
  - Meaning: publishing `SessionEvent.Tool.Success` failed, likely while carrying large output content or attachments.

- `tool completion failed`
  - Code: `ETOOL002`
  - Source: `packages/opencode/src/session/processor.ts:745`
  - Fields: `outputLength`, `attachmentCount`, `metadataKeyCount`, `session.id`, `messageID`, `callID`, `tool`, `error`
  - Meaning: persisting the completed legacy/session tool part failed.

## Halt And Cleanup

These logs correlate generic process failures with the active tool calls that later become abort errors.

- `process`
  - Source: `packages/opencode/src/session/processor.ts:1046`
  - Fields: `session.id`, `messageID`, `error`, `stack`
  - Meaning: the processor halted because of a stream, provider, permission, event, or persistence failure.

- `processor halted with active tool call`
  - Code: `ETOOL002`
  - Source: `packages/opencode/src/session/processor.ts:1058`
  - Fields: `state`, `inputEnded`, `rawLength`, `inputLength`, `providerExecuted`, `aborted`, `cause`, `causeName`, `openToolCalls`, `session.id`, `messageID`, `partID`, `callID`, `tool`
  - Meaning: `halt` ran while one or more tool calls were still tracked in `ctx.toolcalls`. This is the strongest correlation log for provider errors, permission rejections, stream failures, fiber interrupts, or event publish failures that leave a tool unfinished.

- `tool execution aborted during processor cleanup`
  - Code: `ETOOL002`
  - Source: `packages/opencode/src/session/processor.ts:1000`
  - Fields: `state`, `inputEnded`, `rawLength`, `inputLength`, `providerExecuted`, `aborted`, `assistantError`, `openToolCalls`, `session.id`, `messageID`, `partID`, `callID`, `tool`
  - Meaning: cleanup found an unsettled tool call and is about to persist `ETOOL002: Tool execution aborted`. If the V2 event bridge is enabled, cleanup also publishes `ETOOL001: Tool execution aborted` at `packages/opencode/src/session/processor.ts:1018`.

## Triage Guide

- If `ETOOL001` appears with `tool success event publish failed`, inspect event payload size and attachment materialization.
- If `ETOOL002` appears with `tool completion failed`, inspect session persistence and completed tool output size.
- If `ETOOL001` appears with input-related messages, inspect raw function-call argument size and parsed input size.
- If only `processor halted with active tool call` and cleanup logs appear, inspect the preceding `process` log for the actual upstream cause.
- If `rawLength`, `inputLength`, or `outputLength` are unusually large, reproduce with the same tool and compare the failing size against normal successful runs.
