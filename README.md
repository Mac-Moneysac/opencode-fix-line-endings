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
| `edit`        | ✅ Preserves the file's existing line endings natively (`detectLineEnding` in `edit.ts`)                  |
| `write`       | ❌ No line-ending handling at all — content is written verbatim                                           |
| `apply_patch` | ❌ Normalizes the patch text to LF and splits the original with `split("\n")` — updates to CRLF files end up with **mixed** endings (untouched lines keep `\r\n`, inserted lines get bare `\n`), and `Add File` hunks are always LF-only |

On Windows this silently breaks files that require CRLF (e.g. `.bat` scripts) and pollutes diffs with line-ending churn.

## How it works

The plugin uses two hooks:

1. **`tool.execute.before`** (for `write` only): before the file is written, the target's existing line ending is detected — while the original is still intact — and the `content` argument is converted to it. If the file doesn't exist yet, `os.EOL` is used.
2. **`file.edited`** event: after any tool writes a file, the file is re-read and normalized to its dominant ending — if any `\r\n` is present, everything becomes CRLF; otherwise LF is kept. This is what repairs the mixed output of `apply_patch`, and it's a no-op for already-consistent files.

`edit` is intentionally left alone since OpenCode already preserves endings there.

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

Restart OpenCode afterwards — local plugins are only loaded at startup. Verified against the OpenCode v1.17.20 tool sources.

## Limitations

- **`apply_patch` + `Add File` on Windows:** brand-new files created via `apply_patch` come out LF-only and stay LF. By the time the `file.edited` event fires, there is no way to tell the file was new, so the OS-default rule can't be applied. New files created via the `write` tool are handled correctly.
- **Intentionally mixed line endings** within a single file are not preserved — the post-edit pass unifies them to CRLF as soon as one `\r\n` is present. In practice such files are almost always accidents, which is exactly what this plugin is meant to clean up.
- **Formatters:** `write` and `apply_patch` run the project formatter after writing. The `file.edited` pass fires afterwards and gets the last word, but a formatter that aggressively rewrites endings on every run may fight with it.
- The plugin adds one extra file read per edited file (plus a write when a fix is needed). Negligible in practice.

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
