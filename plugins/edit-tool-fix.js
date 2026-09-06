/**
 * Edit Tool Fix Plugin
 * 
 * Fixes common edit tool failures BEFORE execution:
 * 1. Path normalization (mixed slashes, trailing quotes)
 * 2. Line ending normalization (CRLF -> LF for matching)
 * 3. Schema validation with better error messages
 */

export default {
  id: "edit-tool-fix",
  async setup(ctx) {
    // Hook into edit tool before execution
    await ctx.tool.hook("execute.before", (event) => {
      if (event.tool !== "edit") return;

      const input = event.input;
      
      // 1. Normalize path
      if (input.filePath) {
        input.filePath = normalizePath(input.filePath);
      }

      // 2. Validate required keys
      const missing = [];
      if (!input.filePath) missing.push("filePath");
      if (input.oldString === undefined) missing.push("oldString");
      if (input.newString === undefined) missing.push("newString");
      
      if (missing.length > 0) {
        event.input = { ...input, _editFixError: `Missing required keys: ${missing.join(", ")}` };
        return;
      }

      // 3. Store normalized versions for reference
      if (input.oldString) {
        input._editFixNormalizedOld = normalizeLineEndings(input.oldString);
      }
      if (input.newString) {
        input._editFixNormalizedNew = normalizeLineEndings(input.newString);
      }

      // 4. Normalize line endings in oldString for better matching
      if (input.oldString && input._editFixNormalizedOld !== input.oldString) {
        input.oldString = input._editFixNormalizedOld;
      }
    });

    // Also handle edit-ops tool (batch edits)
    await ctx.tool.hook("execute.before", (event) => {
      if (event.tool !== "edit-ops") return;

      const input = event.input;
      if (!input.ops) return;

      try {
        const ops = typeof input.ops === 'string' ? JSON.parse(input.ops) : input.ops;
        let modified = false;

        // Normalize all paths and line endings in ops
        for (const op of (Array.isArray(ops) ? ops : [])) {
          if (op.path) {
            const normalized = normalizePath(op.path);
            if (normalized !== op.path) {
              op.path = normalized;
              modified = true;
            }
          }
          // Normalize line endings in replace ops
          if (op.oldString) {
            const normalized = normalizeLineEndings(op.oldString);
            if (normalized !== op.oldString) {
              op.oldString = normalized;
              modified = true;
            }
          }
        }

        if (modified) {
          event.input = { ...input, ops: typeof input.ops === 'string' ? JSON.stringify(ops) : ops };
        }
      } catch (e) {
        // Invalid JSON, let it fail naturally
      }
    });

    console.log("[edit-tool-fix] Plugin loaded successfully");
  },
};

/**
 * Normalize file path:
 * - Fix mixed slashes (convert all to backslashes on Windows)
 * - Remove trailing quotes
 * - Normalize multiple slashes
 */
function normalizePath(path) {
  if (!path) return path;

  // Remove trailing quotes
  let normalized = path.replace(/["']+\s*$/, "");

  // Normalize slashes (Windows prefers backslashes)
  normalized = normalized.replace(/\//g, "\\");

  // Remove trailing backslash
  normalized = normalized.replace(/\\+$/, "");

  // Normalize multiple backslashes
  normalized = normalized.replace(/\\+/g, "\\");

  return normalized;
}

/**
 * Normalize line endings:
 * - Convert CRLF to LF for consistent matching
 */
function normalizeLineEndings(text) {
  if (!text) return text;
  return text.replace(/\r\n/g, "\n");
}
