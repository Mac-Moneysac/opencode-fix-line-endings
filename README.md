# opencode-fix-line-endings

An [OpenCode](https://opencode.ai) plugin that keeps line endings consistent when the agent writes or patches files:

- **Existing files** keep the line endings they already have.
- **New files** get the operating system's native line endings (`os.EOL` — LF on Linux/macOS, CRLF on Windows).
- **Mixed line endings** produced by a patch (e.g. LF lines inserted into a CRLF file) are normalized back to the file's dominant ending.

Zero configuration. No dependencies.

## Why

As of OpenCode v1.17.x, the built-in tools handle line endings inconsistently:

| Tool          | Behavior                                                                                                 |
| ------------- | -------------------------------------------------------------------------------------------------------- |
| `edit`        | ⚠️ Converts its diff against the file's existing ending (`detectLineEnding` in `edit.ts`) — but only for *updates* to already-consistent files. Brand-new files (empty `oldString`) are written verbatim and stay LF-only. |
| `write`       | ❌ No line-ending handling at all — content is written verbatim                                           |
| `apply_patch` | ❌ Normalizes the patch text to LF and splits the original with `split("\n")` — updates to CRLF files end up with **mixed** endings (untouched lines keep `\r\n`, inserted lines get bare `\n`), and `Add File` hunks are always LF-only |

On Windows this silently breaks files that require CRLF (e.g. `.bat` scripts) and pollutes diffs with line-ending churn.

## How it works

The plugin uses two hooks:

1. **`tool.execute.before`** (for `write`): before the file is written, the target's existing line ending is detected — while the original is still intact — and the `content` argument is converted to it. If the file doesn't exist yet, `os.EOL` is used. This alone makes `write` correct from the first byte, so no after-hook is needed for it.
2. **`tool.execute.before` + `tool.execute.after`** (for `edit` and `apply_patch`): the before-hook resolves each target file the call is about to touch — for `apply_patch` by parsing the patch headers (`Add File` / `Update File` / `Move to`) — and records the ending it should end up with (new files → `os.EOL`, existing files → their current ending, read while still intact), keyed by `callID`. The after-hook then normalizes those files. Since both tools run the project formatter *synchronously inside* their execution, the after-hook is guaranteed to run after the formatter — the fix gets the last word. (The `callID`-keyed map also keeps this working on OpenCode versions where the after-hook input doesn't include the tool args.)

`write` doesn't need step 2 because its content is fixed before the write ever happens. `edit` and `apply_patch` do need it: both only convert their own diff/patch text against an *existing, already-consistent* file — new files and already-mixed files fall through untouched, which is exactly what the after-hook repairs.

Binary safety: content containing a NUL byte (`\0`) is never touched — the same heuristic Git uses to detect binary files.

## Install

OpenCode loads local plugins straight from a plugin directory — no `package.json` or build step needed:

- `~/.config/opencode/plugins/` — available in every project (global)
- `.opencode/plugins/` — available only in this project

**Option 1: Clone the repo**

```sh
git clone https://github.com/Mac-Moneysac/opencode-fix-line-endings.git
cp opencode-fix-line-endings/index.ts ~/.config/opencode/plugins/fix-line-endings.ts
```

**Option 2: Download the file directly**

```sh
curl -o ~/.config/opencode/plugins/fix-line-endings.ts \
  https://raw.githubusercontent.com/Mac-Moneysac/opencode-fix-line-endings/main/index.ts
```

Swap `~/.config/opencode/plugins/` for `.opencode/plugins/` in your project if you'd rather install it per-project instead of globally.

Restart OpenCode afterwards — local plugins are only loaded at startup. Verified against the OpenCode v1.17.20 tool sources; the `edit`/`apply_patch` hook ordering (formatter runs inside the tool, `tool.execute.after` fires afterwards) was additionally confirmed against the current `dev` sources.

## Limitations

- **Intentionally mixed line endings** within a single file are not preserved — every touched file is unified to a single ending. In practice such files are almost always accidents, which is exactly what this plugin is meant to clean up.
- **Formatters:** for `write`, `edit`, and `apply_patch` the formatter runs inside the tool call, and this plugin's fix is applied deterministically afterwards (before-write for `write`, `tool.execute.after` for `edit`/`apply_patch`) — there's no race.
- **Other write paths** (`bash`, MCP tools, etc.) aren't covered — only `write`, `edit`, and `apply_patch` go through these hooks.
- **Aborted `edit`/`apply_patch` calls:** if the tool errors out, the after-hook never fires; recorded state for that call is pruned after 5 minutes rather than kept indefinitely.
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
