# opencode-fix-line-endings

An [OpenCode](https://opencode.ai/v2) plugin that keeps line endings consistent when the agent writes or patches files:

- **Existing files** keep the line endings they already have.
- **New files** get the operating system's native line endings (`os.EOL` — LF on Linux/macOS, CRLF on Windows).
- **Mixed line endings** produced by a patch (e.g. LF lines inserted into a CRLF file) are normalized back to the file's dominant ending.

Zero configuration. No runtime dependencies.

> Requires **OpenCode v2**. V1 uses a different plugin API and is not supported by this version — pin `0.0.1` if you still need V1.

## Why

OpenCode's built-in file tools handle line endings inconsistently:

| Tool    | Behavior                                                                                                                                                                                                                                                                                   |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `write` | ❌ Writes `content` verbatim (only a BOM is preserved). New files stay LF-only on Windows.                                                                                                                                                                                                  |
| `edit`  | ⚠️ Converts its diff against the file's existing ending (`\r\n` if any CRLF is present, otherwise `\n`). This covers updates to consistent files, but a pre-existing **mixed** file stays mixed (untouched lines keep their ending).                                                       |
| `patch` | ❌ Strips every trailing CR from the patch text and joins content with `\n`, so inserted lines are always LF and `Add File` is LF-only. Updates to CRLF files end up **mixed** (untouched lines keep `\r\n`, inserted lines get bare `\n`).                                                  |

On Windows this silently breaks files that require CRLF (e.g. `.bat` scripts) and pollutes diffs with line-ending churn.

## How it works

The plugin registers two hooks through the V2 plugin API (`Plugin.define` → `setup` → `ctx.tool.hook`):

1. **`execute.before`** (for `write`): before the file is written, the target's existing line ending is detected — while the original is still intact — and the `content` argument is converted to it. If the file doesn't exist yet, `os.EOL` is used. This alone makes `write` correct from the first byte, so no after-hook is needed for it.
2. **`execute.before` + `execute.after`** (for `edit` and `patch`): the before-hook resolves each target file the call is about to touch — for `patch` by parsing the patch headers (`Add File` / `Update File` / `Move to`) — and records the ending it should end up with (new files → `os.EOL`, existing files → their current ending, read while still intact), keyed by the tool call id (`event.id`). The after-hook then normalizes those files. Since both tools run the project formatter *synchronously inside* their execution, the after-hook is guaranteed to run after the formatter — the fix gets the last word.

`write` doesn't need step 2 because its content is fixed before the write ever happens. `edit` and `patch` do need it: both only convert their own diff/patch text against an *existing, already-consistent* file — new files and already-mixed files fall through untouched, which is exactly what the after-hook repairs. The before-observation is required because the after state alone cannot recover the original ending (e.g. an update that rewrites every line loses all traces of CRLF).

Binary safety: content containing a NUL byte (`\0`) is never touched — the same heuristic Git uses to detect binary files.

## Behavior reference

`desiredEnding` picks the ending to normalize a file to, based on what's already in it:

| File content           | `desiredEnding` | Result    |
| ---------------------- | --------------- | --------- |
| CRLF + bare CR         | `\r\n`          | → CRLF    |
| pure CR (classic Mac)  | `\r`            | unchanged |
| LF + bare CR           | `\n`            | → LF      |
| CRLF + LF              | `\r\n`          | → CRLF    |
| LF only                | `\n`            | unchanged |
| CRLF only              | `\r\n`          | unchanged |
| no newlines            | `os.EOL`        | no-op     |

Bare CR is preserved only in pure-CR files; otherwise it is normalized to the file's dominant ending.

## Install

**Option 1: From npm (recommended)**

Add the package name to the `plugins` list in your `opencode.json(c)` — global (`~/.config/opencode/opencode.json`) for every project, or in your project root for just that project:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-fix-line-endings"]
}
```

OpenCode installs and loads npm plugins automatically — no manual download or build step needed. Pin a version with `"opencode-fix-line-endings@0.1.0"` if you want reproducible installs. To pass options, use the object form (`{ "package": "opencode-fix-line-endings", "options": {} }`).

**Option 2: Local file**

OpenCode also loads local plugins straight from a plugin directory — no `package.json` or build step needed:

- `~/.config/opencode/plugins/` — available in every project (global)
- `.opencode/plugins/` — available only in this project

Clone the repo and copy the plugin file:

```sh
git clone https://github.com/Mac-Moneysac/opencode-fix-line-endings.git
cp opencode-fix-line-endings/index.ts ~/.config/opencode/plugins/fix-line-endings.ts
```

Or download the file directly:

```sh
curl -o ~/.config/opencode/plugins/fix-line-endings.ts \
  https://raw.githubusercontent.com/Mac-Moneysac/opencode-fix-line-endings/main/index.ts
```

Swap `~/.config/opencode/plugins/` for `.opencode/plugins/` in your project if you'd rather install it per-project instead of globally.

Restart OpenCode afterwards — plugins are only loaded at startup. Verified against OpenCode v2.0.11; the `edit`/`patch` hook ordering (formatter runs inside the tool, `execute.after` fires afterwards) was confirmed against the V2 runtime.

## Limitations

- **Intentionally mixed line endings** within a single file are not preserved — every touched file is unified to a single ending. In practice such files are almost always accidents, which is exactly what this plugin is meant to clean up.
- **Formatters:** for `write`, `edit`, and `patch` the formatter runs inside the tool call, and this plugin's fix is applied deterministically afterwards (before-write for `write`, `execute.after` for `edit`/`patch`) — there's no race.
- **Other write paths** (`shell`, MCP tools, etc.) aren't covered — only `write`, `edit`, and `patch` go through these hooks.
- **Aborted `edit`/`patch` calls:** if the tool errors out, the after-hook still fires with `status: "error"` and the file is left alone; recorded state for a call that never completes is pruned after 5 minutes rather than kept indefinitely.
- The plugin adds one extra file read per touched file (plus a write when a fix is needed). Negligible in practice.

## Complementary hardening

This plugin fixes endings at write time, but it only covers agents running through OpenCode. For a tool-agnostic safety net, add explicit rules to `.gitattributes`:

```gitattributes
* text=auto
*.bat text eol=crlf
*.sh  text eol=lf
```

and check working-tree endings with `git ls-files --eol`.

## Related

- [`opencode-line-endings`](https://github.com/CodingMarco/opencode-line-endings) — enforces a configured ending (env var → `.editorconfig` → default) instead of preserving the existing one. Use that if you want *enforce* semantics; use this plugin if you want *preserve* semantics without configuration.

## License

MIT
