import { expect, test } from 'claude-code/testing'
import type { On, TurnStepChunk, TurnUsage } from 'claude-code'

const usage = (output: number): TurnUsage => ({
  model: 'claude-test',
  input_tokens: 100,
  output_tokens: output,
  cache_read_input_tokens: 900,
  cache_creation_input_tokens: 0,
})

// 测速用的是真实的 performance.now()，所以这里用忙等制造真实的时间间隔
const spin = (ms: number) => {
  const until = performance.now() + ms
  while (performance.now() < until) {
    // 等
  }
}

const COMMAND_RUN = {
  command: 'token-speed',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 120 },
} as const

function engine(on: On, output: number, texts = 10) {
  const lines: (string | undefined)[] = []
  on('ui.status', (_, e) => {
    lines.push(e.text)
    return { value: undefined }
  })
  on('command.register', () => ({ value: { command: 'token-speed' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('turn.step', async function* (_, e) {
    spin(200)
    yield { kind: 'thinking', index: 0, text: '想一想' } satisfies TurnStepChunk
    for (let i = 0; i < texts; i++) {
      spin(100)
      yield { kind: 'text', index: 0, text: '你好世界，这是一段测试文字。' } satisfies TurnStepChunk
    }
    yield { kind: 'stop', stopReason: 'end_turn', usage: usage(output) } satisfies TurnStepChunk
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: usage(output) }
  })
  return lines
}

const tpsOf = (line: string | undefined) => Number(/([\d.]+) tok\/s/.exec(line ?? '')?.[1] ?? NaN)

test('一次流式请求：实时速度、结束后的准确速度、本轮汇总和统计命令', { timeoutMs: 15000 }, async ($, on) => {
  const lines = engine(on, 100)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const chunks: TurnStepChunk[] = []
  for await (const chunk of $.turn.step({ turnId: 't1', index: 0, model: 'claude-test', messageCount: 1 })) {
    chunks.push(chunk)
  }
  expect(chunks.length).toBe(12)
  expect(lines.some(l => l?.startsWith('⚡ 生成中 ≈'))).toBe(true)

  const stepLine = lines[lines.length - 1]
  expect(stepLine).toMatch(/^⚡ [\d.]+ tok\/s · 首字 0\.2s · 输出 100 · 缓存 90%$/)
  // 100 token / 约 1 秒
  expect(tpsOf(stepLine)).toBeGreaterThan(80)
  expect(tpsOf(stepLine)).toBeLessThan(125)

  await $.turn.complete({ turnId: 't1', answer: 'ok', durationMs: 1300, isAborted: false, reason: 'answer' })
  expect(lines[lines.length - 1]).toMatch(/^⚡ 本轮 [\d.]+ tok\/s · 1 次请求 · 输出 100 · 缓存 90% · 会话均速 [\d.]+$/)

  const { text } = await $.command.run({ ...COMMAND_RUN, args: '' })
  expect(text).toContain('本会话 1 次模型请求（主对话 1，子代理 0）')
  expect(text).toContain('claude-test：1 次')

  const reset = await $.command.run({ ...COMMAND_RUN, args: 'reset' })
  expect(reset.text).toBe('token 速度统计已清零。')
  expect((await $.command.run({ ...COMMAND_RUN, args: '' })).text).toContain('还没有完成的模型请求')
})

test('太短的请求不计速度；子代理的请求不改状态栏', { timeoutMs: 15000 }, async ($, on) => {
  const lines = engine(on, 5, 1)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-test', messageCount: 1 })) {
    // 读完
  }
  expect(lines[lines.length - 1]).toMatch(/^⚡ -- tok\/s · 首字 0\.2s · 输出 5 · 缓存 90%$/)

  const before = lines.length
  for await (const _ of $.turn.step({ turnId: 'a1', index: 0, model: 'claude-test', messageCount: 1, agentId: 'agent-1' })) {
    // 读完
  }
  expect(lines.length).toBe(before)
  const { text } = await $.command.run({ ...COMMAND_RUN, args: '' })
  expect(text).toContain('主对话 1，子代理 1')
})

test('生成中的粗估按前几次请求的实际比例校准', { timeoutMs: 15000 }, async ($, on) => {
  const lines = engine(on, 100)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const live = () => lines.filter(l => l?.startsWith('⚡ 生成中')).at(-1)

  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-test', messageCount: 1 })) {
    // 读完
  }
  // 第一次没有校准数据：按字数粗估约 129 tok/s，再乘默认比例 2.5；实际是 100
  expect(tpsOf(live())).toBeGreaterThan(250)

  for await (const _ of $.turn.step({ turnId: 't1', index: 1, model: 'claude-test', messageCount: 3 })) {
    // 读完
  }
  expect(tpsOf(live())).toBeGreaterThan(85)
  expect(tpsOf(live())).toBeLessThan(115)
})
