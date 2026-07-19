// OpenCode plugin: preserve existing file line endings, OS default (os.EOL) for new files.
// - `write`: fixed via tool args in `tool.execute.before` (before the original is overwritten).
//   No after-hook needed — the file is correct from the first byte the tool writes.
// - `edit` / `apply_patch`: these tools convert their own diff/patch text against the file's
//   existing ending, but only cover *updates* to already-consistent files. Two gaps remain:
//   brand-new files (edit with empty oldString, apply_patch "Add File") are written verbatim
//   and stay LF-only on Windows, and already-mixed files are never repaired. `tool.execute.before`
//   records each target + its desired ending (existing file -> its current ending, new file ->
//   os.EOL) per callID while the original is still intact; `tool.execute.after` then normalizes
//   the result — which runs *after* the tool, including its synchronous formatter pass, so the
//   fix gets the last word.
import type { Plugin } from "@opencode-ai/plugin"
import fs from "fs"
import path from "path"
import { EOL } from "os"

type Ending = "\n" | "\r\n"

const PENDING_TTL_MS = 5 * 60 * 1000

const convert = (text: string, eol: Ending) => text.replaceAll("\r\n", "\n").replaceAll("\n", eol)
// NUL byte = almost certainly not a text file (same heuristic git uses)
const looksBinary = (text: string) => text.includes("\0")

/** Ending for the given text: any CRLF present -> CRLF, LF present -> LF, no newlines -> OS default. */
function desiredEnding(text: string): Ending {
  if (text.includes("\r\n")) return "\r\n"
  if (text.includes("\n")) return "\n"
  return EOL as Ending
}

/** File targets of an apply_patch text: Add/Update headers (Move to = actual target). */
function patchTargets(patchText: string): { path: string; from?: string }[] {
  const targets: { path: string; from?: string }[] = []
  const lines = patchText.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const add = lines[i].match(/^\*\*\* Add File: (.+)$/)
    if (add) {
      targets.push({ path: add[1].trim() })
      continue
    }
    const update = lines[i].match(/^\*\*\* Update File: (.+)$/)
    if (update) {
      const from = update[1].trim()
      const move = lines[i + 1]?.match(/^\*\*\* Move to: (.+)$/)
      targets.push({ path: move ? move[1].trim() : from, from })
    }
  }
  return targets
}

const plugin: Plugin = async (ctx) => {
  const abs = (f: string) => (path.isAbsolute(f) ? f : path.resolve(ctx.directory, f))
  // callID -> files touched by an `edit`/`apply_patch` call and the ending each should end up
  // with. Filled in `tool.execute.before` (while originals are intact), consumed in
  // `tool.execute.after`. TTL pruning covers calls whose after-hook never fires (tool error/abort).
  const pending = new Map<string, { time: number; files: { path: string; eol: Ending }[] }>()

  const rememberTarget = (callID: string, dest: string, source: string) => {
    const now = Date.now()
    for (const [id, entry] of pending) if (now - entry.time > PENDING_TTL_MS) pending.delete(id)
    let eol: Ending = EOL as Ending // new file -> OS default
    try {
      if (fs.existsSync(source)) {
        const txt = fs.readFileSync(source, "utf-8")
        if (looksBinary(txt)) return
        eol = desiredEnding(txt) // keep original ending
      }
    } catch {
      return
    }
    const entry = pending.get(callID) ?? { time: now, files: [] }
    entry.files.push({ path: dest, eol })
    pending.set(callID, entry)
  }

  return {
    "tool.execute.before": async (input, output) => {
      if (input.tool === "write") {
        const file = output.args.filePath
        if (!file || typeof output.args.content !== "string") return
        if (looksBinary(output.args.content)) return
        const target = abs(file)
        let eol: Ending = EOL as Ending // new file -> OS default
        try {
          if (fs.existsSync(target)) {
            const txt = fs.readFileSync(target, "utf-8")
            if (looksBinary(txt)) return
            eol = desiredEnding(txt)
          }
        } catch {}
        output.args.content = convert(output.args.content, eol)
        return
      }

      if (input.tool === "edit") {
        const file = output.args.filePath
        if (typeof file !== "string" || !file) return
        rememberTarget(input.callID, abs(file), abs(file))
        return
      }

      if (input.tool === "apply_patch") {
        const patch = output.args.patchText
        if (typeof patch !== "string") return
        for (const target of patchTargets(patch)) {
          rememberTarget(input.callID, abs(target.path), abs(target.from ?? target.path))
        }
      }
    },

    // Runs after `edit`/`apply_patch` have written *and* formatted (the formatter runs
    // synchronously inside the tool's execute), so nothing overwrites this fix afterwards.
    "tool.execute.after": async (input) => {
      const entry = pending.get(input.callID)
      if (!entry) return
      pending.delete(input.callID)
      for (const file of entry.files) {
        try {
          const content = await fs.promises.readFile(file.path, "utf-8")
          if (looksBinary(content)) continue
          const converted = convert(content, file.eol)
          if (content !== converted) await fs.promises.writeFile(file.path, converted, "utf-8")
        } catch {}
      }
    },
  }
}

export default plugin
