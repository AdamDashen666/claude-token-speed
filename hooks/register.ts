import type { EngineInterface, Register, TurnStepResult, TurnUsage } from 'claude-code'

type Step = {
  turnId: string
  model: string
  isAgent: boolean
  /** 发出请求到第一个流式片段 */
  firstChunkMs: number | null
  /** 发出请求到第一段正文 / 思考 / 工具参数 */
  firstContentMs: number | null
  genMs: number
  output: number
  /** 未缓存 + 读缓存 + 写缓存 */
  input: number
  cacheRead: number
  tps: number | null
  /** 流式文字按字数粗估的 token 数，用来校准生成中的实时速度 */
  estimate: number
}

const COMMAND = 'token-speed'
const KEEP = 2000
// 生成时间或输出量太小的请求，算出来的速度只是噪声，不计速度
const MIN_GEN_MS = 300
const MIN_OUTPUT = 16
const LIVE_EVERY_MS = 300
const LIVE_AFTER_MS = 800
const CALIBRATE_FROM = 20
const DEFAULT_RATIO = 2.5

const fmtTps = (v: number) => (v >= 100 ? v.toFixed(0) : v.toFixed(1))
const fmtSec = (ms: number) => `${(ms / 1000).toFixed(1)}s`
const fmtTokens = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n)}`
const pct = (part: number, whole: number) => `${whole > 0 ? Math.round((part / whole) * 100) : 0}%`

/** 生成过程中的粗估：中日韩字符约 0.9 token/字，其余约 3.6 字符/token；结束后换成 API 给的准确值 */
function estimateTokens(text: string): number {
  let wide = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if ((c >= 0x2e80 && c <= 0x9fff) || (c >= 0xac00 && c <= 0xd7af) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xffef)) {
      wide++
    }
  }
  return wide * 0.9 + (text.length - wide) / 3.6
}

/** 按输出 token 加权的平均速度 */
function averageTps(list: readonly Step[]): number | null {
  let out = 0
  let ms = 0
  for (const s of list) {
    if (s.tps !== null) {
      out += s.output
      ms += s.genMs
    }
  }
  return ms > 0 ? (out / ms) * 1000 : null
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

function stepLine(s: Step): string {
  const parts = [s.tps === null ? '⚡ -- tok/s' : `⚡ ${fmtTps(s.tps)} tok/s`]
  if (s.firstChunkMs !== null) parts.push(`首字 ${fmtSec(s.firstChunkMs)}`)
  parts.push(`输出 ${fmtTokens(s.output)}`)
  if (s.input > 0) parts.push(`缓存 ${pct(s.cacheRead, s.input)}`)
  return parts.join(' · ')
}

function turnLine(turn: readonly Step[], sessionAvg: number | null): string {
  const avg = averageTps(turn)
  const output = turn.reduce((n, s) => n + s.output, 0)
  const input = turn.reduce((n, s) => n + s.input, 0)
  const cacheRead = turn.reduce((n, s) => n + s.cacheRead, 0)
  const parts = [avg === null ? '⚡ 本轮' : `⚡ 本轮 ${fmtTps(avg)} tok/s`]
  parts.push(`${turn.length} 次请求`, `输出 ${fmtTokens(output)}`)
  if (input > 0) parts.push(`缓存 ${pct(cacheRead, input)}`)
  if (sessionAvg !== null) parts.push(`会话均速 ${fmtTps(sessionAvg)}`)
  return parts.join(' · ')
}

function describeStep(s: Step): string {
  const parts = [s.tps === null ? '速度不计（太短）' : `${fmtTps(s.tps)} tok/s`]
  if (s.firstChunkMs !== null) parts.push(`首字 ${fmtSec(s.firstChunkMs)}`)
  if (s.firstContentMs !== null && s.firstChunkMs !== null && s.firstContentMs - s.firstChunkMs > 500) {
    parts.push(`首段可见内容 ${fmtSec(s.firstContentMs)}`)
  }
  parts.push(`生成 ${fmtSec(s.genMs)}`, `输出 ${fmtTokens(s.output)}`, `输入 ${fmtTokens(s.input)}（缓存 ${pct(s.cacheRead, s.input)}）`)
  parts.push(s.isAgent ? `${s.model}（子代理）` : s.model)
  return parts.join('，')
}

function summary(steps: readonly Step[]): string {
  if (steps.length === 0) return 'token 速度：本会话还没有完成的模型请求。'
  const main = steps.filter(s => !s.isAgent)
  const lines = [`token 速度 · 本会话 ${steps.length} 次模型请求（主对话 ${main.length}，子代理 ${steps.length - main.length}）`]
  lines.push(`最近一次：${describeStep(steps[steps.length - 1]!)}`)

  const models = new Map<string, Step[]>()
  for (const s of steps) models.set(s.model, [...(models.get(s.model) ?? []), s])
  lines.push('按模型：')
  for (const [model, list] of models) {
    const avg = averageTps(list)
    const ttft = median(list.flatMap(s => (s.firstChunkMs === null ? [] : [s.firstChunkMs])))
    const output = list.reduce((n, s) => n + s.output, 0)
    const input = list.reduce((n, s) => n + s.input, 0)
    const cacheRead = list.reduce((n, s) => n + s.cacheRead, 0)
    lines.push(
      `  ${model}：${list.length} 次 · 均速 ${avg === null ? '--' : fmtTps(avg)} tok/s · 首字中位 ${ttft === null ? '--' : fmtSec(ttft)} · 输出 ${fmtTokens(output)} · 输入 ${fmtTokens(input)}（缓存 ${pct(cacheRead, input)}）`,
    )
  }

  const recent = main.flatMap(s => (s.tps === null ? [] : [fmtTps(s.tps)])).slice(-10)
  if (recent.length > 0) lines.push(`主对话最近 ${recent.length} 次速度：${recent.join('  ')}`)
  const output = steps.reduce((n, s) => n + s.output, 0)
  const input = steps.reduce((n, s) => n + s.input, 0)
  const cacheRead = steps.reduce((n, s) => n + s.cacheRead, 0)
  lines.push(`合计：输出 ${fmtTokens(output)} · 输入 ${fmtTokens(input)} · 缓存命中 ${pct(cacheRead, input)}`)
  lines.push(
    `说明：速度 = 输出 token ÷ 从第一个流式片段到结束的时间，客户端测量，含网络抖动；生成不到 ${MIN_GEN_MS / 1000} 秒或少于 ${MIN_OUTPUT} 个 token 的请求不计速度。`,
  )
  return lines.join('\n')
}

/**
 * 实际 token ÷ 粗估 token。思考内容流出来的是摘要，粗估会偏低很多，
 * 所以用本会话最近几次请求的实际比例去放大生成中的粗估；还没有数据时用 Opus 带思考的实测值（约 2.5–3.2）。
 */
function liveRatio(steps: readonly Step[]): number {
  let output = 0
  let estimate = 0
  for (const s of steps.filter(x => !x.isAgent && x.estimate >= 50).slice(-CALIBRATE_FROM)) {
    output += s.output
    estimate += s.estimate
  }
  return estimate > 0 ? Math.min(8, Math.max(0.5, output / estimate)) : DEFAULT_RATIO
}

type State = {
  steps: Step[]
  /** 不在生成时状态栏该显示的那一行 */
  idleLine: string | undefined
}

function show($: EngineInterface, state: State, line: string | undefined) {
  state.idleLine = line
  $.ui.status(line)
}

export const register: Register = on => {
  const state: State = { steps: [], idleLine: undefined }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: '本会话的 token 速度统计（加 reset 清零）',
      argumentHint: '[reset]',
      immediate: true,
    })
    if (state.idleLine !== undefined) $.ui.status(state.idleLine)
    return next(e)
  })

  on('session.end', ($, e, next) => {
    if (e.reason === 'clear') {
      state.steps = []
      show($, state, undefined)
    }
    return next(e)
  })

  on('command.run', { command: COMMAND }, ($, e) => {
    if (e.args.trim().toLowerCase() === 'reset') {
      state.steps = []
      show($, state, undefined)
      return { text: 'token 速度统计已清零。' }
    }
    return { text: summary(state.steps) }
  })

  on('turn.step', async function* ($, e, next) {
    const isAgent = e.agentId !== undefined
    const sentAt = performance.now()
    const ratio = liveRatio(state.steps)
    let firstChunk: number | null = null
    let firstContent: number | null = null
    let lastChunk = 0
    let stopAt: number | null = null
    let stopUsage: TurnUsage | null = null
    let estimate = 0
    let liveAt = 0
    let result: TurnStepResult | undefined

    const stream = next(e)
    try {
      for await (const chunk of stream) {
        const now = performance.now()
        try {
          firstChunk ??= now
          lastChunk = now
          if (chunk.kind === 'text' || chunk.kind === 'thinking') {
            firstContent ??= now
            estimate += estimateTokens(chunk.text)
          } else if (chunk.kind === 'input') {
            firstContent ??= now
            estimate += estimateTokens(chunk.json)
          } else if (chunk.kind === 'tool') {
            firstContent ??= now
          } else if (chunk.kind === 'stop') {
            stopAt = now
            stopUsage = chunk.usage
          }
          const elapsed = now - firstChunk
          if (!isAgent && stopAt === null && elapsed >= LIVE_AFTER_MS && now - liveAt >= LIVE_EVERY_MS) {
            liveAt = now
            $.ui.status(`⚡ 生成中 ≈${fmtTps(((estimate * ratio) / elapsed) * 1000)} tok/s · 首字 ${fmtSec(firstChunk - sentAt)}`)
          }
        } catch {
          // 测速出错不能影响回复本身
        }
        yield chunk
      }
      result = await stream.result
      return result
    } finally {
      try {
        const usage = result?.usage ?? stopUsage
        if (usage === null) {
          if (!isAgent) $.ui.status(state.idleLine)
        } else {
          // 服务端工具（如 advisor）在流里运行的时间不算生成时间
          let genMs = firstChunk === null ? 0 : (stopAt ?? lastChunk) - firstChunk
          for (const use of result?.serverToolUses ?? []) {
            if (use.endedAt !== undefined) genMs -= use.endedAt - use.startedAt
          }
          genMs = Math.max(0, genMs)
          const output = usage.output_tokens
          const step: Step = {
            turnId: e.turnId,
            model: usage.model,
            isAgent,
            firstChunkMs: firstChunk === null ? null : firstChunk - sentAt,
            firstContentMs: firstContent === null ? null : firstContent - sentAt,
            genMs,
            output,
            input: usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens,
            cacheRead: usage.cache_read_input_tokens,
            tps: genMs >= MIN_GEN_MS && output >= MIN_OUTPUT ? (output / genMs) * 1000 : null,
            estimate,
          }
          state.steps.push(step)
          if (state.steps.length > KEEP) state.steps = state.steps.slice(-KEEP)
          if (!isAgent) show($, state, stepLine(step))
        }
      } catch {
        // 同上
      }
    }
  })

  on('turn.complete', ($, e, next) => {
    try {
      if (e.agentId === undefined) {
        const turn = state.steps.filter(s => s.turnId === e.turnId && !s.isAgent)
        if (turn.length > 0) show($, state, turnLine(turn, averageTps(state.steps.filter(s => !s.isAgent))))
      }
    } catch {
      // 同上
    }
    return next(e)
  })
}
