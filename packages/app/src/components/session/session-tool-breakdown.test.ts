import { describe, expect, test } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { estimateToolCallBreakdown, estimateToolFailureBreakdown } from "./session-tool-breakdown"

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

const toolPart = (tool: string, status: "completed" | "error" | "pending" | "running" = "completed") => {
  const state =
    status === "completed"
      ? { status: "completed", input: {}, output: "done", time: { start: 1, end: 2 } }
      : status === "error"
        ? { status: "error", error: "failed", time: { start: 1, end: 2 } }
        : { status }
  return {
    type: "tool",
    tool,
    state,
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

describe("estimateToolFailureBreakdown", () => {
  test("returns empty for no messages", () => {
    const output = estimateToolFailureBreakdown([], {})
    expect(output).toEqual([])
  })

  test("returns empty when there are no tool parts", () => {
    const messages = [user("u1"), assistant("a1")]
    const parts = {
      u1: [{ type: "text", text: "hello" }] as unknown as Part[],
      a1: [{ type: "text", text: "response" }] as unknown as Part[],
    }
    const output = estimateToolFailureBreakdown(messages, parts)
    expect(output).toEqual([])
  })

  test("counts only completed and error states, excludes pending and running", () => {
    const messages = [assistant("a1")]
    const parts = {
      a1: [
        toolPart("bash", "completed"),
        toolPart("bash", "completed"),
        toolPart("bash", "error"),
        toolPart("bash", "pending"),
        toolPart("bash", "running"),
      ],
    }
    const output = estimateToolFailureBreakdown(messages, parts)
    expect(output).toHaveLength(1)
    expect(output[0].tool).toBe("bash")
    expect(output[0].success).toBe(2)
    expect(output[0].fail).toBe(1)
    expect(output[0].percent).toBe(100)
  })

  test("distinguishes different tools with success and failure counts", () => {
    const messages = [assistant("a1"), assistant("a2"), assistant("a3")]
    const parts = {
      a1: [toolPart("bash", "completed"), toolPart("bash", "error"), toolPart("read", "completed")],
      a2: [toolPart("bash", "completed")],
      a3: [toolPart("grep", "completed"), toolPart("grep", "error"), toolPart("grep", "error")],
    }
    const output = estimateToolFailureBreakdown(messages, parts)
    expect(output).toHaveLength(3)
    expect(output[0].tool).toBe("bash")
    expect(output[0].success).toBe(2)
    expect(output[0].fail).toBe(1)
    expect(output[1].tool).toBe("grep")
    expect(output[1].success).toBe(1)
    expect(output[1].fail).toBe(2)
    expect(output[2].tool).toBe("read")
    expect(output[2].success).toBe(1)
    expect(output[2].fail).toBe(0)
  })

  test("sorts by total count descending, then alphabetically", () => {
    const messages = [assistant("a1"), assistant("a2")]
    const parts = {
      a1: [toolPart("aaa", "completed"), toolPart("aaa", "completed")],
      a2: [toolPart("bbb", "completed")],
    }
    const output = estimateToolFailureBreakdown(messages, parts)
    expect(output).toHaveLength(2)
    expect(output[0].tool).toBe("aaa")
    expect(output[1].tool).toBe("bbb")
  })

  test("computes correct percentages", () => {
    const messages = [assistant("a1")]
    const parts = {
      a1: [
        toolPart("bash", "completed"),
        toolPart("bash", "completed"),
        toolPart("read", "completed"),
        toolPart("grep", "error"),
      ],
    }
    const output = estimateToolFailureBreakdown(messages, parts)
    expect(output.find((s) => s.tool === "bash")?.percent).toBe(50)
    expect(output.find((s) => s.tool === "read")?.percent).toBe(25)
    expect(output.find((s) => s.tool === "grep")?.percent).toBe(25)
  })

  test("handles tools with only failures", () => {
    const messages = [assistant("a1")]
    const parts = {
      a1: [toolPart("bash", "error"), toolPart("bash", "error")],
    }
    const output = estimateToolFailureBreakdown(messages, parts)
    expect(output).toHaveLength(1)
    expect(output[0].tool).toBe("bash")
    expect(output[0].success).toBe(0)
    expect(output[0].fail).toBe(2)
    expect(output[0].percent).toBe(100)
  })
})
