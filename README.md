# okf-mcp-server

An [MCP](https://modelcontextprotocol.io) server that exposes
[Open Knowledge Format](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/3fcbb9f/okf/SPEC.md)
(OKF) bundles to agents — browse, search, read concepts, and audit trust and freshness.

An OKF bundle is a directory of markdown files with YAML frontmatter, each describing one
concept: a dataset, table, metric, API, playbook, policy, or attested computation. This server
lets an agent use one without being taught the format.

Built on [`@lorsabyan/okf-core`](https://www.npmjs.com/package/@lorsabyan/okf-core).

## Is this the one you want?

**If you use Claude Code or Codex, probably not — use the
[OKF skill](https://github.com/lorsabyan/okf-skill) instead.**

| Your agent | Use | Why |
|---|---|---|
| **Cursor, Windsurf, Zed, other MCP clients** | **this server** | No skill support, so the format arrives as tools. |
| **An agent with no filesystem access** | **this server** | The skill needs to read files and run scripts; this works over a protocol. |
| **Claude Code, Codex** | [the skill](https://github.com/lorsabyan/okf-skill) | Skills load automatically and carry the format itself, so the agent reads bundles with the file tools it already has. |

That last row is measured rather than assumed. With the skill installed, a real
Claude Code session answered a bundle question using the skill plus `Read` and
`Bash`, making **zero** calls to this server. The skill triggers on any mention of
OKF and prescribes a complete procedure, while MCP tools cost a `ToolSearch`
round-trip before the first call. In that environment this server can only add
latency, never capability — so installing both is worse than installing either.

Where there is no skill, the calculus inverts: this is the only thing that
teaches the agent the format.

## Install

In your MCP client's config:

```json
{
  "mcpServers": {
    "okf": { "command": "npx", "args": ["-y", "okf-mcp-server"] }
  }
}
```

For Claude Code — worth repeating that the [skill](https://github.com/lorsabyan/okf-skill) is the
better fit there, so this is mainly for testing the server itself:

```sh
claude mcp add okf -- npx -y okf-mcp-server
claude mcp remove okf            # when you are done
```

Transport is **stdio** — bundles are read from the local filesystem, so this is a local
integration with nothing to authenticate.

## Tools

Every tool takes `bundle_path`, so **no tool has to be called before another**. There is no
"active bundle" to set up and no ordering to get wrong.

| Tool | Purpose |
|---|---|
| `okf_open_bundle` | What is in this bundle — concept count, types, groups, health summary. Start here. |
| `okf_list_concepts` | Browse, filtered by `type`, `tag`, `status`, or `trust`. Paginated. |
| `okf_get_concept` | Read one concept in full: frontmatter, provenance, computation contract, body, links. |
| `okf_search` | Full-text search across titles, ids, types, tags, descriptions, and bodies. |
| `okf_health_report` | Broken links, staleness, unverified and deprecated content, orphans. |
| `okf_validate` | Conformance against OKF v0.2 (spec §11). |
| `okf_reload_bundle` | Drop the cache after editing files on disk. |

All are read-only. `okf_reload_bundle` only clears an in-process cache; nothing here writes.

Each returns both human-readable markdown and `structuredContent`, selectable with
`response_format`.

## What it surfaces that a plain file read does not

OKF v0.2 records whether a definition can be trusted, and this server puts those signals in
front of the agent rather than leaving them buried in frontmatter:

- **Trust tier** (§5.3) — derived from `verified`: *unverified*, *machine-confirmed*, or
  *human-reviewed*.
- **Staleness** (§5.5) — whether a concept is past its author-chosen `stale_after`. Reported
  separately from *aging* (not updated in a year), because they are different claims: a concept
  can be two years old and deliberately current, or a week old and expired.
- **Lifecycle status** (§5.4) — `deprecated` content stays readable but is flagged.
- **Provenance** (§5.1) — the `sources` a concept derives from, with author and last-modified.
- **Attested Computations** (§10) — the sanctioned `runtime`, `parameters`, receipt fields,
  executor, and attester. The tool description states the rule the type exists to enforce: a
  caller may supply values for declared parameters and must **never** rewrite the computation.

`okf_health_report` accepts `as_of` so staleness questions have reproducible answers.

## Try it

Against any OKF bundle:

```sh
git clone https://github.com/GoogleCloudPlatform/knowledge-catalog /tmp/kc
git -C /tmp/kc checkout 3fcbb9f
```

Then ask an agent something like *"Open the bundle at /tmp/kc/okf/bundles/acme_retail — which
metric is deprecated, and what replaced it?"*

## Development

```sh
npm install
npm run build
npm test            # builds, then runs node --test over dist
npm start           # speaks MCP on stdin/stdout
node dist/index.js --help
```

Inspect it interactively:

```sh
npx @modelcontextprotocol/inspector node dist/index.js
```

## Evaluation

[`evaluation.xml`](evaluation.xml) holds ten questions over the upstream Acme Retail reference
bundle, each needing several tool calls. Every answer was verified by driving this server over
stdio, and the questions that involve staleness name an explicit `as_of` so the clock cannot
change the answer.

## License

Apache-2.0.
