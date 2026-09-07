// rg-fix plugin - OpenCode V2.
// Fixes ripgrep (rg.exe) glob patterns on Windows before shell execution.
// Verified against rg 15.2.0 on Windows (forward slashes REQUIRED in --glob):
//   --glob "plugins/**"  -> works (exit 0)
//   --glob "plugins\**"  -> matches nothing (exit 1)
// So normalization goes backslash -> forward slash (NOT the reverse).
// A positional `rg --files path/**` is treated as a PATH (os error 123);
// quoting does not help - it must be promoted to `--glob "path/**"`.

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

  // Split --glob="a;b" into separate -g flags
  result = result.replace(
    /--glob\s*=\s*"([^"]*);([^"]*)"/g,
    (_, a, b) => `-g "${normalizeGlob(a)}" -g "${normalizeGlob(b)}"`
  )

  // Split --glob='a;b' (single quotes)
  result = result.replace(
    /--glob\s*=\s*'([^']*);([^']*)'/g,
    (_, a, b) => `-g '${normalizeGlob(a)}' -g '${normalizeGlob(b)}'`
  )

  // Normalize --glob="pattern"
  result = result.replace(
    /--glob\s*=\s*"([^"]*)"/g,
    (_, pattern) => `--glob="${normalizeGlob(pattern)}"`
  )

  // Normalize --glob 'pattern' (space-separated, no equals)
  result = result.replace(
    /--glob\s+'([^']*)'/g,
    (_, pattern) => `--glob '${normalizeGlob(pattern)}'`
  )

  // Split --glob "a;b" (space-separated) into separate flags
  result = result.replace(
    /--glob\s+"([^"]*);([^"]*)"/g,
    (_, a, b) => `--glob "${normalizeGlob(a)}" --glob "${normalizeGlob(b)}"`
  )

  // Normalize --glob "pattern" (space-separated, no equals)
  result = result.replace(
    /--glob\s+"([^"]*)"/g,
    (_, pattern) => `--glob "${normalizeGlob(pattern)}"`
  )

  // Normalize -g "pattern"
  result = result.replace(
    /-g\s+"([^"]*)"/g,
    (_, pattern) => `-g "${normalizeGlob(pattern)}"`
  )

  // Bare `rg --files path/**` -> promote to `--glob "path/**"`
  // (quoting alone is ineffective: rg parses it as a PATH, os error 123)
  result = result.replace(
    /(\brg(?:\.exe)?\s[^\n]*?--files\s+)(?!-g\b|--glob\b)([^\s"']+[^\s]*\*\*)/g,
    (_, prefix, glob) => `${prefix}--glob "${normalizeGlob(glob)}"`
  )

  return result
}

function normalizeGlob(pattern) {
  if (!pattern) return pattern
  // Windows rg requires FORWARD slashes in globs - convert backslashes
  let fixed = pattern.replace(/\\/g, "/")
  // Collapse duplicate slashes (globs never contain ://)
  fixed = fixed.replace(/\/{2,}/g, "/")
  return fixed
}
