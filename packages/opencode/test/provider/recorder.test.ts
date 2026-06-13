import { test, expect, describe, afterAll } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Recorder } from "@/provider/recorder"

async function tmpdir() {
  const dir = path.join("/tmp", `opencode-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

describe("currentRecordDir", () => {
  test("starts undefined", () => {
    expect(Recorder.currentRecordDir.current).toBeUndefined()
  })

  test("can be set and read", () => {
    Recorder.currentRecordDir.current = "/some/dir"
    expect(Recorder.currentRecordDir.current).toBe("/some/dir")
    Recorder.currentRecordDir.current = undefined
  })
})

describe("wrapFetch", () => {
  afterAll(() => {
    Recorder.currentRecordDir.current = undefined
  })

  test("passes through when dir is not set", async () => {
    Recorder.currentRecordDir.current = undefined
    let called = false
    const baseFetch: any = async (_input: RequestInfo | URL, _init?: RequestInit) => {
      called = true
      return new Response("ok", { status: 200 })
    }
    const wrapped = Recorder.wrapFetch(baseFetch)
    const res = await wrapped("https://example.com", { method: "GET" })
    expect(called).toBe(true)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe("ok")
  })

  test("passes through baseFetch result when dir is set", async () => {
    const dir = await tmpdir()
    Recorder.currentRecordDir.current = dir
    const baseFetch: any = async () => new Response("response body", { status: 201, headers: { "x-custom": "val" } })
    const wrapped = Recorder.wrapFetch(baseFetch)
    const res = await wrapped("https://api.example.com/v1/chat", { method: "POST", body: '{"hello":"world"}' })

    expect(res.status).toBe(201)
    expect(res.headers.get("x-custom")).toBe("val")
    const body = await res.text()
    expect(body).toBe("response body")
  })

  test("writes request.http and response.http files", async () => {
    const dir = await tmpdir()
    Recorder.currentRecordDir.current = dir
    const baseFetch: any = async () => new Response('{"choices":[]}', { status: 200, headers: { "content-type": "application/json" } })
    const wrapped = Recorder.wrapFetch(baseFetch)
    await wrapped("https://api.example.com/chat", { method: "POST", body: '{"model":"gpt-4"}' })

    const reqRaw = await Bun.file(path.join(dir, "request.http")).text()
    const respRaw = await Bun.file(path.join(dir, "response.http")).text()

    expect(reqRaw).toContain("POST https://api.example.com/chat")
    expect(reqRaw).toContain('{"model":"gpt-4"}')
    expect(respRaw).toContain("200")
    expect(respRaw).toContain('{"choices":[]}')
  })

  test("writes response headers", async () => {
    const dir = await tmpdir()
    Recorder.currentRecordDir.current = dir
    const baseFetch: any = async () => new Response("ok", { status: 200, headers: { "x-request-id": "abc123", "content-type": "text/plain" } })
    const wrapped = Recorder.wrapFetch(baseFetch)
    await wrapped("https://api.example.com/chat", { method: "POST" })

    const respRaw = await Bun.file(path.join(dir, "response.http")).text()
    expect(respRaw).toContain("x-request-id: abc123")
    expect(respRaw).toContain("content-type: text/plain")
  })

  test("writes request headers from init", async () => {
    const dir = await tmpdir()
    Recorder.currentRecordDir.current = dir
    const baseFetch: any = async () => new Response("ok", { status: 200 })
    const wrapped = Recorder.wrapFetch(baseFetch)
    await wrapped("https://api.example.com/chat", {
      method: "POST",
      headers: { authorization: "Bearer test-key", "x-custom": "val" },
    })

    const reqRaw = await Bun.file(path.join(dir, "request.http")).text()
    expect(reqRaw).toContain("authorization: Bearer test-key")
    expect(reqRaw).toContain("x-custom: val")
  })

  test("handles Request object as input", async () => {
    const dir = await tmpdir()
    Recorder.currentRecordDir.current = dir
    const baseFetch: any = async () => new Response('{"ok":true}', { status: 200 })
    const wrapped = Recorder.wrapFetch(baseFetch)
    await wrapped(new Request("https://api.example.com/stream", { method: "POST", body: '{"stream":true}' }))

    const reqRaw = await Bun.file(path.join(dir, "request.http")).text()
    expect(reqRaw).toContain("POST https://api.example.com/stream")
    expect(reqRaw).toContain('{"stream":true}')
  })

  test("returns a standard Response whose body can be cloned", async () => {
    const dir = await tmpdir()
    Recorder.currentRecordDir.current = dir
    const baseFetch: any = async () => new Response("single-use body", { status: 200 })
    const wrapped = Recorder.wrapFetch(baseFetch)
    const res = await wrapped("https://example.com", { method: "GET" })

    expect(await res.clone().text()).toBe("single-use body")
    expect(await res.clone().text()).toBe("single-use body")
  })

  test("does not write files when fetch throws", async () => {
    const dir = await tmpdir()
    Recorder.currentRecordDir.current = dir
    const baseFetch: any = async () => { throw new Error("network failure") }
    const wrapped = Recorder.wrapFetch(baseFetch)

    await expect(wrapped("https://example.com", { method: "GET" })).rejects.toThrow("network failure")

    const exists = await Bun.file(path.join(dir, "request.http")).exists()
    expect(exists).toBe(false)
  })

  test("records multiple requests to different dirs", async () => {
    const dir1 = await tmpdir()
    const dir2 = await tmpdir()
    const baseFetch: any = async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : (input as Request).url
      return new Response(url, { status: 200 })
    }
    const wrapped = Recorder.wrapFetch(baseFetch)

    Recorder.currentRecordDir.current = dir1
    await wrapped("https://api.example.com/first", { method: "GET" })

    Recorder.currentRecordDir.current = dir2
    await wrapped("https://api.example.com/second", { method: "GET" })

    const req1 = await Bun.file(path.join(dir1, "request.http")).text()
    const req2 = await Bun.file(path.join(dir2, "request.http")).text()
    expect(req1).toContain("https://api.example.com/first")
    expect(req2).toContain("https://api.example.com/second")
  })
})
