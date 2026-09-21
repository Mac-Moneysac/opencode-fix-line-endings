// OpenCode V2 plugin: preserve existing file line endings, OS default (os.EOL) for new files.
// - `write`: fixed via tool args in `tool.execute.before` (before the original is overwritten).
//   No after-hook needed — the file is correct from the first byte the tool writes.
// - `edit` / `patch`: these tools convert their own diff/patch text against the file's
//   existing ending, but only cover *updates* to already-consistent files. `patch` additionally
//   strips every trailing CR from the patch text and joins content with `\n`, so its inserted
//   lines are always LF and `Add File` is LF-only; already-mixed files are never repaired.
//   `tool.execute.before` records each target + its desired ending (existing file -> its current
//   ending, new file -> os.EOL) per call id while the original is still intact;
//   `tool.execute.after` then normalizes the result — which runs *after* the tool, including its
//   synchronous formatter pass, so the fix gets the last word.
import { Plugin } from "@opencode/plugin"
import fs from "node:fs"
import path from "node:path"
import { EOL } from "node:os"

type Ending = "\n" | "\r\n" | "\r"

const PENDING_TTL_MS = 5 * 60 * 1000

const convert = (text: string, eol: Ending) => {
  // Collapse CRLF first so any remaining \r is guaranteed to be a bare CR.
  let out = text.replaceAll("\r\n", "\n")
  // Fold bare CR unless the target is pure CR (preserve classic-Mac files).
  if (eol !== "\r") out = out.replaceAll("\r", "\n")
  return out.replaceAll("\n", eol)
}
// NUL byte = almost certainly not a text file (same heuristic git uses)
const looksBinary = (text: string) => text.includes("\0")

/**
 * Ending for the given text: any CRLF present -> CRLF, LF present -> LF,
 * bare CR only (classic Mac) -> CR, no newlines -> OS default.
 */
function desiredEnding(text: string): Ending {
  if (text.includes("\r\n")) return "\r\n"
  if (text.includes("\n")) return "\n"
  if (text.includes("\r")) return "\r"
  return EOL as Ending
}

/** File targets of a patch text: Add/Update headers (Move to = actual target). */
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

export default Plugin.define({
  id: "fix-line-endings",

  async setup(ctx) {
    const abs = (f: string) => (path.isAbsolute(f) ? f : path.resolve(ctx.location.directory, f))

    // Failure/abort fallback: an `edit`/`patch` call whose after-hook never fires (aborted call)
    // would otherwise leak its entry forever — prune entries older than the TTL on each before-hook.
    const pending = new Map<string, { time: number; files: { path: string; eol: Ending }[] }>()

    /** Ending a file already has, or os.EOL when it does not exist (yet). */
    const endingFor = (file: string): Ending | undefined => {
      let eol: Ending = EOL as Ending // new file -> OS default
      try {
        if (fs.existsSync(file)) {
          const txt = fs.readFileSync(file, "utf-8")
          if (looksBinary(txt)) return undefined
          eol = desiredEnding(txt)
        }
      } catch {
        return undefined
      }
      return eol
    }

    const rememberTarget = (id: string, dest: string, source: string) => {
      const now = Date.now()
      for (const [key, entry] of pending) if (now - entry.time > PENDING_TTL_MS) pending.delete(key)
      const eol = endingFor(source)
      if (eol === undefined) return
      const entry = pending.get(id) ?? { time: now, files: [] }
      entry.files.push({ path: dest, eol })
      pending.set(id, entry)
    }

    await ctx.tool.hook("execute.before", (event) => {
      const input = event.input as Record<string, unknown>

      if (event.tool === "write") {
        const file = input.path
        if (typeof file !== "string" || typeof input.content !== "string") return
        if (looksBinary(input.content)) return
        const eol = endingFor(abs(file))
        if (eol === undefined) return
        input.content = convert(input.content, eol)
        return
      }

      if (event.tool === "edit") {
        const file = input.path
        if (typeof file !== "string" || !file) return
        rememberTarget(event.id, abs(file), abs(file))
        return
      }

      if (event.tool === "patch" || event.tool === "apply_patch") {
        const patch = input.patchText
        if (typeof patch !== "string") return
        for (const target of patchTargets(patch)) {
          rememberTarget(event.id, abs(target.path), abs(target.from ?? target.path))
        }
      }
    })

    // Runs after `edit`/`patch` have written *and* formatted (the formatter runs
    // synchronously inside the tool's execute), so nothing overwrites this fix afterwards.
    await ctx.tool.hook("execute.after", async (event) => {
      const entry = pending.get(event.id)
      if (!entry) return
      pending.delete(event.id)
      if (event.status !== "completed") return
      for (const file of entry.files) {
        try {
          const content = await fs.promises.readFile(file.path, "utf-8")
          if (looksBinary(content)) continue
          const converted = convert(content, file.eol)
          if (content !== converted) await fs.promises.writeFile(file.path, converted, "utf-8")
        } catch {}
      }
    })
  },
})
