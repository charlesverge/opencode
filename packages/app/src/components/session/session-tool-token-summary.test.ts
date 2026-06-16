import { describe, expect, test } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { estimateToolTokenSummary } from "./session-tool-token-summary"

const assistant = (id: string, tokens: { input: number; output: number }) => {
  return {
    id,
    role: "assistant",
    time: { created: 1 },
    tokens,
  } as unknown as Message
}

const user = (id: string) => {
  return {
    id,
    role: "user",
    time: { created: 1 },
  } as unknown as Message
}

const toolPart = (
  tool: string,
  callID: string,
  status: "completed" | "error" | "pending" | "running",
  data: { input?: Record<string, unknown>; raw?: string; output?: string; error?: string },
) => {
  let state: Record<string, unknown>
  if (status === "completed") {
    state = { status: "completed", input: data.input ?? {}, output: data.output ?? "", time: { start: 1, end: 2 } }
  } else if (status === "error") {
    state = { status: "error", input: data.input ?? {}, error: data.error ?? "", time: { start: 1, end: 2 } }
  } else if (status === "running") {
    state = { status: "running", input: data.input ?? {}, time: { start: 1 } }
  } else {
    state = { status: "pending", input: data.input ?? {}, raw: data.raw ?? "" }
  }
  return { type: "tool", tool, callID, state } as unknown as Part
}

describe("estimateToolTokenSummary", () => {
  test("returns empty for no messages", () => {
    expect(estimateToolTokenSummary([], {})).toEqual([])
  })

  test("returns empty when no tool parts", () => {
    const messages = [assistant("a1", { input: 100, output: 50 })]
    const parts = { a1: [{ type: "text", text: "hi" }] as unknown as Part[] }
    expect(estimateToolTokenSummary(messages, parts)).toEqual([])
  })

  test("excludes pending and running tool parts", () => {
    const messages = [assistant("a1", { input: 100, output: 50 })]
    const parts = {
      a1: [
        toolPart("bash", "c1", "pending", { raw: "{}" }),
        toolPart("read", "c2", "running", { input: { file: "test.ts" } }),
      ],
    }
    expect(estimateToolTokenSummary(messages, parts)).toEqual([])
  })

  test("single tool, single call returns single_call pattern", () => {
    const messages = [assistant("a1", { input: 100, output: 50 })]
    const parts = {
      a1: [toolPart("bash", "c1", "completed", { input: { command: "ls" }, output: "file1.txt" })],
    }
    const result = estimateToolTokenSummary(messages, parts)
    expect(result).toHaveLength(1)
    expect(result[0].tool).toBe("bash")
    expect(result[0].calls).toBe(1)
    expect(result[0].success).toBe(1)
    expect(result[0].failed).toBe(0)
    expect(result[0].pattern).toBe("single_call")
  })

  test("multiple tools with multiple calls", () => {
    const messages = [
      assistant("a1", { input: 200, output: 100 }),
      assistant("a2", { input: 200, output: 100 }),
    ]
    const parts = {
      a1: [
        toolPart("bash", "c1", "completed", { input: { command: "ls" }, output: "file1.txt" }),
        toolPart("read", "c2", "completed", { input: { file: "test.ts" }, output: "content" }),
      ],
      a2: [
        toolPart("bash", "c3", "completed", { input: { command: "pwd" }, output: "/home" }),
      ],
    }
    const result = estimateToolTokenSummary(messages, parts)
    expect(result).toHaveLength(2)
    const bash = result.find((r) => r.tool === "bash")
    const read = result.find((r) => r.tool === "read")
    expect(bash?.calls).toBe(2)
    expect(read?.calls).toBe(1)
  })

  test("correct median calculation for odd count", () => {
    const messages = [assistant("a1", { input: 400, output: 200 })]
    const parts = {
      a1: [
        toolPart("bash", "c1", "completed", { input: { a: "1" }, output: "x".repeat(40) }),
        toolPart("bash", "c2", "completed", { input: { a: "2" }, output: "x".repeat(80) }),
        toolPart("bash", "c3", "completed", { input: { a: "3" }, output: "x".repeat(120) }),
      ],
    }
    const result = estimateToolTokenSummary(messages, parts)
    expect(result).toHaveLength(1)
    expect(result[0].calls).toBe(3)
    expect(result[0].medianPerCall).toBeGreaterThan(0)
  })

  test("correct median calculation for even count", () => {
    const messages = [assistant("a1", { input: 400, output: 200 })]
    const parts = {
      a1: [
        toolPart("bash", "c1", "completed", { input: { a: "1" }, output: "x".repeat(40) }),
        toolPart("bash", "c2", "completed", { input: { a: "2" }, output: "x".repeat(80) }),
        toolPart("bash", "c3", "completed", { input: { a: "3" }, output: "x".repeat(120) }),
        toolPart("bash", "c4", "completed", { input: { a: "4" }, output: "x".repeat(160) }),
      ],
    }
    const result = estimateToolTokenSummary(messages, parts)
    expect(result).toHaveLength(1)
    expect(result[0].calls).toBe(4)
  })

  test("max call ID tracking", () => {
    const messages = [assistant("a1", { input: 400, output: 200 })]
    const parts = {
      a1: [
        toolPart("bash", "small", "completed", { input: { a: "1" }, output: "x" }),
        toolPart("bash", "big", "completed", { input: { a: "2" }, output: "x".repeat(200) }),
        toolPart("bash", "medium", "completed", { input: { a: "3" }, output: "x".repeat(50) }),
      ],
    }
    const result = estimateToolTokenSummary(messages, parts)
    expect(result).toHaveLength(1)
    expect(result[0].maxCallID).toBe("big")
  })

  test("spike_dominated pattern when max/median >= 3.0", () => {
    const messages = [
      assistant("a1", { input: 100, output: 50 }),
      assistant("a2", { input: 100, output: 50 }),
      assistant("a3", { input: 100, output: 50 }),
      assistant("a4", { input: 100, output: 50 }),
      assistant("a5", { input: 1000, output: 500 }),
    ]
    const parts = {
      a1: [toolPart("bash", "c1", "completed", { input: { a: "1" }, output: "x".repeat(20) })],
      a2: [toolPart("bash", "c2", "completed", { input: { a: "2" }, output: "x".repeat(20) })],
      a3: [toolPart("bash", "c3", "completed", { input: { a: "3" }, output: "x".repeat(20) })],
      a4: [toolPart("bash", "c4", "completed", { input: { a: "4" }, output: "x".repeat(20) })],
      a5: [toolPart("bash", "c5", "completed", { input: { a: "5" }, output: "x".repeat(500) })],
    }
    const result = estimateToolTokenSummary(messages, parts)
    expect(result).toHaveLength(1)
    expect(result[0].pattern).toBe("spike_dominated")
  })

  test("failed_cost_driver pattern when failed tokens >= 25%", () => {
    const messages = [
      assistant("a1", { input: 100, output: 50 }),
      assistant("a2", { input: 100, output: 50 }),
      assistant("a3", { input: 100, output: 50 }),
      assistant("a4", { input: 100, output: 50 }),
      assistant("a5", { input: 400, output: 200 }),
    ]
    const parts = {
      a1: [toolPart("bash", "c1", "completed", { input: { a: "1" }, output: "x".repeat(20) })],
      a2: [toolPart("bash", "c2", "completed", { input: { a: "2" }, output: "x".repeat(20) })],
      a3: [toolPart("bash", "c3", "completed", { input: { a: "3" }, output: "x".repeat(20) })],
      a4: [toolPart("bash", "c4", "completed", { input: { a: "4" }, output: "x".repeat(20) })],
      a5: [toolPart("bash", "c5", "error", { input: { a: "5" }, error: "x".repeat(200) })],
    }
    const result = estimateToolTokenSummary(messages, parts)
    expect(result).toHaveLength(1)
    expect(result[0].pattern).toBe("failed_cost_driver")
    expect(result[0].failed).toBe(1)
  })

  test("consistently_expensive pattern when median >= 5000", () => {
    const messages = [
      assistant("a1", { input: 30000, output: 15000 }),
      assistant("a2", { input: 30000, output: 15000 }),
      assistant("a3", { input: 30000, output: 15000 }),
      assistant("a4", { input: 30000, output: 15000 }),
      assistant("a5", { input: 30000, output: 15000 }),
    ]
    const parts = {
      a1: [toolPart("bash", "c1", "completed", { input: { a: "1" }, output: "x".repeat(10000) })],
      a2: [toolPart("bash", "c2", "completed", { input: { a: "2" }, output: "x".repeat(10000) })],
      a3: [toolPart("bash", "c3", "completed", { input: { a: "3" }, output: "x".repeat(10000) })],
      a4: [toolPart("bash", "c4", "completed", { input: { a: "4" }, output: "x".repeat(10000) })],
      a5: [toolPart("bash", "c5", "completed", { input: { a: "5" }, output: "x".repeat(10000) })],
    }
    const result = estimateToolTokenSummary(messages, parts)
    expect(result).toHaveLength(1)
    expect(result[0].pattern).toBe("consistently_expensive")
  })

  test("repeated_small pattern with many small calls", () => {
    const messages = [
      assistant("a1", { input: 100, output: 50 }),
      assistant("a2", { input: 100, output: 50 }),
      assistant("a3", { input: 100, output: 50 }),
      assistant("a4", { input: 100, output: 50 }),
      assistant("a5", { input: 100, output: 50 }),
      assistant("a6", { input: 100, output: 50 }),
    ]
    const parts = {
      a1: [toolPart("bash", "c1", "completed", { input: { a: "1" }, output: "x" })],
      a2: [toolPart("bash", "c2", "completed", { input: { a: "2" }, output: "x" })],
      a3: [toolPart("bash", "c3", "completed", { input: { a: "3" }, output: "x" })],
      a4: [toolPart("bash", "c4", "completed", { input: { a: "4" }, output: "x" })],
      a5: [toolPart("bash", "c5", "completed", { input: { a: "5" }, output: "x" })],
      a6: [toolPart("bash", "c6", "completed", { input: { a: "6" }, output: "x" })],
    }
    const result = estimateToolTokenSummary(messages, parts)
    expect(result).toHaveLength(1)
    expect(result[0].pattern).toBe("repeated_small")
  })

  test("low_sample pattern with 2-4 calls", () => {
    const messages = [
      assistant("a1", { input: 100, output: 50 }),
      assistant("a2", { input: 100, output: 50 }),
      assistant("a3", { input: 100, output: 50 }),
    ]
    const parts = {
      a1: [toolPart("bash", "c1", "completed", { input: { a: "1" }, output: "x".repeat(50) })],
      a2: [toolPart("bash", "c2", "completed", { input: { a: "2" }, output: "x".repeat(50) })],
      a3: [toolPart("bash", "c3", "completed", { input: { a: "3" }, output: "x".repeat(50) })],
    }
    const result = estimateToolTokenSummary(messages, parts)
    expect(result).toHaveLength(1)
    expect(result[0].pattern).toBe("low_sample")
  })

  test("sorting by total tokens descending", () => {
    const messages = [assistant("a1", { input: 800, output: 400 })]
    const parts = {
      a1: [
        toolPart("small", "c1", "completed", { input: { a: "1" }, output: "x" }),
        toolPart("big", "c2", "completed", { input: { a: "2" }, output: "x".repeat(200) }),
        toolPart("medium", "c3", "completed", { input: { a: "3" }, output: "x".repeat(50) }),
      ],
    }
    const result = estimateToolTokenSummary(messages, parts)
    expect(result).toHaveLength(3)
    expect(result[0].tool).toBe("big")
    expect(result[1].tool).toBe("medium")
    expect(result[2].tool).toBe("small")
  })

  test("session share calculation", () => {
    const messages = [assistant("a1", { input: 400, output: 200 })]
    const parts = {
      a1: [
        toolPart("bash", "c1", "completed", { input: { a: "1" }, output: "x".repeat(100) }),
        toolPart("read", "c2", "completed", { input: { a: "2" }, output: "x".repeat(100) }),
      ],
    }
    const result = estimateToolTokenSummary(messages, parts)
    expect(result).toHaveLength(2)
    const total = result.reduce((sum, r) => sum + r.sessionShare, 0)
    expect(total).toBeCloseTo(100, 0)
  })

  test("max/median ratio is null when median is 0", () => {
    const messages = [assistant("a1", { input: 100, output: 0 })]
    const parts = {
      a1: [
        toolPart("bash", "c1", "completed", { input: { a: "1" }, output: "" }),
        toolPart("bash", "c2", "completed", { input: { a: "2" }, output: "" }),
        toolPart("bash", "c3", "completed", { input: { a: "3" }, output: "x".repeat(40) }),
      ],
    }
    const result = estimateToolTokenSummary(messages, parts)
    expect(result).toHaveLength(1)
    if (result[0].medianPerCall === 0) {
      expect(result[0].maxToMedianRatio).toBeNull()
    }
  })

  test("mixed success and failure counts", () => {
    const messages = [
      assistant("a1", { input: 200, output: 100 }),
      assistant("a2", { input: 200, output: 100 }),
    ]
    const parts = {
      a1: [
        toolPart("bash", "c1", "completed", { input: { a: "1" }, output: "ok" }),
        toolPart("bash", "c2", "error", { input: { a: "2" }, error: "failed" }),
      ],
      a2: [
        toolPart("bash", "c3", "completed", { input: { a: "3" }, output: "ok" }),
      ],
    }
    const result = estimateToolTokenSummary(messages, parts)
    expect(result).toHaveLength(1)
    expect(result[0].calls).toBe(3)
    expect(result[0].success).toBe(2)
    expect(result[0].failed).toBe(1)
  })
})
