import { navGroups, searchBundle } from "@lorsabyan/okf-core";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getBundle, signalsFor, summarize } from "../services/bundles.js";
import { ResponseFormat, conceptLine, fail, ok, render, signalLine } from "../services/format.js";

const bundlePath = z
  .string()
  .min(1)
  .describe("Path to the OKF bundle directory (a folder of .md files). Absolute paths are safest.");

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

export function registerBrowseTools(server: McpServer): void {
  server.registerTool(
    "okf_open_bundle",
    {
      title: "Open an OKF bundle",
      description: `Open an Open Knowledge Format bundle and describe what is in it. Start here.

An OKF bundle is a directory of markdown files with YAML frontmatter, each describing one concept — a dataset, table, metric, API, playbook, policy, or attested computation.

Args:
  - bundle_path (string): directory containing the bundle
  - response_format ('markdown' | 'json'): default 'markdown'

Returns:
  {
    "name": string,                  // bundle directory name
    "concept_count": number,
    "types": { [type: string]: number },   // concept count per OKF type
    "groups": [{ "group": string, "count": number }],  // top-level directories
    "health_summary": {
      "broken_links": number, "missing_descriptions": number, "untyped": number,
      "stale": number, "aging": number, "undated": number,
      "unverified": number, "deprecated": number, "orphans": number
    }
  }

Examples:
  - Use when: "What's in the bundle at ./knowledge?" -> bundle_path="./knowledge"
  - Use when: you need the type names before filtering okf_list_concepts
  - Don't use when: you already know the concept id (use okf_get_concept)

Error Handling:
  - Returns a message naming the path if the directory does not exist
  - Returns a message explaining what a bundle is if the directory holds no concept docs`,
      inputSchema: { bundle_path: bundlePath, response_format: responseFormat },
      annotations: READ_ONLY,
    },
    async ({ bundle_path, response_format }) => {
      try {
        const bundle = getBundle(bundle_path);
        const { healthOf } = await import("../services/bundles.js");
        const health = healthOf(bundle);

        const types: Record<string, number> = {};
        for (const c of bundle.concepts) types[c.type] = (types[c.type] ?? 0) + 1;
        const groups = navGroups(bundle).map((g) => ({ group: g.group, count: g.items.length }));

        const structured = {
          name: bundle.name,
          concept_count: bundle.concepts.length,
          types,
          groups,
          health_summary: {
            broken_links: health.brokenLinks.length,
            missing_descriptions: health.missingDescriptions.length,
            untyped: health.untyped.length,
            stale: health.stale.length,
            aging: health.aging.length,
            undated: health.undated.length,
            unverified: health.unverified.length,
            deprecated: health.deprecated.length,
            orphans: health.orphans.length,
          },
        };

        const md = [
          `# ${bundle.name}`,
          "",
          `${bundle.concepts.length} concepts across ${groups.length} group(s).`,
          "",
          "## Types",
          ...Object.entries(types)
            .sort((a, b) => b[1] - a[1])
            .map(([t, n]) => `- ${t}: ${n}`),
          "",
          "## Groups",
          ...groups.map((g) => `- ${g.group}: ${g.count}`),
          "",
          "## Health",
          `- stale (past stale_after): ${health.stale.length}`,
          `- deprecated: ${health.deprecated.length}`,
          `- unverified: ${health.unverified.length}`,
          `- broken links: ${health.brokenLinks.length}`,
          "",
          "Use `okf_list_concepts` to browse, `okf_search` to find, `okf_get_concept` to read.",
        ].join("\n");

        return render(response_format, md, structured);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "okf_list_concepts",
    {
      title: "List concepts in an OKF bundle",
      description: `List concepts, optionally filtered by type, tag, or lifecycle status.

Returns summaries without bodies, so it is safe to call on a large bundle. Use okf_get_concept to read one in full.

Args:
  - bundle_path (string): directory containing the bundle
  - type (string, optional): exact OKF type, e.g. "Metric", "BigQuery Table", "Attested Computation"
  - tag (string, optional): exact tag
  - status ('draft' | 'stable' | 'deprecated', optional): lifecycle filter (spec §5.4)
  - trust ('unverified' | 'machine-confirmed' | 'human-reviewed', optional): trust tier (spec §5.3)
  - limit (number): 1-200, default 50
  - offset (number): default 0
  - response_format ('markdown' | 'json'): default 'markdown'

Returns:
  {
    "total": number, "count": number, "offset": number, "has_more": boolean,
    "next_offset": number,           // present only when has_more
    "concepts": [{
      "id": string, "title": string, "type": string, "description": string,
      "tags": string[], "resource": string,
      "status": "draft"|"stable"|"deprecated",
      "trust": "unverified"|"machine-confirmed"|"human-reviewed",
      "verified_by": string[], "verified_at": string,
      "updated_at": string, "stale_since": string
    }]
  }

Examples:
  - Use when: "What metrics are defined?" -> type="Metric"
  - Use when: "Which definitions has nobody verified?" -> trust="unverified"
  - Use when: "Show me anything deprecated" -> status="deprecated"

Error Handling:
  - An unmatched type or tag returns an empty list plus the values that do exist`,
      inputSchema: {
        bundle_path: bundlePath,
        type: z.string().optional().describe("Exact OKF type to filter by"),
        tag: z.string().optional().describe("Exact tag to filter by"),
        status: z.enum(["draft", "stable", "deprecated"]).optional().describe("Lifecycle status (§5.4)"),
        trust: z
          .enum(["unverified", "machine-confirmed", "human-reviewed"])
          .optional()
          .describe("Trust tier derived from `verified` (§5.3)"),
        limit: z.number().int().min(1).max(200).default(50).describe("Maximum results"),
        offset: z.number().int().min(0).default(0).describe("Results to skip, for pagination"),
        response_format: responseFormat,
      },
      annotations: READ_ONLY,
    },
    async ({ bundle_path, type, tag, status, trust, limit, offset, response_format }) => {
      try {
        const bundle = getBundle(bundle_path);
        let matches = bundle.concepts.map((c) => summarize(c));

        if (type) matches = matches.filter((c) => c.type === type);
        if (tag) matches = matches.filter((c) => c.tags.includes(tag));
        if (status) matches = matches.filter((c) => c.status === status);
        if (trust) matches = matches.filter((c) => c.trust === trust);

        const total = matches.length;
        const page = matches.slice(offset, offset + limit);
        const hasMore = total > offset + page.length;

        if (total === 0) {
          // An empty result is a dead end unless it says what would have worked.
          const types = [...new Set(bundle.concepts.map((c) => c.type))].sort();
          const tags = [...new Set(bundle.concepts.flatMap((c) => c.tags))].sort();
          return ok(
            `No concepts matched.\n\nAvailable types: ${types.join(", ") || "(none)"}\n` +
              `Available tags: ${tags.slice(0, 40).join(", ") || "(none)"}`,
            { total: 0, count: 0, offset, has_more: false, concepts: [], available_types: types, available_tags: tags },
          );
        }

        const structured = {
          total,
          count: page.length,
          offset,
          has_more: hasMore,
          ...(hasMore ? { next_offset: offset + page.length } : {}),
          concepts: page,
        };

        const md = [
          `# Concepts (${page.length} of ${total})`,
          "",
          ...page.map(conceptLine),
          ...(hasMore ? ["", `_More available — call again with offset=${offset + page.length}._`] : []),
        ].join("\n");

        return render(response_format, md, structured, {
          key: "concepts",
          items: page,
          hint: "Narrow with type/tag/status/trust, or page with offset.",
        });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "okf_get_concept",
    {
      title: "Read one OKF concept",
      description: `Read a single concept in full: its frontmatter, trust and lifecycle signals, provenance, body, and links.

Args:
  - bundle_path (string): directory containing the bundle
  - id (string): concept id — the file path without .md, e.g. "metrics/revenue"
  - include_body (boolean): default true; set false for metadata only
  - response_format ('markdown' | 'json'): default 'markdown'

Returns:
  {
    "id": string, "title": string, "type": string, "description": string,
    "tags": string[], "resource": string,
    "status": ..., "trust": ..., "verified_by": string[], "verified_at": string,
    "updated_at": string, "stale_since": string,
    "generated": { "by": string, "at": string },
    "sources": [{ "id": string, "resource": string, "title": string,
                  "author": string, "lastModified": string, "usageCount": number }],
    "computation": {                 // present only for type "Attested Computation"
      "runtime": string,
      "parameters": [{ "name": string, "type": string, "required": boolean }],
      "path": string,
      "executor": { "resource": string, "receipt": string[] },
      "attester": { "resource": string }
    },
    "links_to": string[], "cited_by": string[],
    "body": string                   // omitted when include_body is false
  }

Trust and freshness are worth checking before relying on a definition: "trust" is
derived from \`verified\` (§5.3) and "stale_since" from \`stale_after\` (§5.5). They are
advisory signals, not access control.

For an Attested Computation, the caller may supply values for the declared
parameters ONLY, and must never author or rewrite the computation itself — that
boundary is the point of the type (§10).

Examples:
  - Use when: "How is revenue defined?" -> id="metrics/revenue"
  - Use when: you need a concept's sources to cite it

Error Handling:
  - An unknown id returns near-miss suggestions from the bundle`,
      inputSchema: {
        bundle_path: bundlePath,
        id: z.string().min(1).describe('Concept id: path without .md, e.g. "metrics/revenue"'),
        include_body: z.boolean().default(true).describe("Include the markdown body"),
        response_format: responseFormat,
      },
      annotations: READ_ONLY,
    },
    async ({ bundle_path, id, include_body, response_format }) => {
      try {
        const bundle = getBundle(bundle_path);
        const concept = bundle.byId.get(id);

        if (!concept) {
          // Suggest instead of just refusing: ids are paths and easy to mistype.
          const needle = id.toLowerCase();
          const near = bundle.concepts
            .filter((c) => c.id.toLowerCase().includes(needle) || c.title.toLowerCase().includes(needle))
            .slice(0, 10)
            .map((c) => c.id);
          return ok(
            `No concept with id '${id}'.` +
              (near.length
                ? `\n\nDid you mean:\n${near.map((n) => `- ${n}`).join("\n")}`
                : `\n\nUse okf_list_concepts or okf_search to find valid ids.`),
            { found: false, id, suggestions: near },
          );
        }

        const structured = {
          ...summarize(concept),
          ...(concept.generated ? { generated: concept.generated } : {}),
          ...(concept.sources.length ? { sources: concept.sources } : {}),
          ...(concept.computation ? { computation: concept.computation } : {}),
          links_to: concept.outLinks,
          cited_by: bundle.backlinks.get(concept.id) ?? [],
          ...(include_body ? { body: concept.body } : {}),
        };

        const md = [
          `# ${concept.title}`,
          "",
          `\`${concept.id}\` · ${concept.type} · ${signalLine(signalsFor(concept))}`,
          ...(concept.description ? ["", concept.description] : []),
          ...(concept.resource ? ["", `Resource: ${concept.resource}`] : []),
          ...(concept.computation
            ? [
                "",
                "## Sanctioned computation",
                `Runtime: ${concept.computation.runtime ?? "(not declared — required for this type, §10.2)"}`,
                ...(concept.computation.parameters.length
                  ? [
                      "Parameters:",
                      ...concept.computation.parameters.map(
                        (p) => `- ${p.name}${p.type ? `: ${p.type}` : ""}${p.required ? " (required)" : ""}`,
                      ),
                    ]
                  : []),
                ...(concept.computation.executor?.receipt.length
                  ? [`Receipt fields: ${concept.computation.executor.receipt.join(", ")}`]
                  : []),
                "",
                "Supply values for the declared parameters only. Do not rewrite the computation.",
              ]
            : []),
          ...(concept.sources.length
            ? [
                "",
                "## Sources",
                ...concept.sources.map(
                  (s) => `- ${s.title ?? s.resource}${s.author ? ` (by ${s.author})` : ""}`,
                ),
              ]
            : []),
          ...(include_body ? ["", "---", "", concept.body] : []),
        ].join("\n");

        return render(response_format, md, structured);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "okf_search",
    {
      title: "Search an OKF bundle",
      description: `Full-text search over a bundle's concepts — titles, ids, types, tags, descriptions, and bodies.

Args:
  - bundle_path (string): directory containing the bundle
  - query (string): search text, 1-200 characters
  - limit (number): 1-50, default 10
  - response_format ('markdown' | 'json'): default 'markdown'

Returns:
  {
    "query": string, "count": number,
    "results": [{
      "id": string, "title": string, "type": string, "description": string,
      "tags": string[], "status": ..., "trust": ..., "updated_at": string, "stale_since": string
    }]
  }

Examples:
  - Use when: "Where is churn defined?" -> query="churn"
  - Use when: you do not know the concept id
  - Don't use when: you have the exact id (use okf_get_concept, it is cheaper)

Error Handling:
  - No matches returns the available types and tags to redirect the search`,
      inputSchema: {
        bundle_path: bundlePath,
        query: z.string().min(1).max(200).describe("Search text"),
        limit: z.number().int().min(1).max(50).default(10).describe("Maximum results"),
        response_format: responseFormat,
      },
      annotations: READ_ONLY,
    },
    async ({ bundle_path, query, limit, response_format }) => {
      try {
        const bundle = getBundle(bundle_path);
        const hits = searchBundle(bundle, query, limit);

        if (hits.length === 0) {
          const types = [...new Set(bundle.concepts.map((c) => c.type))].sort();
          return ok(
            `No concepts matched '${query}'.\n\nThe bundle has ${bundle.concepts.length} concepts ` +
              `of these types: ${types.join(", ")}.\nTry a broader term, or browse with okf_list_concepts.`,
            { query, count: 0, results: [], available_types: types },
          );
        }

        const results = hits
          .map((h) => bundle.byId.get(h.id))
          .filter((c): c is NonNullable<typeof c> => Boolean(c))
          .map((c) => summarize(c));

        const structured = { query, count: results.length, results };
        const md = [`# Search: '${query}'`, "", `${results.length} match(es).`, "", ...results.map(conceptLine)].join("\n");

        return render(response_format, md, structured, {
          key: "results",
          items: results,
          hint: "Use a narrower query or a smaller limit.",
        });
      } catch (error) {
        return fail(error);
      }
    },
  );
}
