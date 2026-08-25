import type { Message, Part, ToolPart } from "@opencode-ai/sdk/v2/client"

export type ToolTokenSummaryRow = {
  tool: string
  calls: number
  success: number
  failed: number
  totalTokens: number
  sessionShare: number
  inputTokens: number
  outputTokens: number
  avgPerCall: number
  medianPerCall: number
  p95PerCall: number
  maxPerCall: number
  maxCallID: string
  maxToMedianRatio: number | null
  failedTokens: number
  pattern: string
}

type ToolCallRecord = {
  tool: string
  callID: string
  status: "completed" | "error"
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

const SMALL_TOKEN_THRESHOLD = 500
const EXPENSIVE_TOKEN_THRESHOLD = 5_000
const SPIKE_RATIO_THRESHOLD = 3.0
const FAILED_TOKEN_SHARE_THRESHOLD = 0.25

function estimateInputChars(part: ToolPart): number {
  const state = part.state
  if (state.status === "pending") return state.raw.length
  return JSON.stringify(state.input).length
}

function estimateOutputChars(part: ToolPart): number {
  const state = part.state
  if (state.status === "completed") return state.output.length
  if (state.status === "error") return state.error.length
  return 0
}

function classifyPattern(
  calls: number,
  avgPerCall: number,
  maxToMedianRatio: number | null,
  medianPerCall: number,
  failedTokenShare: number,
): string {
  if (calls === 1) return "single_call"
  if (calls < 5) return "low_sample"
  if (failedTokenShare >= FAILED_TOKEN_SHARE_THRESHOLD) return "failed_cost_driver"
  if (maxToMedianRatio !== null && maxToMedianRatio >= SPIKE_RATIO_THRESHOLD) return "spike_dominated"
  if (medianPerCall >= EXPENSIVE_TOKEN_THRESHOLD) return "consistently_expensive"
  if (calls >= 5 && avgPerCall <= SMALL_TOKEN_THRESHOLD && (maxToMedianRatio === null || maxToMedianRatio < 2.0)) {
    return "repeated_small"
  }
  return "stable_medium"
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 0) {
    return Math.round((sorted[mid - 1] + sorted[mid]) / 2)
  }
  return sorted[mid]
}

function p95(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.ceil(sorted.length * 0.95) - 1
  return sorted[Math.max(0, index)]
}

export function estimateToolTokenSummary(
  messages: Message[],
  parts: Record<string, Part[] | undefined>,
): ToolTokenSummaryRow[] {
  const allCalls: ToolCallRecord[] = []

  for (const msg of messages) {
    if (msg.role !== "assistant") continue

    const messageParts = parts[msg.id] ?? []
    const toolParts: ToolPart[] = []

    for (const part of messageParts) {
      if (part.type === "tool" && part.tool && part.state) {
        const status = part.state.status
        if (status === "completed" || status === "error") {
          toolParts.push(part as ToolPart)
        }
      }
    }

    if (toolParts.length === 0) continue

    const msgTokens = msg.tokens
    let sumRawInput = 0
    let sumRawOutput = 0

    const rawEstimates: { input: number; output: number }[] = []

    for (const part of toolParts) {
      const inputChars = estimateInputChars(part)
      const outputChars = estimateOutputChars(part)
      const rawInput = Math.ceil(inputChars / 4)
      const rawOutput = Math.ceil(outputChars / 4)
      rawEstimates.push({ input: rawInput, output: rawOutput })
      sumRawInput += rawInput
      sumRawOutput += rawOutput
    }

    const scaleInput = sumRawInput > 0 ? msgTokens.input / sumRawInput : 1
    const scaleOutput = sumRawOutput > 0 ? msgTokens.output / sumRawOutput : 1

    for (let i = 0; i < toolParts.length; i++) {
      const part = toolParts[i]
      const raw = rawEstimates[i]
      const inputTokens = Math.round(raw.input * scaleInput)
      const outputTokens = Math.round(raw.output * scaleOutput)
      const totalTokens = inputTokens + outputTokens

      allCalls.push({
        tool: part.tool,
        callID: part.callID,
        status: part.state.status as "completed" | "error",
        inputTokens,
        outputTokens,
        totalTokens,
      })
    }
  }

  if (allCalls.length === 0) return []

  const grouped: Record<string, ToolCallRecord[]> = {}
  for (const call of allCalls) {
    if (!grouped[call.tool]) grouped[call.tool] = []
    grouped[call.tool].push(call)
  }

  const allTotalTokens = allCalls.reduce((sum, c) => sum + c.totalTokens, 0)

  const rows: ToolTokenSummaryRow[] = []

  for (const [tool, calls] of Object.entries(grouped)) {
    const callCount = calls.length
    const successCount = calls.filter((c) => c.status === "completed").length
    const failedCount = calls.filter((c) => c.status === "error").length

    const totalTokens = calls.reduce((sum, c) => sum + c.totalTokens, 0)
    const inputTokens = calls.reduce((sum, c) => sum + c.inputTokens, 0)
    const outputTokens = calls.reduce((sum, c) => sum + c.outputTokens, 0)
    const failedTokens = calls.filter((c) => c.status === "error").reduce((sum, c) => sum + c.totalTokens, 0)

    const sessionShare = allTotalTokens > 0 ? (totalTokens / allTotalTokens) * 100 : 0
    const avgPerCall = totalTokens / callCount

    const totalPerCall = calls.map((c) => c.totalTokens)
    const medianPerCall = median(totalPerCall)
    const p95PerCall = p95(totalPerCall)

    let maxPerCall = 0
    let maxCallID = ""
    for (const c of calls) {
      if (c.totalTokens > maxPerCall || (c.totalTokens === maxPerCall && maxCallID === "")) {
        maxPerCall = c.totalTokens
        maxCallID = c.callID
      }
    }

    const maxToMedianRatio = medianPerCall > 0 ? maxPerCall / medianPerCall : null
    const failedTokenShare = totalTokens > 0 ? failedTokens / totalTokens : 0

    const pattern = classifyPattern(callCount, avgPerCall, maxToMedianRatio, medianPerCall, failedTokenShare)

    rows.push({
      tool,
      calls: callCount,
      success: successCount,
      failed: failedCount,
      totalTokens,
      sessionShare,
      inputTokens,
      outputTokens,
      avgPerCall,
      medianPerCall,
      p95PerCall,
      maxPerCall,
      maxCallID,
      maxToMedianRatio,
      failedTokens,
      pattern,
    })
  }

  rows.sort((a, b) => b.totalTokens - a.totalTokens || b.maxPerCall - a.maxPerCall)

  return rows
}
