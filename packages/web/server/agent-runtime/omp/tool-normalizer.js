/**
 * OMP tool normalizer — standardizes OMP tool calls into a shape the UI can
 * render, and describes which tools have native renderers vs generic cards.
 *
 * This is the tool-side sibling of the ToolRendererRegistry in the UI: the
 * server tells the UI which rendering tier applies (native / generic), and
 * unknown tools always degrade to a generic card instead of breaking.
 */

/** Tools with first-class native UI renderers (OMP_MIGRATION_MAP §12). */
export const NATIVE_TOOL_RENDERERS = new Set([
  'read',
  'write',
  'edit',
  'bash',
  'grep',
  'glob',
  'ask',
  'todo',
  'task',
]);

/** Tools that are P0 for the first phase. */
export const P0_TOOLS = ['read', 'write', 'edit', 'bash', 'grep', 'glob', 'ask', 'todo', 'task'];

/** P1 tools (post-P0). */
export const P1_TOOLS = [
  'browser',
  'web_search',
  'github',
  'lsp',
  'debug',
  'eval',
  'inspect_image',
  'hub',
  'checkpoint',
  'rewind',
  'recall',
  'retain',
  'reflect',
];

export const getToolRenderTier = (toolName) =>
  NATIVE_TOOL_RENDERERS.has(toolName) ? 'native' : 'generic';

/**
 * Summarize a tool result for display in a generic card.
 */
export const summarizeToolResult = (result, toolName) => {
  if (result == null) return undefined;
  if (typeof result === 'string') return result.slice(0, 4000);
  if (typeof result === 'object') {
    try {
      const json = JSON.stringify(result);
      return json.length > 4000 ? `${json.slice(0, 4000)}…` : json;
    } catch {
      return String(result);
    }
  }
  return String(result).slice(0, 4000);
};
