import { createMemo, createEffect, on, onCleanup, For, Show } from "solid-js"
import type { JSX } from "solid-js"
import { useSync } from "@/context/sync"
import { checksum } from "@opencode-ai/core/util/encode"
import { findLast } from "@opencode-ai/core/util/array"
import { same } from "@/utils/same"
import { Icon } from "@opencode-ai/ui/icon"
import { Accordion } from "@opencode-ai/ui/accordion"
import { StickyAccordionHeader } from "@opencode-ai/ui/sticky-accordion-header"
import { File } from "@opencode-ai/session-ui/file"
import { Markdown } from "@opencode-ai/session-ui/markdown"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import type { Message, Part, UserMessage } from "@opencode-ai/sdk/v2/client"
import { useLanguage } from "@/context/language"
import { useProviders } from "@/hooks/use-providers"
import { useSDK } from "@/context/sdk"
import { useSessionLayout } from "@/pages/session/session-layout"
import { getSessionContext, getSessionTokenTotal } from "./session-context-metrics"
import { estimateSessionContextBreakdown, type SessionContextBreakdownKey } from "./session-context-breakdown"
import { estimateToolCallBreakdown, estimateToolFailureBreakdown, estimateToolInputTokenBreakdown, estimateToolOutputTokenBreakdown, getToolColor } from "./session-tool-breakdown"
import { estimateToolTokenSummary } from "./session-tool-token-summary"
import { createSessionContextFormatter } from "./session-context-format"

const BREAKDOWN_COLOR: Record<SessionContextBreakdownKey, string> = {
  system: "var(--syntax-info)",
  user: "var(--syntax-success)",
  assistant: "var(--syntax-property)",
  tool: "var(--syntax-warning)",
  other: "var(--syntax-comment)",
}

function Stat(props: { label: string; value: JSX.Element }) {
  return (
    <div class="flex flex-col gap-1">
      <div class="text-12-regular text-text-weak">{props.label}</div>
      <div class="text-12-medium text-text-strong">{props.value}</div>
    </div>
  )
}

function RawMessageContent(props: { message: Message; getParts: (id: string) => Part[]; onRendered: () => void }) {
  const file = createMemo(() => {
    const parts = props.getParts(props.message.id)
    const contents = JSON.stringify({ message: props.message, parts }, null, 2)
    return {
      name: `${props.message.role}-${props.message.id}.json`,
      contents,
      cacheKey: checksum(contents),
    }
  })

  return (
    <File
      mode="text"
      file={file()}
      overflow="wrap"
      class="select-text"
      onRendered={() => requestAnimationFrame(props.onRendered)}
    />
  )
}

function RawMessage(props: {
  message: Message
  getParts: (id: string) => Part[]
  onRendered: () => void
  time: (value: number | undefined) => string
  toolOrder: () => string[]
}) {
  const preview = createMemo(() => {
    const parts = props.getParts(props.message.id)
    if (props.message.role === "user") {
      const textPart = parts.find((part) => part.type === "text")
      if (!textPart) return <></>
      return <>{textPart.text}</>
    }
    const toolParts = parts.filter((part) => part.type === "tool")
    if (toolParts.length > 0) {
      return (
        <>
          {toolParts.map((part, i) => {
            const input = part.state.input
            const color = getToolColor(part.tool, props.toolOrder().indexOf(part.tool))
            let label = ""
            let value = ""
            switch (part.tool) {
              case "grep":
                label = "pattern"
                value = `"${input.pattern as string}"`
                break
              case "read":
              case "write":
              case "edit": {
                const filePath = input.filePath as string | undefined
                if (!filePath) break
                label = "file"
                value = filePath.split("/").slice(-3).join("/")
                break
              }
              case "bash":
                label = "cmd"
                value = input.command as string
                break
              case "glob":
                label = "pattern"
                value = input.pattern as string
                break
              case "task":
                label = "desc"
                value = input.description as string
                break
              case "todowrite": {
                const todos = input.todos as Array<{ status: string; content: string }> | undefined
                if (todos && todos.length > 0) {
                  label = `${todos[0].status}`
                  value = todos[0].content
                }
                break
              }
            }
            return (
              <>
                {i > 0 && ", "}
                <span style={{ color }}>{part.tool}</span>
                {label && (
                  <>
                    : <span class="font-medium">{label}</span>: {value}
                  </>
                )}
              </>
            )
          })}
        </>
      )
    }
    const textPart = parts.find((part) => part.type === "text")
    if (!textPart) return <></>
    return <>{textPart.text}</>
  })

  const tokensLabel = () => {
    if (props.message.role === "user") return "t: —"
    const t = props.message.tokens
    const total = t.total ?? (t.input + t.output + t.reasoning + t.cache.read + t.cache.write)
    return `t: ${total} i: ${t.input} o: ${t.output} r: ${t.reasoning} cr: ${t.cache.read} cw: ${t.cache.write}`
  }

  return (
    <Accordion.Item value={props.message.id}>
      <StickyAccordionHeader>
        <Accordion.Trigger>
          <div class="flex items-center justify-between gap-2 w-full">
            <div class="min-w-0 truncate">
              {props.message.role} • {preview()}
            </div>
            <div class="flex items-center gap-3">
              <div class="shrink-0 text-12-regular text-text-weak">{tokensLabel()}</div>
              <div class="shrink-0 text-12-regular text-text-weak">{props.time(props.message.time.created)}</div>
              <Icon name="chevron-grabber-vertical" size="small" class="shrink-0 text-text-weak" />
            </div>
          </div>
        </Accordion.Trigger>
      </StickyAccordionHeader>
      <Accordion.Content class="bg-background-base">
        <div class="p-3">
          <RawMessageContent message={props.message} getParts={props.getParts} onRendered={props.onRendered} />
        </div>
      </Accordion.Content>
    </Accordion.Item>
  )
}

const emptyMessages: Message[] = []
const emptyUserMessages: UserMessage[] = []

export function SessionContextTab() {
  const sync = useSync()
  const language = useLanguage()
  const sdk = useSDK()
  const providers = useProviders(() => sdk().directory)
  const { params, view } = useSessionLayout()

  const info = createMemo(() => (params.id ? sync().session.get(params.id) : undefined))

  const messages = createMemo(
    () => {
      const id = params.id
      if (!id) return emptyMessages
      return (sync().data.message[id] ?? []) as Message[]
    },
    emptyMessages,
    { equals: same },
  )

  const userMessages = createMemo(
    () => messages().filter((m) => m.role === "user") as UserMessage[],
    emptyUserMessages,
    { equals: same },
  )

  const visibleUserMessages = createMemo(
    () => {
      const revert = info()?.revert?.messageID
      if (!revert) return userMessages()
      return userMessages().filter((m) => m.id < revert)
    },
    emptyUserMessages,
    { equals: same },
  )

  const usd = createMemo(
    () =>
      new Intl.NumberFormat(language.intl(), {
        style: "currency",
        currency: "USD",
      }),
  )

  const ctx = createMemo(() => getSessionContext(messages(), [...providers.all().values()]))
  const tokens = createMemo(() => info()?.tokens)
  const formatter = createMemo(() => createSessionContextFormatter(language.intl()))

  const cost = createMemo(() => {
    return usd().format(info()?.cost ?? 0)
  })

  const counts = createMemo(() => {
    const all = messages()
    const user = all.reduce((count, x) => count + (x.role === "user" ? 1 : 0), 0)
    const assistant = all.reduce((count, x) => count + (x.role === "assistant" ? 1 : 0), 0)
    return {
      all: all.length,
      user,
      assistant,
    }
  })

  const systemPrompt = createMemo(() => {
    const msg = findLast(visibleUserMessages(), (m) => !!m.system)
    const system = msg?.system
    if (!system) return
    const trimmed = system.trim()
    if (!trimmed) return
    return trimmed
  })

  const providerLabel = createMemo(() => {
    const c = ctx()
    if (!c) return "—"
    return c.providerLabel
  })

  const modelLabel = createMemo(() => {
    const c = ctx()
    if (!c) return "—"
    return c.modelLabel
  })

  const breakdown = createMemo(
    on(
      () => [ctx()?.message.id, ctx()?.input, messages().length, systemPrompt()],
      () => {
        const c = ctx()
        if (!c?.input) return []
        return estimateSessionContextBreakdown({
          messages: messages(),
          parts: sync().data.part as Record<string, Part[] | undefined>,
          input: c.input,
          systemPrompt: systemPrompt(),
        })
      },
    ),
  )

  const breakdownLabel = (key: SessionContextBreakdownKey) => {
    if (key === "system") return language.t("context.breakdown.system")
    if (key === "user") return language.t("context.breakdown.user")
    if (key === "assistant") return language.t("context.breakdown.assistant")
    if (key === "tool") return language.t("context.breakdown.tool")
    return language.t("context.breakdown.other")
  }

  const toolBreakdown = createMemo(() =>
    estimateToolCallBreakdown(messages(), sync().data.part as Record<string, Part[] | undefined>),
  )

  const toolOrder = createMemo(() => toolBreakdown().map((s) => s.tool))

  const toolFailureBreakdown = createMemo(() =>
    estimateToolFailureBreakdown(messages(), sync().data.part as Record<string, Part[] | undefined>),
  )

  const inputTokenBreakdown = createMemo(() =>
    estimateToolInputTokenBreakdown(messages(), sync().data.part as Record<string, Part[] | undefined>),
  )

  const outputTokenBreakdown = createMemo(() =>
    estimateToolOutputTokenBreakdown(messages(), sync().data.part as Record<string, Part[] | undefined>),
  )

  const toolTokenSummary = createMemo(() =>
    estimateToolTokenSummary(messages(), sync().data.part as Record<string, Part[] | undefined>),
  )

  const stats = [
    { label: "context.stats.session", value: () => info()?.title ?? params.id ?? "—" },
    { label: "context.stats.messages", value: () => counts().all.toLocaleString(language.intl()) },
    { label: "context.stats.provider", value: providerLabel },
    { label: "context.stats.model", value: modelLabel },
    { label: "context.stats.limit", value: () => formatter().number(ctx()?.limit) },
    { label: "context.stats.totalTokens", value: () => formatter().number(getSessionTokenTotal(tokens())) },
    { label: "context.stats.usage", value: () => formatter().percent(ctx()?.usage) },
    { label: "context.stats.inputTokens", value: () => formatter().number(tokens()?.input) },
    { label: "context.stats.outputTokens", value: () => formatter().number(tokens()?.output) },
    { label: "context.stats.reasoningTokens", value: () => formatter().number(tokens()?.reasoning) },
    {
      label: "context.stats.cacheTokens",
      value: () => `${formatter().number(tokens()?.cache.read)} / ${formatter().number(tokens()?.cache.write)}`,
    },
    { label: "context.stats.userMessages", value: () => counts().user.toLocaleString(language.intl()) },
    { label: "context.stats.assistantMessages", value: () => counts().assistant.toLocaleString(language.intl()) },
    { label: "context.stats.totalCost", value: cost },
    { label: "context.stats.sessionCreated", value: () => formatter().time(info()?.time.created) },
    { label: "context.stats.lastActivity", value: () => formatter().time(ctx()?.message.time.created) },
  ] satisfies { label: string; value: () => JSX.Element }[]

  let scroll: HTMLDivElement | undefined
  let frame: number | undefined
  let pending: { x: number; y: number } | undefined
  const getParts = (id: string) => (sync().data.part[id] ?? []) as Part[]

  const restoreScroll = () => {
    const el = scroll
    if (!el) return

    const s = view().scroll("context")
    if (!s) return

    if (el.scrollTop !== s.y) el.scrollTop = s.y
    if (el.scrollLeft !== s.x) el.scrollLeft = s.x
  }

  const handleScroll = (event: Event & { currentTarget: HTMLDivElement }) => {
    pending = {
      x: event.currentTarget.scrollLeft,
      y: event.currentTarget.scrollTop,
    }
    if (frame !== undefined) return

    frame = requestAnimationFrame(() => {
      frame = undefined

      const next = pending
      pending = undefined
      if (!next) return

      view().setScroll("context", next)
    })
  }

  createEffect(
    on(
      () => messages().length,
      () => {
        requestAnimationFrame(restoreScroll)
      },
      { defer: true },
    ),
  )

  onCleanup(() => {
    if (frame === undefined) return
    cancelAnimationFrame(frame)
  })

  return (
    <ScrollView
      class="@container h-full"
      viewportRef={(el) => {
        scroll = el
        restoreScroll()
      }}
      onScroll={handleScroll}
    >
      <div class="px-6 pt-4 pb-10 flex flex-col gap-10">
        <div class="grid grid-cols-1 @[32rem]:grid-cols-2 gap-4">
          <For each={stats}>
            {(stat) => <Stat label={language.t(stat.label as Parameters<typeof language.t>[0])} value={stat.value()} />}
          </For>
        </div>

        <Show when={breakdown().length > 0}>
          <div class="flex flex-col gap-2">
            <div class="text-12-regular text-text-weak">{language.t("context.breakdown.title")}</div>
            <div class="h-2 w-full rounded-full bg-surface-base overflow-hidden flex">
              <For each={breakdown()}>
                {(segment) => (
                  <div
                    class="h-full"
                    style={{
                      width: `${segment.width}%`,
                      "background-color": BREAKDOWN_COLOR[segment.key],
                    }}
                  />
                )}
              </For>
            </div>
            <div class="flex flex-wrap gap-x-3 gap-y-1">
              <For each={breakdown()}>
                {(segment) => (
                  <div class="flex items-center gap-1 text-11-regular text-text-weak">
                    <div class="size-2 rounded-sm" style={{ "background-color": BREAKDOWN_COLOR[segment.key] }} />
                    <div>{breakdownLabel(segment.key)}</div>
                    <div class="text-text-weaker">{segment.percent.toLocaleString(language.intl())}%</div>
                  </div>
                )}
              </For>
            </div>
            <div class="hidden text-11-regular text-text-weaker">{language.t("context.breakdown.note")}</div>
          </div>
        </Show>

        <Show when={inputTokenBreakdown().length > 0}>
          <div class="flex flex-col gap-2">
            <div class="text-12-regular text-text-weak">{language.t("context.toolInputTokens.title")}</div>
            <div class="h-2 w-full rounded-full bg-surface-base overflow-hidden flex">
              <For each={inputTokenBreakdown()}>
                {(segment) => (
                  <div
                    class="h-full"
                    style={{
                      width: `${segment.width}%`,
                      "background-color": getToolColor(segment.tool, toolOrder().indexOf(segment.tool)),
                    }}
                  />
                )}
              </For>
            </div>
            <div class="flex flex-wrap gap-x-3 gap-y-1">
              <For each={inputTokenBreakdown()}>
                {(segment) => (
                  <div class="flex items-center gap-1 text-11-regular text-text-weak">
                    <div class="size-2 rounded-sm" style={{ "background-color": getToolColor(segment.tool, toolOrder().indexOf(segment.tool)) }} />
                    <div>{segment.tool}</div>
                    <div class="text-text-weaker">
                      {segment.tokens.toLocaleString(language.intl())} tokens ({segment.percent}%)
                    </div>
                  </div>
                )}
              </For>
            </div>
          </div>
        </Show>

        <Show when={outputTokenBreakdown().length > 0}>
          <div class="flex flex-col gap-2">
            <div class="text-12-regular text-text-weak">{language.t("context.toolOutputTokens.title")}</div>
            <div class="h-2 w-full rounded-full bg-surface-base overflow-hidden flex">
              <For each={outputTokenBreakdown()}>
                {(segment) => (
                  <div
                    class="h-full"
                    style={{
                      width: `${segment.width}%`,
                      "background-color": getToolColor(segment.tool, toolOrder().indexOf(segment.tool)),
                    }}
                  />
                )}
              </For>
            </div>
            <div class="flex flex-wrap gap-x-3 gap-y-1">
              <For each={outputTokenBreakdown()}>
                {(segment) => (
                  <div class="flex items-center gap-1 text-11-regular text-text-weak">
                    <div class="size-2 rounded-sm" style={{ "background-color": getToolColor(segment.tool, toolOrder().indexOf(segment.tool)) }} />
                    <div>{segment.tool}</div>
                    <div class="text-text-weaker">
                      {segment.tokens.toLocaleString(language.intl())} tokens ({segment.percent}%)
                    </div>
                  </div>
                )}
              </For>
            </div>
          </div>
        </Show>

        {(() => {
          const failureSegments = toolFailureBreakdown()
          if (failureSegments.length === 0) return null
          const totalCalls = failureSegments.reduce((sum, s) => sum + s.success + s.fail, 0)
          const totalFailed = failureSegments.reduce((sum, s) => sum + s.fail, 0)
          const failPercent = totalCalls > 0 ? Math.round((totalFailed / totalCalls) * 1000) / 10 : 0
          return (
            <div class="flex flex-col gap-2">
              <div class="text-12-regular text-text-weak">{language.t("context.toolsFailureBreakdown.title")}</div>
              <div class="text-12-regular text-text-weak">
                {language.t("context.toolsFailureBreakdown.summary", {
                  total: totalCalls.toLocaleString(language.intl()),
                  failed: totalFailed.toLocaleString(language.intl()),
                  percent: failPercent,
                })}
              </div>
              <div class="h-2 w-full rounded-full bg-surface-base overflow-hidden flex">
                <For each={failureSegments}>
                  {(segment) => {
                    const total = segment.success + segment.fail
                    if (total === 0) return null
                    const successWidth = (segment.success / total) * segment.width
                    const failWidth = (segment.fail / total) * segment.width
                    return (
                      <>
                        <div
                          class="h-full"
                          style={{
                            width: `${successWidth}%`,
                      "background-color": getToolColor(segment.tool, toolOrder().indexOf(segment.tool)),
                          }}
                        />
                        <Show when={segment.fail > 0}>
                          <div
                            class="h-full"
                            style={{
                              width: `${failWidth}%`,
                              "background-color": `color-mix(in srgb, ${getToolColor(segment.tool, toolOrder().indexOf(segment.tool))} 60%, var(--syntax-critical) 40%)`,
                            }}
                          />
                        </Show>
                      </>
                    )
                  }}
                </For>
              </div>
              <div class="flex flex-wrap gap-x-3 gap-y-1">
                <For each={failureSegments}>
                  {(segment) => {
                    const total = segment.success + segment.fail
                    if (total === 0) return null
                    const successPercent = ((segment.success / total) * segment.percent).toFixed(1)
                    const failPercent = ((segment.fail / total) * segment.percent).toFixed(1)
                    return (
                      <>
                        <div class="flex items-center gap-1 text-11-regular text-text-weak">
                          <div
                            class="size-2 rounded-sm"
                            style={{ "background-color": getToolColor(segment.tool, toolOrder().indexOf(segment.tool)) }}
                          />
                          <div>{segment.tool} (S)</div>
                          <div class="text-text-weaker">
                            {segment.success.toLocaleString(language.intl())} ({successPercent}%)
                          </div>
                        </div>
                        <Show when={segment.fail > 0}>
                          <div class="flex items-center gap-1 text-11-regular text-text-weak">
                            <div
                              class="size-2 rounded-sm"
                              style={{ "background-color": `color-mix(in srgb, ${getToolColor(segment.tool, toolOrder().indexOf(segment.tool))} 60%, var(--syntax-critical) 40%)` }}
                            />
                            <div>{segment.tool} (F)</div>
                            <div class="text-text-weaker">
                              {segment.fail.toLocaleString(language.intl())} ({failPercent}%)
                            </div>
                          </div>
                        </Show>
                      </>
                    )
                  }}
                </For>
              </div>
            </div>
          )
        })()}

        <Show when={toolTokenSummary().length > 0}>
          <div class="flex flex-col gap-2">
            <div class="text-12-regular text-text-weak">{language.t("context.toolTokenSummary.title")}</div>
            <div class="overflow-x-auto">
              <table class="w-full text-11-regular border-collapse">
                <thead>
                  <tr class="border-b border-border-base">
                    <th class="text-left py-1 px-2 text-text-weak font-normal">Tool</th>
                    <th class="text-right py-1 px-2 text-text-weak font-normal">Calls</th>
                    <th class="text-right py-1 px-2 text-text-weak font-normal">Total</th>
                    <th class="text-right py-1 px-2 text-text-weak font-normal">Share</th>
                    <th class="text-right py-1 px-2 text-text-weak font-normal">Avg</th>
                    <th class="text-right py-1 px-2 text-text-weak font-normal">Median</th>
                    <th class="text-right py-1 px-2 text-text-weak font-normal">P95</th>
                    <th class="text-right py-1 px-2 text-text-weak font-normal">Max</th>
                    <th class="text-right py-1 px-2 text-text-weak font-normal">Max/Med</th>
                    <th class="text-left py-1 px-2 text-text-weak font-normal">Pattern</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={toolTokenSummary()}>
                    {(row) => (
                      <tr class="border-b border-border-base/50">
                        <td class="py-1 px-2 text-text-strong">{row.tool}</td>
                        <td class="text-right py-1 px-2 text-text-weak">
                          {row.calls}
                          <Show when={row.failed > 0}>
                            <span class="text-syntax-critical"> ({row.failed})</span>
                          </Show>
                        </td>
                        <td class="text-right py-1 px-2 text-text-weak">{row.totalTokens.toLocaleString(language.intl())}</td>
                        <td class="text-right py-1 px-2 text-text-weak">{row.sessionShare.toFixed(1)}%</td>
                        <td class="text-right py-1 px-2 text-text-weak">{row.avgPerCall.toFixed(0)}</td>
                        <td class="text-right py-1 px-2 text-text-weak">{row.medianPerCall.toFixed(0)}</td>
                        <td class="text-right py-1 px-2 text-text-weak">{row.p95PerCall.toFixed(0)}</td>
                        <td class="text-right py-1 px-2 text-text-weak">{row.maxPerCall.toLocaleString(language.intl())}</td>
                        <td class="text-right py-1 px-2 text-text-weak">{row.maxToMedianRatio?.toFixed(1) ?? "—"}</td>
                        <td class="py-1 px-2 text-text-weak">{row.pattern}</td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
          </div>
        </Show>

        <Show when={toolBreakdown().length > 0}>
          <div class="flex flex-col gap-2">
            <div class="text-12-regular text-text-weak">{language.t("context.toolsBreakdown.title")}</div>
            <div class="h-2 w-full rounded-full bg-surface-base overflow-hidden flex">
              <For each={toolBreakdown()}>
                {(segment) => (
                  <div
                    class="h-full"
                    style={{
                      width: `${segment.width}%`,
                      "background-color": getToolColor(segment.tool, toolOrder().indexOf(segment.tool)),
                    }}
                  />
                )}
              </For>
            </div>
            <div class="flex flex-wrap gap-x-3 gap-y-1">
              <For each={toolBreakdown()}>
                {(segment) => (
                  <div class="flex items-center gap-1 text-11-regular text-text-weak">
                    <div class="size-2 rounded-sm" style={{ "background-color": getToolColor(segment.tool, toolOrder().indexOf(segment.tool)) }} />
                    <div>{segment.tool}</div>
                    <div class="text-text-weaker">{segment.percent.toLocaleString(language.intl())}%</div>
                  </div>
                )}
              </For>
            </div>
          </div>
        </Show>

        <Show when={systemPrompt()}>
          {(prompt) => (
            <div class="flex flex-col gap-2">
              <div class="text-12-regular text-text-weak">{language.t("context.systemPrompt.title")}</div>
              <div class="border border-border-base rounded-md bg-surface-base px-3 py-2">
                <Markdown text={prompt()} class="text-12-regular" />
              </div>
            </div>
          )}
        </Show>

        <div class="flex flex-col gap-2">
          <div class="text-12-regular text-text-weak">{language.t("context.rawMessages.title")}</div>
          <Accordion multiple>
            <For each={messages()}>
              {(message) => (
                <RawMessage message={message} getParts={getParts} onRendered={restoreScroll} time={formatter().time} toolOrder={toolOrder} />
              )}
            </For>
          </Accordion>
        </div>
      </div>
    </ScrollView>
  )
}
