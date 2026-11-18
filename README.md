# dsh-plugin-dup-guard 🛡️

Blocks the two most expensive kinds of repeated input: **re-reading a whole file** and
**re-fetching the same URL**.

## Why it pays

One full read of a 500-line file is thousands of input tokens. A model that "forgot" it just read
something, or that wants to glance at one section, happily reads the whole thing again — and that
costs more than the thinking it saves.

This plugin intercepts the **second** repeated call and puts the cheaper way into the denial reason
(e.g. `offset=120, limit=40`).

## What is covered (since 0.1.1)

| tool | argument | note |
|---|---|---|
| `read` | `file_path` | the built-in file reader |
| `file_read` | `path` | the device file tool — different argument name, both are handled |
| `web_fetch` | `url` | repeated fetches |
| `web_search` | `query` | off by default (search results move) |
| `bash` / `cat` | — | **not** blocked: shell reads are out of reach and should stay that way |

## The one limitation worth knowing

DSH's `tools/pre-execute` only allows `allow / deny / ask / cancel` — there is **no decision that
returns a cached result**. So this is not "cache acceleration", it is "**block one repeat**":

- full read of the same file again within 10 min → blocked once; if the file changed, allowed
- same URL fetched again within 15 min → blocked once
- **each target is blocked only once**: the model may re-issue the same call and it goes through,
  so a compacted-away context can never deadlock
- reads with `offset` / `limit` are **never** blocked — that is exactly the behaviour we want

## Counters (since 0.1.1)

Every block updates a small JSON file, so the savings are visible instead of guessed:

```sh
cat ~/.dsh-dup-guard-stats.json
```

```json
{ "version": "0.1.1", "blockedReads": 3, "blockedFetches": 1, "blockedSearches": 0,
  "bytesAvoided": 3200, "total": 4, "tracked": 3, "since": "…", "updatedAt": "…",
  "last": { "kind": "read", "target": "/sdcard/notes.md", "at": "…" } }
```

Other plugins (e.g. the whale-notify end-of-turn notification) can read the same file and report
"how much this turn saved".

## Config

| field | default | meaning |
|---|---|---|
| `enabled` | `true` | master switch |
| `read.enabled` | `true` | block repeated full reads |
| `read.ttlSeconds` | `600` | block window (seconds) |
| `read.minBytes` | `2048` | files smaller than this are not tracked or blocked |
| `read.tools` | `["read","file_read"]` | which read tools take part |
| `fetch.enabled` | `true` | block repeated fetches |
| `fetch.ttlSeconds` | `900` | block window (seconds) |
| `search.enabled` | `false` | block repeated searches (off: search results move) |
| `maxEntries` | `300` | record cap, oldest evicted |
| `stats` | `true` | write the counter file |
| `statsFile` | `""` | counter file path, empty = `~/.dsh-dup-guard-stats.json` |

## 30-second self-check

In any session on the phone:

1. Ask the model to "read README.md" — it reads the whole file once.
2. Ask it to "read README.md again".
3. The second call should be **refused** with "这个文件刚刚（N 秒前）已经整份读过…" (read N seconds
   ago, content is still in context, use `offset` / `limit` instead).

If both reads go through, the plugin is not active: check that `dsh-plugin-dup-guard` is listed in
the profile's `dsh.profile.bundles`.

## Reach

Pure host-side, no web client → works on both desktop and phone DSH.

MIT, no dependencies, `node test/unit.mjs` runs directly.
