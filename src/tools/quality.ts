import { validateBundle } from "@lorsabyan/okf-core/validate";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { clearCache, getBundle, healthOf } from "../services/bundles.js";
import { ResponseFormat, fail, ok, render } from "../services/format.js";

const bundlePath = z.string().min(1).describe("Path to the OKF bundle directory");
const responseFormat = z
  .nativeEnum(ResponseFormat)
  .default(ResponseFormat.MARKDOWN)
  .describe("'markdown' for reading, 'json' for machine processing");

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export function registerQualityTools(server: McpServer): void {
  server.registerTool(
    "okf_health_report",
    {
      title: "Report an OKF bundle's health",
      description: `Analyze a bundle for documentation-health problems: broken links, missing descriptions, untyped concepts, staleness, unverified and deprecated content, and orphans.

Two distinct notions of "old" are reported separately, and conflating them is the
mistake this guards against:
  - "stale" means past the author's own \`stale_after\` date (spec §5.5) — an explicit expiry.
  - "aging" means not updated in over a year — a heuristic, not part of the spec.
A concept can be two years old and deliberately current, or a week old and expired.

Args:
  - bundle_path (string): directory containing the bundle
  - as_of (string, optional): ISO date (YYYY-MM-DD) to evaluate staleness against, instead of today
  - response_format ('markdown' | 'json'): default 'markdown'

Returns:
  {
    "as_of": string,
    "broken_links": [{ "from": string, "target": string }],
    "missing_descriptions": string[], "untyped": string[],
    "stale": [{ "id": string, "stale_since": string }],
    "aging": [{ "id": string, "updated_at": string }],
    "undated": string[], "unverified": string[], "deprecated": string[], "orphans": string[]
  }

Examples:
  - Use when: "Is anything in this catalog out of date?"
  - Use when: "What still needs human review?" -> read "unverified"
  - Use when: auditing before relying on a bundle

Error Handling:
  - An invalid as_of returns a message naming the expected YYYY-MM-DD format`,
      inputSchema: {
        bundle_path: bundlePath,
        as_of: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, "as_of must be YYYY-MM-DD")
          .optional()
          .describe("Evaluate staleness as of this date instead of today"),
        response_format: responseFormat,
      },
      annotations: READ_ONLY,
    },
    async ({ bundle_path, as_of, response_format }) => {
      try {
        const bundle = getBundle(bundle_path);
        const now = as_of ? new Date(`${as_of}T00:00:00Z`) : new Date();
        if (Number.isNaN(now.getTime())) {
          return ok(`Error: '${as_of}' is not a valid date. Use YYYY-MM-DD.`, { error: "invalid_as_of" });
        }
        const h = healthOf(bundle, now);

        const structured = {
          as_of: now.toISOString().slice(0, 10),
          broken_links: h.brokenLinks.map((b) => ({ from: b.fromId, target: b.target })),
          missing_descriptions: h.missingDescriptions,
          untyped: h.untyped,
          stale: h.stale.map((s) => ({ id: s.id, stale_since: s.staleSince })),
          aging: h.aging.map((a) => ({ id: a.id, updated_at: a.updatedAt })),
          undated: h.undated,
          unverified: h.unverified,
          deprecated: h.deprecated,
          orphans: h.orphans,
        };

        const section = (title: string, items: string[]) =>
          items.length ? [`## ${title} (${items.length})`, ...items.map((i) => `- ${i}`), ""] : [];

        const md = [
          `# Health — ${bundle.name}`,
          "",
          `${bundle.concepts.length} concepts, evaluated as of ${structured.as_of}.`,
          "",
          ...section(
            "Stale (past stale_after)",
            structured.stale.map((s) => `${s.id} — since ${s.stale_since}`),
          ),
          ...section("Deprecated", h.deprecated),
          ...section(
            "Broken links",
            structured.broken_links.map((b) => `${b.from} → ${b.target}`),
          ),
          ...section("Unverified", h.unverified),
          ...section(
            "Aging (not updated in over a year)",
            structured.aging.map((a) => `${a.id} — ${a.updated_at.slice(0, 10)}`),
          ),
          ...section("Missing descriptions", h.missingDescriptions),
          ...section("Untyped", h.untyped),
          ...section("Undated", h.undated),
          ...section("Orphans", h.orphans),
        ].join("\n");

        return render(response_format, md.trim(), structured);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "okf_validate",
    {
      title: "Validate an OKF bundle for conformance",
      description: `Check a bundle against the OKF v0.2 specification.

Errors are the three conformance rules of spec §11: every non-reserved .md file has a parseable YAML frontmatter block, every block has a non-empty \`type\`, and reserved files (index.md, log.md) follow their structure.

Warnings are soft guidance the spec says consumers MUST tolerate — broken links, missing optional fields, unknown types. A bundle with warnings is still conformant, and §11 explicitly forbids rejecting a bundle for them.

Args:
  - bundle_path (string): directory containing the bundle
  - response_format ('markdown' | 'json'): default 'markdown'

Returns:
  {
    "conformant": boolean,           // true when there are zero errors
    "checked_version": string,       // OKF version validated against
    "declared_version": string,      // okf_version from the root index.md, when declared (§12)
    "concept_count": number,
    "error_count": number, "warning_count": number,
    "errors": string[], "warnings": string[]
  }

Examples:
  - Use when: "Is this bundle valid OKF?"
  - Use when: authoring a bundle and checking work before publishing
  - Don't use when: you want quality signals rather than conformance (use okf_health_report)

Error Handling:
  - A missing or non-directory path returns a message naming it`,
      inputSchema: { bundle_path: bundlePath, response_format: responseFormat },
      annotations: READ_ONLY,
    },
    async ({ bundle_path, response_format }) => {
      try {
        // Confirms the directory exists and is a bundle, with a useful message if not.
        getBundle(bundle_path);
        const { bundle, errors, warnings, declaredVersion } = validateBundle(bundle_path);
        const { CHECKED_VERSION } = await import("@lorsabyan/okf-core/validate");

        const structured = {
          conformant: errors.length === 0,
          checked_version: CHECKED_VERSION,
          ...(declaredVersion ? { declared_version: declaredVersion } : {}),
          concept_count: bundle.concepts.length,
          error_count: errors.length,
          warning_count: warnings.length,
          errors,
          warnings,
        };

        const md = [
          `# Validation — ${bundle.name}`,
          "",
          `${bundle.concepts.length} concepts · ${errors.length} error(s) · ${warnings.length} warning(s)`,
          "",
          ...(errors.length ? ["## Errors", ...errors.map((e) => `- ${e}`), ""] : []),
          ...(warnings.length ? ["## Warnings", ...warnings.map((w) => `- ${w}`), ""] : []),
          errors.length === 0
            ? `Conformant with OKF v${CHECKED_VERSION}.`
            : `Not conformant: fix the errors above. Warnings are advisory and do not affect conformance.`,
        ].join("\n");

        return render(response_format, md, structured, {
          key: "warnings",
          items: warnings,
          hint: "Read the full list with response_format='json'.",
        });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "okf_reload_bundle",
    {
      title: "Reload a bundle from disk",
      description: `Drop the cached copy of a bundle so the next call re-reads it from disk.

Bundles are cached per path for speed. Call this after editing files, otherwise subsequent tools keep answering from the version loaded earlier.

Args:
  - bundle_path (string, optional): bundle to drop; omit to drop every cached bundle

Returns:
  { "cleared": number }              // how many cached bundles were dropped

Examples:
  - Use when: you have just written to a bundle and want fresh results
  - Don't use when: you have only been reading (the cache is already correct)`,
      inputSchema: {
        bundle_path: z.string().min(1).optional().describe("Bundle to drop; omit for all"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ bundle_path }) => {
      const cleared = clearCache(bundle_path);
      return ok(
        cleared === 0
          ? "Nothing was cached; the next call will read from disk anyway."
          : `Cleared ${cleared} cached bundle(s). The next call re-reads from disk.`,
        { cleared },
      );
    },
  );
}
