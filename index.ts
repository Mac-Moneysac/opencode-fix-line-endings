// OpenCode plugin: preserve existing file line endings, OS default (os.EOL) for new files.
// `write` is fixed via tool args; `file.edited` normalizes everything else (apply_patch etc.)
// based on the dominant ending already present in the file.
import type { Plugin } from "@opencode-ai/plugin"
import fs from "fs"
import path from "path"
import { EOL } from "os"
 
type Ending = "\n" | "\r\n"
 
const convert = (text: string, eol: Ending) => text.replaceAll("\r\n", "\n").replaceAll("\n", eol)
// NUL byte = almost certainly not a text file (same heuristic git uses)
const looksBinary = (text: string) => text.includes("\0")
 
/** Ending for the given text: any CRLF present -> CRLF, LF present -> LF, no newlines -> OS default. */
function desiredEnding(text: string): Ending {
  if (text.includes("\r\n")) return "\r\n"
  if (text.includes("\n")) return "\n"
  return EOL as Ending
}
 
const plugin: Plugin = async (ctx) => {
  const abs = (f: string) => (path.isAbsolute(f) ? f : path.resolve(ctx.directory, f))
 
  return {
    "tool.execute.before": async (input, output) => {
      if (input.tool !== "write") return
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
    },
 
    event: async ({ event }) => {
      if (event.type !== "file.edited") return
      const file = event.properties.file
      if (!file) return
      try {
        const content = await fs.promises.readFile(abs(file), "utf-8")
        if (looksBinary(content)) return
        const converted = convert(content, desiredEnding(content))
        if (content !== converted) await fs.promises.writeFile(abs(file), converted, "utf-8")
      } catch {}
    },
  }
}
 
export default plugin
