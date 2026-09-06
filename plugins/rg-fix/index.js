// rg-fix plugin — OpenCode V2.
// Fixes ripgrep (rg.exe) glob patterns on Windows before shell execution.
// Common issues the LLM generates:
//   1. Forward slashes in --glob (rg on Windows needs backslashes or quoted forward-slash globs)
//   2. Semicolons in --glob (rg uses multiple -g flags, not semicolons)
//   3. Missing quotes around glob patterns containing **

export default {
  id: "rg-fix",
  async setup(ctx) {
    await ctx.tool.hook("execute.before", (event) => {
      if (event.tool !== "shell") return
      const input = event.input || {}
      const cmd = input.command
      if (typeof cmd !== "string") return
      if (!/\brg\b/.test(cmd)) return

      const fixed = fixRgCommand(cmd)
      if (fixed !== cmd) {
        event.input = { ...input, command: fixed }
      }
    })
    console.log("[rg-fix] Plugin loaded successfully")
  },
}

function fixRgCommand(cmd) {
  let result = cmd

  // Fix --glob="path1/path2;path3/path4" → split into separate -g flags
  result = result.replace(
    /--glob\s*=\s*"([^"]*);([^"]*)"/g,
    (_, a, b) => `-g "${normalizeGlob(a)}" -g "${normalizeGlob(b)}"`
  )

  // Fix --glob='path1/path2;path3/path4' (single quotes)
  result = result.replace(
    /--glob\s*=\s*'([^']*);([^']*)'/g,
    (_, a, b) => `-g '${normalizeGlob(a)}' -g '${normalizeGlob(b)}'`
  )

  // Fix --glob="pattern" → normalize the path inside
  result = result.replace(
    /--glob\s*=\s*"([^"]*)"/g,
    (_, pattern) => `--glob="${normalizeGlob(pattern)}"`
  )

  // Fix --glob 'pattern' (space-separated, no equals)
  result = result.replace(
    /--glob\s+'([^']*)'/g,
    (_, pattern) => `--glob '${normalizeGlob(pattern)}'`
  )

  // Fix -g "pattern;pattern" → split into multiple -g flags
  result = result.replace(
    /-g\s+"([^"]*);([^"]*)"/g,
    (_, a, b) => `-g "${normalizeGlob(a)}" -g "${normalizeGlob(b)}"`
  )

  // Fix bare rg --files path/** → rg --files "path/**" (quote unquoted globs)
  result = result.replace(
    /(\brg(?:\.exe)?\s+[^"]*?--files\s+)([^\s"]+\*\*)/g,
    (_, prefix, glob) => `${prefix}"${normalizeGlob(glob)}"`
  )

  return result
}

function normalizeGlob(pattern) {
  if (!pattern) return pattern
  let fixed = pattern.replace(/\//g, "\\")
  fixed = fixed.replace(/\\{2,}/g, "\\")
  return fixed
}
