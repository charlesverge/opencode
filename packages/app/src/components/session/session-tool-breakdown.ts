import type { Message, Part } from "@opencode-ai/sdk/v2/client"

export type ToolBreakdownSegment = {
  tool: string
  count: number
  width: number
  percent: number
}

export type ToolFailureSegment = {
  tool: string
  success: number
  fail: number
  width: number
  percent: number
}

const TOOL_PALETTE = [
  "var(--syntax-regexp)",
  "var(--syntax-string)",
  "var(--syntax-keyword)",
  "var(--syntax-variable)",
  "var(--syntax-type)",
  "var(--syntax-constant)",
  "var(--syntax-object)",
  "var(--syntax-critical)",
]

export function getToolColor(_tool: string, index: number) {
  return TOOL_PALETTE[index % TOOL_PALETTE.length]
}

export function estimateToolCallBreakdown(
  messages: Message[],
  parts: Record<string, Part[] | undefined>,
): ToolBreakdownSegment[] {
  const counts: Record<string, number> = {}

  for (const msg of messages) {
    const messageParts = parts[msg.id] ?? []
    for (const part of messageParts) {
      if (part.type === "tool" && part.tool) {
        counts[part.tool] = (counts[part.tool] ?? 0) + 1
      }
    }
  }

  const entries = Object.entries(counts)
  if (entries.length === 0) return []

  const total = entries.reduce((sum, [, count]) => sum + count, 0)

  return entries
    .sort(([aName, a], [bName, b]) => b - a || aName.localeCompare(bName))
    .map(([tool, count]) => ({
      tool,
      count,
      width: (count / total) * 100,
      percent: Math.round((count / total) * 100 * 10) / 10,
    }))
}

export function estimateToolFailureBreakdown(
  messages: Message[],
  parts: Record<string, Part[] | undefined>,
): ToolFailureSegment[] {
  const stats: Record<string, { success: number; fail: number }> = {}

  for (const msg of messages) {
    const messageParts = parts[msg.id] ?? []
    for (const part of messageParts) {
      if (part.type === "tool" && part.tool && part.state) {
        const status = part.state.status
        if (status === "completed") {
          stats[part.tool] = stats[part.tool] ?? { success: 0, fail: 0 }
          stats[part.tool].success++
        } else if (status === "error") {
          stats[part.tool] = stats[part.tool] ?? { success: 0, fail: 0 }
          stats[part.tool].fail++
        }
      }
    }
  }

  const entries = Object.entries(stats)
  if (entries.length === 0) return []

  const totalCalls = entries.reduce((sum, [, { success, fail }]) => sum + success + fail, 0)

  return entries
    .sort(([aName, a], [bName, b]) => b.success + b.fail - (a.success + a.fail) || aName.localeCompare(bName))
    .map(([tool, { success, fail }]) => ({
      tool,
      success,
      fail,
      width: ((success + fail) / totalCalls) * 100,
      percent: Math.round(((success + fail) / totalCalls) * 100 * 10) / 10,
    }))
}
