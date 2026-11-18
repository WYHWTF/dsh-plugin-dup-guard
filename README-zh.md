# dsh-plugin-dup-guard 🛡️

拦掉两类最贵的重复输入：**同一个文件被整份重读**、**同一个 URL 被重复抓取**。

## 为什么值钱

一次整读 500 行的文件 ≈ 几千到上万输入 token。模型"忘了刚才读过"、或者只是想再看一眼某个片段时，
很容易整份再读一遍 —— 这一下花的钱，比它省下的思考还多。

本插件在**第二次重复调用**时直接拦截，并把"该怎么取更省"写进拒绝理由（例如 `offset=120, limit=40`）。

## 覆盖哪些工具（0.1.1 起）

| 工具 | 参数 | 说明 |
|---|---|---|
| `read` | `file_path` | 内置读文件工具 |
| `file_read` | `path` | 设备文件组工具（参数名不同，两套都认） |
| `web_fetch` | `url` | 重复抓取 |
| `web_search` | `query` | 默认关闭（搜索结果变化快） |
| `bash` / `cat` | — | **不拦**：shell 里读的内容拦不到，也不该拦 |

## 一个必须说清的限制

DSH 的 `tools/pre-execute` 只允许 `allow / deny / ask / cancel`，**没有"直接返回缓存结果"这种决策**。
所以本插件不是"缓存加速"，而是"**拦住一次重复**"：

- 同一文件整读后 10 分钟内再整读 → 拦一次；文件有改动则放行
- 同一 URL 抓取后 15 分钟内再抓 → 拦一次
- **每个目标只拦一次**：模型再发一次同样的调用就放行，避免"内容已被压缩掉、又读不到"的死锁

带 `offset`/`limit` 的精确读取**永不拦截**（那正是我们希望模型做的事）。

## 拦截计数（0.1.1 起）

每次拦截都会更新一个小 JSON，随时能看省了多少：

```sh
cat ~/.dsh-dup-guard-stats.json
```

```json
{
  "version": "0.1.1",
  "blockedReads": 3,
  "blockedFetches": 1,
  "blockedSearches": 0,
  "bytesAvoided": 3200,
  "total": 4,
  "tracked": 3,
  "since": "2026-11-18T11:03:38.091Z",
  "updatedAt": "2026-11-18T11:03:38.106Z",
  "last": { "kind": "read", "target": "/sdcard/notes.md", "at": "…" }
}
```

`bytesAvoided` 是被拦掉的那些文件的字节数（按拦时的文件大小累计）。
别的插件（例如 whale-notify 的结束通知）也可以读这个文件，把"本轮省了多少"一起报出来。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `read.enabled` | `true` | 拦重复整读 |
| `read.ttlSeconds` | `600` | 拦截窗口（秒） |
| `read.minBytes` | `2048` | 小于这个字节数的文件不记录、不拦（不值得） |
| `read.tools` | `["read","file_read"]` | 参与拦截的读取工具名 |
| `fetch.enabled` | `true` | 拦重复抓取 |
| `fetch.ttlSeconds` | `900` | 拦截窗口（秒） |
| `search.enabled` | `false` | 拦重复搜索（默认关：搜索结果变化快） |
| `maxEntries` | `300` | 记录表上限，超了淘汰最早的 |
| `stats` | `true` | 是否写计数文件 |
| `statsFile` | `""` | 计数文件路径，空 = `~/.dsh-dup-guard-stats.json` |

## 30 秒自检（手机上）

在任意会话里：

1. 让模型「读一下 README.md」——它会整份读一次
2. 再让它「再读一遍 README.md」
3. 第二遍应当被**直接拦下**，理由是「这个文件刚刚（N 秒前）已经整份读过…」

第二遍如果照常放行，说明没生效：查 profile 的 `dsh.profile.bundles` 里有没有 `dsh-plugin-dup-guard`。

## 适用面

纯 host 端插件，不依赖任何 web 客户端 → **电脑和手机都能用**（手机 DSH 上没有 web 前端，本来就装不了带界面的插件）。

MIT，无依赖，`node test/unit.mjs` 可直接跑。
