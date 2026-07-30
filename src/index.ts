#!/usr/bin/env node
/**
 * MCP server for Open Knowledge Format (OKF) bundles.
 *
 * Exposes a directory of OKF markdown as tools an agent can browse, search,
 * read, and audit — including the v0.2 trust, provenance, and lifecycle signals
 * that tell a reader whether a definition can be relied on.
 *
 * Transport is stdio: bundles are read from the local filesystem, so this is a
 * local integration rather than a network service. There is nothing to
 * authenticate.
 *
 * Every tool is read-only. The one exception, `okf_reload_bundle`, only drops an
 * in-process cache — it never writes to disk.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { pathToFileURL } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerBrowseTools } from "./tools/browse.js";
import { registerQualityTools } from "./tools/quality.js";

export const SERVER_NAME = "okf-mcp-server";
export const SERVER_VERSION = "0.1.0";

export function createServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerBrowseTools(server);
  registerQualityTools(server);
  return server;
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    // stdout is the MCP channel, so help goes to stderr like every other message.
    process.stderr.write(
      `${SERVER_NAME} ${SERVER_VERSION}\n\n` +
        `An MCP server exposing Open Knowledge Format bundles over stdio.\n\n` +
        `Tools: okf_open_bundle, okf_list_concepts, okf_get_concept, okf_search,\n` +
        `       okf_health_report, okf_validate, okf_reload_bundle\n\n` +
        `Every tool takes a bundle_path, so no tool has to be called before another.\n\n` +
        `Claude Code:  claude mcp add okf -- npx -y okf-mcp-server\n` +
        `Manually:     node dist/index.js   (speaks MCP on stdin/stdout)\n`,
    );
    return;
  }

  const server = createServer();
  await server.connect(new StdioServerTransport());
  process.stderr.write(`${SERVER_NAME} ${SERVER_VERSION} running on stdio\n`);
}

/**
 * Only start when run as a program, never on import.
 *
 * Without this guard, importing anything from this module — `createServer` for a
 * test, or embedding the server in another host — connects a stdio transport as
 * a side effect and the process never exits. Node's test runner hits exactly
 * that when it walks the build output.
 */
const executedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (executedDirectly) {
  main().catch((error: unknown) => {
    process.stderr.write(`Fatal: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
