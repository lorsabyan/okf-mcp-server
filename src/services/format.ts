import { BundleError, type ConceptSignals, type ConceptSummary } from "./bundles.js";

/** Responses beyond this are truncated with an explicit note rather than silently. */
export const CHARACTER_LIMIT = 25_000;

export enum ResponseFormat {
  MARKDOWN = "markdown",
  JSON = "json",
}

export interface ToolResult {
  // The SDK's handler return type carries an index signature; without it here,
  // every registerTool call fails to typecheck on the result shape.
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export function ok(text: string, structured?: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text }],
    ...(structured ? { structuredContent: structured } : {}),
  };
}

/**
 * Turn a thrown value into an agent-readable failure.
 *
 * `BundleError` messages are written for an agent to act on, so they pass
 * through verbatim. Anything else is unexpected and gets a generic prefix rather
 * than leaking a stack trace into the conversation.
 */
export function fail(error: unknown): ToolResult {
  const message =
    error instanceof BundleError
      ? error.message
      : `Unexpected error: ${error instanceof Error ? error.message : String(error)}`;
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

/** Render trust/lifecycle signals as one compact line, the same way everywhere. */
export function signalLine(s: ConceptSignals): string {
  const parts: string[] = [s.trust];
  if (s.status !== "stable") parts.push(s.status);
  if (s.stale_since) parts.push(`STALE since ${s.stale_since}`);
  if (s.updated_at) parts.push(`updated ${s.updated_at.slice(0, 10)}`);
  return parts.join(" · ");
}

export function conceptLine(c: ConceptSummary): string {
  const desc = c.description ? ` — ${c.description}` : "";
  return `- **${c.title}** (\`${c.id}\`) · ${c.type}${desc}\n  ${signalLine(c)}`;
}

/**
 * Emit a result in the requested format, truncating over the character limit.
 *
 * Truncation drops list items rather than cutting mid-string, so the JSON a
 * client parses is still valid, and says how many were dropped and how to get
 * the rest. A silently shortened answer is worse than a short one.
 */
export function render(
  format: ResponseFormat,
  markdown: string,
  structured: Record<string, unknown>,
  truncatable?: { key: string; items: unknown[]; hint: string },
): ToolResult {
  let text = format === ResponseFormat.JSON ? JSON.stringify(structured, null, 2) : markdown;

  if (text.length > CHARACTER_LIMIT && truncatable) {
    const keep = Math.max(1, Math.floor(truncatable.items.length / 2));
    const trimmed = {
      ...structured,
      [truncatable.key]: truncatable.items.slice(0, keep),
      truncated: true,
      truncation_message:
        `Response truncated from ${truncatable.items.length} to ${keep} items. ${truncatable.hint}`,
    };
    text =
      format === ResponseFormat.JSON
        ? JSON.stringify(trimmed, null, 2)
        : `${markdown.slice(0, CHARACTER_LIMIT)}\n\n_Truncated. ${truncatable.hint}_`;
    return ok(text, trimmed);
  }

  return ok(text, structured);
}
