# LLM Debug: Request Recording and Replay

Every LLM provider call is automatically recorded as raw HTTP request/response
pairs. This is always-on and has negligible overhead — recording checks a
`string | undefined` ref and writes one file per request.

## Where recordings live

```
$XDG_DATA_HOME/opencode/recordings/<session-id>/<timestamp>/
```

When `$XDG_DATA_HOME` is unset the default is `~/.local/share/opencode/recordings/...` (not `~/Library/Application Support/`, which is only used when `$XDG_DATA_HOME` is explicitly set to that path).

## Per-request files

Each recording directory contains:

- `request.http` — the outgoing HTTP request (method line, headers, body)
- `response.http` — the upstream response (status line, headers, body)

Recordings are saved **before** any tool-call or structured-output processing
by the SDK, so you see exactly what the wire delivered.

## Replaying a recording

```
opencode replay-record <record-dir> [--output <dir>]
```

Reads `request.http`, sends it to the original URL via `fetch()`, and saves
the new response alongside a `meta.txt` summary:

```
method: POST
url: https://api.openai.com/v1/chat/completions
status: 200
elapsed: 2341ms
response_size: 18453
api.openai.com
```

By default the replay output is written to `<record-dir>/replay-<timestamp>/`.
Use `--output` to specify a different directory.

### Diffing original vs replayed

```sh
diff <record-dir>/response.http /path/to/replay-out/response.http
```

The common case is comparing response bodies while ignoring headers (timestamps,
request IDs, etc.):

```sh
tail -1 <record-dir>/response.http | jq . > /tmp/orig.json
tail -1 /path/to/replay-out/response.http | jq . > /tmp/replay.json
diff /tmp/orig.json /tmp/replay.json
```

## Implementation

- `src/provider/recorder.ts` — exports `wrapFetch` (wraps any `fetch`-like
  function with recording) and `recordingLayer` (wraps `RequestExecutor` for
  the native LLM runtime path)
- `src/provider/provider.ts:1699` — the AI SDK fetch wrapper in `resolveSDK`
  calls `Recorder.wrapFetch(fetchFn)` so that every AI SDK HTTP request is
  recorded
- `src/session/llm.ts:364-367` — sets `Recorder.currentRecordDir` at the start
  of each LLM `stream()` call and restores the previous value on finalizer
- `src/cli/cmd/replay-record.ts` — `opencode replay-record` CLI command
