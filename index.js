// dsh-plugin-dup-guard — 拦掉"重复整读文件"和"重复抓同一个 URL"，省下最贵的输入 token
//
// 为什么是"拦"而不是"给缓存"：DSH 的 tools/pre-execute 只允许 allow / deny / ask / cancel，
// 没有"直接返回一个结果"的决策（见 docs/subsystems/tools.md 的 PreToolDecision）。
// 所以本插件在第二次重复调用时 deny，并把"上次读到什么、该用 offset/limit 怎么取"写进理由，
// 让模型换成精确读取 —— 省掉的是整份内容重新进上下文的开销。
//
// 安全策略：同一个目标只拦一次。模型再发一次同样的调用就放行，避免"缓存命中了但内容已被压缩掉"的死锁。
//
// 0.1.1：① 同时覆盖 read 和文件组 file_read（两套工具的参数名不同：file_path / path）；
//        ② 记拦截次数与省下的字节，写进 stats 文件，方便别的插件（如 whale-notify）读出来展示，
//           不用再靠猜；③ minBytes 真正生效（太小的文件不值得拦）。
import { statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'dup-guard'

const VERSION = '0.1.1'

const DEFAULTS = {
  enabled: true,
  read: { enabled: true, ttlSeconds: 600, minBytes: 2048, tools: ['read', 'file_read'] },
  fetch: { enabled: true, ttlSeconds: 900 },
  search: { enabled: false, ttlSeconds: 900 },
  maxEntries: 300,
  stats: true,
  statsFile: '',
}

const norm = (cfg) => ({
  ...DEFAULTS, ...cfg,
  read: { ...DEFAULTS.read, ...(cfg?.read ?? {}), tools: [...(cfg?.read?.tools ?? DEFAULTS.read.tools)] },
  fetch: { ...DEFAULTS.fetch, ...(cfg?.fetch ?? {}) },
  search: { ...DEFAULTS.search, ...(cfg?.search ?? {}) },
})

const keyOfPath = (p) => String(p ?? '').trim()
const keyOfUrl = (u) => String(u ?? '').trim().replace(/\/+$/, '').toLowerCase()
const keyOfQuery = (q) => String(q ?? '').trim().replace(/\s+/g, ' ').toLowerCase()

// read 用 file_path，文件组 file_read 用 path
const pathOf = (args) => keyOfPath(args?.file_path ?? args?.path)

function fileSig(path) {
  try {
    const s = statSync(path)
    return s.size + ':' + Math.round(s.mtimeMs)
  } catch {
    return undefined
  }
}

function fileSize(path) {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

// offset / limit（read）或 offset / limit / pages（file_read）任一出现就算"精确读取"
function isFullRead(args) {
  if (!args || typeof args !== 'object') return false
  return args.offset === undefined && args.limit === undefined && args.pages === undefined
}

export function apply(ctx, config) {
  const cfg = norm(config)
  if (cfg.enabled === false) return

  const readTools = new Set(cfg.read.tools)
  const isReadTool = (n) => readTools.has(n)

  const log = (level, text) => {
    try {
      const logger = ctx?.logger
      if (typeof logger?.[level] === 'function') logger[level]('[dup-guard] ' + text)
      else if (level !== 'info') process.stderr.write('[dup-guard] ' + level + ': ' + text + '\n')
    } catch {}
  }

  // ── 拦截计数：写成一个小 JSON，别人（通知插件、人类的 shell）都能读 ──
  const statsPath = cfg.stats === true ? (cfg.statsFile || join(homedir(), '.dsh-dup-guard-stats.json')) : ''
  const stats = {
    blockedReads: 0,
    blockedFetches: 0,
    blockedSearches: 0,
    bytesAvoided: 0,
    since: new Date().toISOString(),
  }
  const last = {}
  const flushStats = (kind, target) => {
    if (!statsPath) return
    try {
      const body = {
        version: VERSION,
        ...stats,
        total: stats.blockedReads + stats.blockedFetches + stats.blockedSearches,
        tracked: seen.size,
        updatedAt: new Date().toISOString(),
        last: { kind, target, at: new Date().toISOString() },
      }
      writeFileSync(statsPath, JSON.stringify(body, null, 2) + '\n')
    } catch {}
  }

  /** path|url|query → { at, sig?, lines?, deniedOnce? } */
  const seen = new Map()

  const put = (key, val) => {
    if (seen.size >= cfg.maxEntries) {
      const oldest = seen.keys().next().value
      if (oldest !== undefined) seen.delete(oldest)
    }
    seen.set(key, val)
  }

  const fresh = (entry, ttlSeconds) => !!entry && Date.now() - entry.at <= ttlSeconds * 1000

  // 观察成功的结果，记下来"这个目标刚刚读过/抓过"
  ctx.on('tools/result', (exec, result) => {
    try {
      if (!exec || !result || result.isError) return
      const args = exec.arguments ?? {}
      if (isReadTool(exec.name) && cfg.read.enabled) {
        const path = pathOf(args)
        if (path === '' || !isFullRead(args)) return
        const size = fileSize(path)
        if (size < cfg.read.minBytes) return   // 小文件不值得拦
        put('r:' + path, { at: Date.now(), sig: fileSig(path) })
      } else if (exec.name === 'web_fetch' && cfg.fetch.enabled) {
        const url = keyOfUrl(args.url)
        if (url === '') return
        put('f:' + url, { at: Date.now(), deniedOnce: false })
      } else if (exec.name === 'web_search' && cfg.search.enabled) {
        const q = keyOfQuery(args.query)
        if (q === '') return
        put('s:' + q, { at: Date.now(), deniedOnce: false })
      }
    } catch {}
  })

  // 重复调用 → 拦一次，把"怎么取更省"写进理由
  ctx.on('tools/pre-execute', async (exec, next) => {
    try {
      const args = exec?.arguments ?? {}

      if (isReadTool(exec?.name) && cfg.read.enabled && isFullRead(args)) {
        const path = pathOf(args)
        const entry = seen.get('r:' + path)
        if (path !== '' && fresh(entry, cfg.read.ttlSeconds) && !entry.forcedOnce) {
          const now = fileSig(path)
          const unchanged = entry.sig !== undefined && now !== undefined ? now === entry.sig : true
          if (unchanged && fileSize(path) >= cfg.read.minBytes) {
            entry.forcedOnce = true
            stats.blockedReads++
            stats.bytesAvoided += fileSize(path)
            flushStats('read', path)
            log('info', '拦住重复整读: ' + path)
            return {
              kind: 'deny',
              reason:
                '这个文件刚刚（' + Math.round((Date.now() - entry.at) / 1000) + ' 秒前）已经整份读过，内容在上文里，' +
                '而且文件没有变化。请直接使用上文内容；确实需要再取一遍时，用 offset/limit ' +
                '只取需要的那一段（例如 offset=120, limit=40）。' +
                '（本插件对同一文件只拦一次，再发一次同样的调用就会放行。）',
            }
          }
        }
      }

      if (exec?.name === 'web_fetch' && cfg.fetch.enabled) {
        const url = keyOfUrl(args.url)
        const entry = seen.get('f:' + url)
        if (url !== '' && fresh(entry, cfg.fetch.ttlSeconds) && !entry.deniedOnce) {
          entry.deniedOnce = true
          stats.blockedFetches++
          flushStats('fetch', url)
          log('info', '拦住重复抓取: ' + url)
          return {
            kind: 'deny',
            reason:
              '这个 URL 在 ' + Math.round((Date.now() - entry.at) / 1000) + ' 秒前抓过，正文已在上文里。' +
              '若上文仍可读到，不要重复抓取；若确实丢了，再调用一次同样的 web_fetch 即可（只拦一次）。',
          }
        }
      }

      if (exec?.name === 'web_search' && cfg.search.enabled) {
        const q = keyOfQuery(args.query)
        const entry = seen.get('s:' + q)
        if (q !== '' && fresh(entry, cfg.search.ttlSeconds) && !entry.deniedOnce) {
          entry.deniedOnce = true
          stats.blockedSearches++
          flushStats('search', q)
          log('info', '拦住重复搜索: ' + q)
          return {
            kind: 'deny',
            reason: '同样的搜索词刚刚搜过，结果已在上文里。需要更多来源时请换关键词或直接抓取具体页面。',
          }
        }
      }
    } catch {}

    return next()
  })

  log('info', '已启用：重复整读 ' + (cfg.read.enabled ? cfg.read.ttlSeconds + 's（' + [...readTools].join('/') + '）' : '关') +
    '、重复抓取 ' + (cfg.fetch.enabled ? cfg.fetch.ttlSeconds + 's' : '关') +
    '、重复搜索 ' + (cfg.search.enabled ? cfg.search.ttlSeconds + 's' : '关') +
    (statsPath ? '、计数 → ' + statsPath : ''))
}
