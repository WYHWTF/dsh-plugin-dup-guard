# Changelog

## 0.1.1

- **Coverage**: the device file tool `file_read` (argument `path`) is guarded too, not only the
  built-in `read` (`file_path`). Configurable via `read.tools`.
- **Counters**: every block updates `~/.dsh-dup-guard-stats.json` — `blockedReads`, `blockedFetches`,
  `blockedSearches`, `bytesAvoided`, `total`, `tracked`, `last` — so the savings are observable
  instead of guessed, and other plugins (e.g. an end-of-turn notification) can read them.
  `stats: false` turns it off, `statsFile` moves it.
- `read.minBytes` now actually does something: files under 2 KB are not tracked and not blocked.
- The denial reason dropped the internal hint and just points at `offset` / `limit`.

## 0.1.0 — first release

- Blocks the **second** whole-file read of a file that was just read whole, and the second fetch of
  the same URL, inside a time window (`read.ttlSeconds` 600 s, `fetch.ttlSeconds` 900 s). The denial
  reason carries the cheaper way out (`offset=120, limit=40`) so the model corrects itself instead
  of burning the same tokens twice.
- **Blocks once per target.** `tools/pre-execute` can only `allow / deny / ask / cancel` — there is
  no "return a cached result" decision — so the guard refuses exactly one repeat and lets the next
  identical call through. A context that was compacted away can therefore never deadlock.
- Precise reads (`offset` / `limit`) are never blocked; only whole-file reads are.
- Freshness is checked with `size:mtime`, so a file that changed since the last read is always
  allowed.
- Repeated `web_search` exists but ships **off** (`search.enabled: false`): search results move.
- No dependencies, pure host side, no web client needed → works on phone and desktop DSH.
  Verified live on a vivo V2617A (Android 16), DSH-Android 0.3.11 / engine 0.2.1-rc.5: a second
  whole read of a 6.6 KB file was refused with the "already read, use offset/limit" reason.
