import path from "path"
import { Effect } from "effect"
import { mkdir } from "fs/promises"
import { effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"

export const ReplayRecordCommand = effectCmd({
  command: "replay-record <record-dir>",
  describe: "replay a recorded LLM request and save the response for comparison",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("record-dir", {
        describe: "path to the record directory containing request.http",
        type: "string",
        demandOption: true,
      })
      .option("output", {
        alias: "o",
        describe: "output directory for the replayed response (default: record-dir + /replay-<timestamp>)",
        type: "string",
      }),
  handler: Effect.fn("Cli.replay-record")(function* (args) {
    const recordDir = path.resolve(args.recordDir)
    const requestFile = path.join(recordDir, "request.http")
    const file = yield* Effect.promise(() => Bun.file(requestFile).text().catch(() => ""))
    if (!file) return yield* fail(`request.http not found in ${recordDir}`)

    const [headLine, ...restLines] = file.split("\n")
    const headParts = headLine.split(" ")
    const method = headParts[0]!
    const url = headParts.slice(1).join(" ")

    const headerEnd = restLines.indexOf("")
    const hdrs = restLines.slice(0, headerEnd)
    const body = restLines.slice(headerEnd + 1).join("\n")

    const headers: Record<string, string> = {}
    for (const line of hdrs) {
      const idx = line.indexOf(":")
      if (idx === -1) continue
      headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
    }

    const outDir = args.output
      ? path.resolve(args.output)
      : path.join(recordDir, `replay-${Date.now()}`)
    yield* Effect.promise(() => mkdir(outDir, { recursive: true }))

    const startTime = Date.now()
    let status = 0
    let respBody = ""
    let respHeaders: Record<string, string> = {}

    try {
      const response = yield* Effect.promise(() =>
        fetch(url, {
          method,
          headers,
          body: method === "GET" || method === "HEAD" ? undefined : body,
        }),
      )
      status = response.status
      response.headers.forEach((value, key) => {
        respHeaders[key] = value
      })
      respBody = yield* Effect.promise(() => response.text())
    } catch (e: unknown) {
      respBody = `NETWORK ERROR: ${e instanceof Error ? e.message : String(e)}`
      status = -1
    }

    const elapsed = Date.now() - startTime

    const respLines = [`${status} (${elapsed}ms)`]
    for (const [key, value] of Object.entries(respHeaders)) {
      respLines.push(`${key}: ${value}`)
    }
    respLines.push("")
    respLines.push(respBody)
    yield* Effect.promise(() => Bun.write(path.join(outDir, "response.http"), respLines.join("\n")))

    const metaLines = [
      `method: ${method}`,
      `url: ${url}`,
      `status: ${status}`,
      `elapsed: ${elapsed}ms`,
      `response_size: ${respBody.length}`,
      `${new URL(url).hostname}`,
    ]
    yield* Effect.promise(() => Bun.write(path.join(outDir, "meta.txt"), metaLines.join("\n")))

    UI.println(`replayed ${method} ${url}`)
    UI.println(`  → ${status} (${elapsed}ms, ${(respBody.length / 1024).toFixed(1)} KB)`)
    UI.println(`  → ${outDir}`)
  }),
})
