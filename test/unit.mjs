// 最小测试：不需要 dsh 运行时，直接用假 ctx 驱动事件
import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const handlers = {}
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  on(evt, fn) { (handlers[evt] ||= []).push(fn) },
}
function fire(evt, ...args) {
  return handlers[evt].reduce(async (prev, fn) => {
    const out = await prev
    if (out) return out                     // 已被更早的监听器短路
    return fn(...args, async () => ({ kind: 'allow' }))
  }, Promise.resolve(undefined))
}

const dir = mkdtempSync(join(tmpdir(), 'dup-'))
const statsFile = join(dir, 'stats.json')

const { apply } = await import('../index.js')
apply(ctx, {
  read: { enabled: true, ttlSeconds: 600, minBytes: 100 },
  fetch: { enabled: true, ttlSeconds: 600 },
  stats: true,
  statsFile,
})

// 1. 整读后再整读同一文件 → deny；再发一次 → allow
const f = join(dir, 'a.txt')
writeFileSync(f, 'hello\n'.repeat(100))
await fire('tools/result', { name: 'read', arguments: { file_path: f } }, { isError: false })
const d1 = await fire('tools/pre-execute', { name: 'read', arguments: { file_path: f } })
assert.equal(d1.kind, 'deny', '重复整读应被拦')
assert.match(d1.reason, /offset/)
const d2 = await fire('tools/pre-execute', { name: 'read', arguments: { file_path: f } })
assert.equal(d2.kind, 'allow', '只拦一次，第二次应放行')

// 2. 带 offset/limit 的读取不拦
const d3 = await fire('tools/pre-execute', { name: 'read', arguments: { file_path: f, offset: 10, limit: 5 } })
assert.equal(d3.kind, 'allow', '精确读取不应被拦')

// 3. 文件改过之后允许重读
writeFileSync(f, 'changed\n'.repeat(200))
await fire('tools/result', { name: 'read', arguments: { file_path: f } }, { isError: false })
const d4 = await fire('tools/pre-execute', { name: 'read', arguments: { file_path: f } })
assert.equal(d4.kind, 'deny', '刚读过一次后再整读应被拦')
writeFileSync(f, 'changed again\n'.repeat(50))
const d5 = await fire('tools/pre-execute', { name: 'read', arguments: { file_path: f } })
assert.equal(d5.kind, 'allow', '文件变了应放行')

// 4. 重复抓取同一 URL → 拦一次
await fire('tools/result', { name: 'web_fetch', arguments: { url: 'https://example.com/x/' } }, { isError: false })
const f1 = await fire('tools/pre-execute', { name: 'web_fetch', arguments: { url: 'https://example.com/x' } })
assert.equal(f1.kind, 'deny', '重复抓取应被拦（忽略末尾斜杠）')
const f2 = await fire('tools/pre-execute', { name: 'web_fetch', arguments: { url: 'https://example.com/x' } })
assert.equal(f2.kind, 'allow', '同样只拦一次')

// 5. 不同 URL / 不同文件互不影响
assert.equal((await fire('tools/pre-execute', { name: 'web_fetch', arguments: { url: 'https://example.com/y' } })).kind, 'allow')
assert.equal((await fire('tools/pre-execute', { name: 'read', arguments: { file_path: join(dir, 'b.txt') } })).kind, 'allow')

// 6. 失败的结果不记录（读失败了不该挡下一次）
await fire('tools/result', { name: 'read', arguments: { file_path: join(dir, 'c.txt') } }, { isError: true })
assert.equal((await fire('tools/pre-execute', { name: 'read', arguments: { file_path: join(dir, 'c.txt') } })).kind, 'allow')

// 7. 0.1.1 新增：文件组 file_read（参数名是 path）同样被覆盖
const g = join(dir, 'g.txt')
writeFileSync(g, 'y\n'.repeat(500))
await fire('tools/result', { name: 'file_read', arguments: { path: g } }, { isError: false })
const g1 = await fire('tools/pre-execute', { name: 'file_read', arguments: { path: g } })
assert.equal(g1.kind, 'deny', 'file_read 重复整读应被拦')
assert.equal((await fire('tools/pre-execute', { name: 'file_read', arguments: { path: g } })).kind, 'allow', '只拦一次')
// file_read 带 offset/limit 不拦
assert.equal((await fire('tools/pre-execute', { name: 'file_read', arguments: { path: g, offset: 0, limit: 10 } })).kind, 'allow')

// 8. 0.1.1 新增：小文件不值得拦（minBytes）
const tiny = join(dir, 'tiny.txt')
writeFileSync(tiny, 'x\n')
await fire('tools/result', { name: 'read', arguments: { file_path: tiny } }, { isError: false })
assert.equal((await fire('tools/pre-execute', { name: 'read', arguments: { file_path: tiny } })).kind, 'allow', '小文件不拦')

// 9. 0.1.1 新增：拦截计数写进 stats 文件
assert.ok(existsSync(statsFile), 'stats 文件应被写出')
const st = JSON.parse(readFileSync(statsFile, 'utf8'))
assert.ok(st.blockedReads >= 3, 'blockedReads 应累计（read + file_read 各一次）实际=' + st.blockedReads)
assert.equal(st.blockedFetches, 1, 'blockedFetches 应为 1')
assert.ok(st.bytesAvoided > 0, 'bytesAvoided 应大于 0')
assert.equal(st.total, st.blockedReads + st.blockedFetches + st.blockedSearches)
assert.ok(st.last && st.last.kind, 'last 应记录最后一次拦截')
console.log('stats:', JSON.stringify(st))

// 10. stats 可关
const h2 = {}
const ctx2 = { logger: { info() {}, warn() {} }, on(e, fn) { (h2[e] ||= []).push(fn) } }
apply(ctx2, { stats: false, statsFile: join(dir, 'nope.json'), read: { minBytes: 1 } })
assert.ok(!existsSync(join(dir, 'nope.json')), 'stats:false 时不应写文件')

console.log('all tests passed')
