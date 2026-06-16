import type { Message, Part } from "@opencode-ai/sdk/v2/client"

export type ToolBreakdownSegment = {
  tool: string
  count: number
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
