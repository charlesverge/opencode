import { describe, expect, test } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { estimateToolCallBreakdown } from "./session-tool-breakdown"

const user = (id: string) => {
  return {
    id,
    role: "user",
    time: { created: 1 },
  } as unknown as Message
}

const assistant = (id: string) => {
  return {
    id,
    role: "assistant",
    time: { created: 1 },
  } as unknown as Message
}

const toolPart = (tool: string) => {
  return {
    type: "tool",
    tool,
    state: { status: "completed", input: {}, output: "done", time: { start: 1, end: 2 } },
  } as unknown as Part
}

describe("estimateToolCallBreakdown", () => {
  test("returns empty for no messages", () => {
    const output = estimateToolCallBreakdown([], {})
    expect(output).toEqual([])
  })

  test("returns empty when there are no tool parts", () => {
    const messages = [user("u1"), assistant("a1")]
    const parts = {
      u1: [{ type: "text", text: "hello" }] as unknown as Part[],
      a1: [{ type: "text", text: "response" }] as unknown as Part[],
    }
    const output = estimateToolCallBreakdown(messages, parts)
    expect(output).toEqual([])
  })

  test("counts a single tool call correctly", () => {
    const messages = [assistant("a1")]
    const parts = {
      a1: [toolPart("bash")],
    }
    const output = estimateToolCallBreakdown(messages, parts)
    expect(output).toHaveLength(1)
    expect(output[0].tool).toBe("bash")
    expect(output[0].count).toBe(1)
    expect(output[0].percent).toBe(100)
    expect(output[0].width).toBe(100)
  })

  test("counts multiple calls of the same tool", () => {
    const messages = [assistant("a1"), assistant("a2")]
    const parts = {
      a1: [toolPart("bash")],
      a2: [toolPart("bash")],
    }
    const output = estimateToolCallBreakdown(messages, parts)
    expect(output).toHaveLength(1)
    expect(output[0].tool).toBe("bash")
    expect(output[0].count).toBe(2)
    expect(output[0].percent).toBe(100)
  })

  test("distinguishes different tools and sorts by count descending, then alphabetically", () => {
    const messages = [assistant("a1"), assistant("a2"), assistant("a3")]
    const parts = {
      a1: [toolPart("bash"), toolPart("read"), toolPart("bash")],
      a2: [toolPart("bash")],
      a3: [toolPart("grep"), toolPart("grep"), toolPart("grep")],
    }
    const output = estimateToolCallBreakdown(messages, parts)
    expect(output).toHaveLength(3)
    expect(output[0].tool).toBe("bash")
    expect(output[0].count).toBe(3)
    expect(output[1].tool).toBe("grep")
    expect(output[1].count).toBe(3)
    expect(output[2].tool).toBe("read")
    expect(output[2].count).toBe(1)
  })

  test("computes correct percentages", () => {
    const messages = [assistant("a1")]
    const parts = {
      a1: [toolPart("bash"), toolPart("read"), toolPart("bash"), toolPart("grep")],
    }
    const output = estimateToolCallBreakdown(messages, parts)
    const total = output.reduce((sum, s) => sum + s.count, 0)
    expect(total).toBe(4)
    expect(output.find((s) => s.tool === "bash")?.percent).toBe(50)
    expect(output.find((s) => s.tool === "read")?.percent).toBe(25)
    expect(output.find((s) => s.tool === "grep")?.percent).toBe(25)
  })

  test("handles mixed message types with tool parts only in assistant messages", () => {
    const messages = [user("u1"), assistant("a1")]
    const parts = {
      u1: [{ type: "text", text: "do something" }] as unknown as Part[],
      a1: [toolPart("bash")],
    }
    const output = estimateToolCallBreakdown(messages, parts)
    expect(output).toHaveLength(1)
    expect(output[0].tool).toBe("bash")
    expect(output[0].count).toBe(1)
  })
})
