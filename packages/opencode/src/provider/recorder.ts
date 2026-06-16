import { Effect, Layer } from "effect"
import path from "path"
import { mkdir } from "fs/promises"
import { RequestExecutor } from "@opencode-ai/llm/route"
import type { LLMError } from "@opencode-ai/llm"
import { HttpClientRequest, HttpClientResponse } from "effect/unstable/http"

export const currentRecordDir: { current: string | undefined } = { current: undefined }

function formatHeaders(hdrs: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  hdrs.forEach((value, key) => { out[key] = value })
  return out
}

async function writeFiles(dir: string, req: { method: string; url: string; headers: Record<string, string>; body: string }, resp: { status: number; headers: Record<string, string>; body: string }) {
  await mkdir(dir, { recursive: true })
  const reqLines = [`${req.method} ${req.url}`]
  for (const [key, value] of Object.entries(req.headers)) { reqLines.push(`${key}: ${value}`) }
  reqLines.push("")
  reqLines.push(req.body)
  await Bun.write(path.join(dir, "request.http"), reqLines.join("\n"))

  const respLines = [`${resp.status}`]
  for (const [key, value] of Object.entries(resp.headers)) { respLines.push(`${key}: ${value}`) }
  respLines.push("")
  respLines.push(resp.body)
  await Bun.write(path.join(dir, "response.http"), respLines.join("\n"))
}

export function wrapFetch(baseFetch: typeof fetch): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    const dir = currentRecordDir.current
    if (dir === undefined) return baseFetch(input, init)

    let reqUrl: string
    let reqMethod: string
    let reqBody = ""
    const reqHeaders: Record<string, string> = {}

    if (typeof input === "string") {
      reqUrl = input
      reqMethod = init?.method?.toUpperCase() ?? "GET"
      if (init?.body && typeof init.body === "string") reqBody = init.body
      if (init?.headers) new Headers(init.headers as HeadersInit).forEach((v, k) => { reqHeaders[k] = v })
    } else if (input instanceof URL) {
      reqUrl = input.href
      reqMethod = init?.method?.toUpperCase() ?? "GET"
      if (init?.body && typeof init.body === "string") reqBody = init.body
      if (init?.headers) new Headers(init.headers as HeadersInit).forEach((v, k) => { reqHeaders[k] = v })
    } else {
      const req = input as Request
      reqUrl = req.url
      reqMethod = req.method
      try { reqBody = await req.clone().text() } catch {}
      req.headers.forEach((v, k) => { reqHeaders[k] = v })
      if (init?.body && typeof init.body === "string") reqBody = init.body
      if (init?.headers) new Headers(init.headers as HeadersInit).forEach((v, k) => { reqHeaders[k] = v })
    }

    const response = await baseFetch(input, init)

    const respHeaders: Record<string, string> = {}
    response.headers.forEach((value, key) => { respHeaders[key] = value })
    const respBody = await response.clone().text().catch(() => "")

    await writeFiles(dir, {
      method: reqMethod,
      url: reqUrl,
      headers: reqHeaders,
      body: reqBody,
    }, {
      status: response.status,
      headers: respHeaders,
      body: respBody,
    })

    const bytes = new TextEncoder().encode(respBody)
    return new Response(bytes, {
      status: response.status,
      headers: respHeaders,
    })
  }
}

const recordExecute = (
  inner: RequestExecutor.Interface,
  request: HttpClientRequest.HttpClientRequest,
): Effect.Effect<HttpClientResponse.HttpClientResponse, LLMError> => {
  const dir = currentRecordDir.current
  if (dir === undefined) return inner.execute(request)

  return Effect.gen(function* () {
    yield* Effect.promise(() => mkdir(dir, { recursive: true }))

    const webReq = yield* HttpClientRequest.toWeb(request)
    const reqMethod = webReq.method
    const reqUrl = webReq.url
    const reqHeaders: Record<string, string> = {}
    webReq.headers.forEach((value, key) => { reqHeaders[key] = value })
    const reqBody = yield* Effect.promise(() => webReq.text().catch(() => ""))

    const reqLines = [`${reqMethod} ${reqUrl}`]
    for (const [key, value] of Object.entries(reqHeaders)) { reqLines.push(`${key}: ${value}`) }
    reqLines.push("")
    reqLines.push(reqBody)
    yield* Effect.promise(() => Bun.write(path.join(dir, "request.http"), reqLines.join("\n")))

    const response = yield* inner.execute(request)

    const respBody = yield* Effect.match(response.text, {
      onSuccess: (text) => text,
      onFailure: () => "",
    })
    const respStatus = response.status
    const respRaw = response.headers as Record<string, string>
    const respHeaders: Record<string, string> = { ...respRaw }

    const respLines = [`${respStatus}`]
    for (const [key, value] of Object.entries(respHeaders)) { respLines.push(`${key}: ${value}`) }
    respLines.push("")
    respLines.push(respBody)
    yield* Effect.promise(() => Bun.write(path.join(dir, "response.http"), respLines.join("\n")))

    const bytes = new TextEncoder().encode(respBody)
    const newResponse = new Response(bytes, {
      status: respStatus,
      headers: respHeaders,
    })
    return HttpClientResponse.fromWeb(request, newResponse)
  }) as Effect.Effect<HttpClientResponse.HttpClientResponse, LLMError>
}

export const recordingLayer: Layer.Layer<RequestExecutor.Service, never, RequestExecutor.Service> = Layer.effect(
  RequestExecutor.Service,
  Effect.gen(function* () {
    const inner: RequestExecutor.Interface = yield* RequestExecutor.Service
    return RequestExecutor.Service.of({
      execute: (request) => recordExecute(inner, request),
    })
  }),
)

export * as Recorder from "./recorder"
