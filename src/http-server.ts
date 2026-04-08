#!/usr/bin/env node

/**
 * HTTP Server Entry Point for Docker Deployment
 *
 * Provides Streamable HTTP transport for remote MCP clients.
 * Use src/index.ts for local stdio-based usage.
 *
 * Endpoints:
 *   GET  /health  — liveness probe
 *   POST /mcp     — MCP Streamable HTTP (session-aware)
 */

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  searchDecisions,
  getDecision,
  searchMergers,
  getMerger,
  listSectors,
  getDataFreshness,
} from "./db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = parseInt(process.env["PORT"] ?? "3000", 10);
const SERVER_NAME = "czech-competition-mcp";

let pkgVersion = "0.1.0";
try {
  const pkg = JSON.parse(
    readFileSync(join(__dirname, "..", "package.json"), "utf8"),
  ) as { version: string };
  pkgVersion = pkg.version;
} catch {
  // fallback
}

// --- Tool definitions (shared with index.ts) ---------------------------------

const TOOLS = [
  {
    name: "cz_comp_search_decisions",
    description:
      "Full-text search across UOHS competition enforcement decisions. Covers abuse of dominance, cartel enforcement, public procurement violations, and sector inquiries under Czech competition law (ZOHS). Returns matching decisions with case number, parties, sector, outcome, and summary.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query (e.g., 'dominantní postavení', 'kartel', 'veřejná zakázka')" },
        type: {
          type: "string",
          enum: ["abuse_of_dominance", "cartel", "sector_inquiry", "public_procurement"],
          description: "Filter by case type. Optional.",
        },
        sector: { type: "string", description: "Filter by industry sector (e.g., 'energy', 'telecommunications', 'retail'). Optional." },
        outcome: {
          type: "string",
          enum: ["infringement", "commitment", "no_infringement", "fine"],
          description: "Filter by decision outcome. Optional.",
        },
        limit: { type: "number", description: "Maximum number of results to return. Defaults to 20." },
      },
      required: ["query"],
    },
  },
  {
    name: "cz_comp_get_decision",
    description:
      "Get a specific UOHS competition decision by case number (e.g., 'UOHS-S0001/2024/KD', 'UOHS-R0050/2023/HS').",
    inputSchema: {
      type: "object" as const,
      properties: {
        case_number: { type: "string", description: "UOHS case number" },
      },
      required: ["case_number"],
    },
  },
  {
    name: "cz_comp_search_mergers",
    description:
      "Search UOHS merger control decisions. Returns merger cases with acquiring party, target, sector, turnover thresholds, and clearance outcome.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query (e.g., 'spojení soutěžitelů', 'retail', 'energie')" },
        sector: { type: "string", description: "Filter by industry sector. Optional." },
        outcome: {
          type: "string",
          enum: ["cleared", "cleared_with_conditions", "blocked", "withdrawn"],
          description: "Filter by merger outcome. Optional.",
        },
        limit: { type: "number", description: "Maximum number of results to return. Defaults to 20." },
      },
      required: ["query"],
    },
  },
  {
    name: "cz_comp_get_merger",
    description:
      "Get a specific UOHS merger control decision by case number (e.g., 'UOHS-S0010/2024/KS').",
    inputSchema: {
      type: "object" as const,
      properties: {
        case_number: { type: "string", description: "UOHS merger case number" },
      },
      required: ["case_number"],
    },
  },
  {
    name: "cz_comp_list_sectors",
    description:
      "List all industry sectors with UOHS enforcement activity covered in this MCP, with decision and merger counts.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "cz_comp_about",
    description:
      "Return metadata about this MCP server: version, data source, coverage, and tool list.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "cz_comp_list_sources",
    description:
      "List authoritative data sources used by this MCP server, with provenance metadata (URL, authority, scope, license, update frequency).",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "cz_comp_check_data_freshness",
    description:
      "Check data freshness: returns the latest decision/merger dates and record counts from the database.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
];

// --- Zod schemas -------------------------------------------------------------

const SearchDecisionsArgs = z.object({
  query: z.string().min(1),
  type: z.enum(["abuse_of_dominance", "cartel", "sector_inquiry", "public_procurement"]).optional(),
  sector: z.string().optional(),
  outcome: z.enum(["infringement", "commitment", "no_infringement", "fine"]).optional(),
  limit: z.number().int().positive().max(100).optional(),
});

const GetDecisionArgs = z.object({
  case_number: z.string().min(1),
});

const SearchMergersArgs = z.object({
  query: z.string().min(1),
  sector: z.string().optional(),
  outcome: z.enum(["cleared", "cleared_with_conditions", "blocked", "withdrawn"]).optional(),
  limit: z.number().int().positive().max(100).optional(),
});

const GetMergerArgs = z.object({
  case_number: z.string().min(1),
});

// --- Sources metadata --------------------------------------------------------

const SOURCES = [
  {
    id: "uohs-decisions",
    name: "UOHS Enforcement Decisions",
    authority: "Úřad pro ochranu hospodářské soutěže (UOHS)",
    url: "https://www.uohs.cz/cs/hospodarska-soutez/spravni-rozhodnuti.html",
    scope: "Abuse of dominance, cartel, public procurement, and sector inquiry decisions under ZOHS",
    license: "Public domain (official government publication)",
    update_frequency: "Periodic ingestion from UOHS website",
  },
  {
    id: "uohs-mergers",
    name: "UOHS Merger Control Decisions",
    authority: "Úřad pro ochranu hospodářské soutěže (UOHS)",
    url: "https://www.uohs.cz/cs/hospodarska-soutez/spojovani-soutezitelu.html",
    scope: "Merger control decisions under ZOHS §12-19",
    license: "Public domain (official government publication)",
    update_frequency: "Periodic ingestion from UOHS website",
  },
];

// --- MCP server factory ------------------------------------------------------

function createMcpServer(): Server {
  const server = new Server(
    { name: SERVER_NAME, version: pkgVersion },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    function textContent(data: unknown) {
      return {
        _meta: {
          server: SERVER_NAME,
          version: pkgVersion,
          generated_at: new Date().toISOString(),
        },
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }

    function errorContent(message: string) {
      return {
        content: [{ type: "text" as const, text: message }],
        isError: true as const,
      };
    }

    try {
      switch (name) {
        case "cz_comp_search_decisions": {
          const parsed = SearchDecisionsArgs.parse(args);
          const results = searchDecisions({
            query: parsed.query,
            type: parsed.type,
            sector: parsed.sector,
            outcome: parsed.outcome,
            limit: parsed.limit,
          });
          return textContent({ results, count: results.length });
        }

        case "cz_comp_get_decision": {
          const parsed = GetDecisionArgs.parse(args);
          const decision = getDecision(parsed.case_number);
          if (!decision) {
            return errorContent(`Decision not found: ${parsed.case_number}`);
          }
          return textContent(decision);
        }

        case "cz_comp_search_mergers": {
          const parsed = SearchMergersArgs.parse(args);
          const results = searchMergers({
            query: parsed.query,
            sector: parsed.sector,
            outcome: parsed.outcome,
            limit: parsed.limit,
          });
          return textContent({ results, count: results.length });
        }

        case "cz_comp_get_merger": {
          const parsed = GetMergerArgs.parse(args);
          const merger = getMerger(parsed.case_number);
          if (!merger) {
            return errorContent(`Merger case not found: ${parsed.case_number}`);
          }
          return textContent(merger);
        }

        case "cz_comp_list_sectors": {
          const sectors = listSectors();
          return textContent({ sectors, count: sectors.length });
        }

        case "cz_comp_about": {
          return textContent({
            name: SERVER_NAME,
            version: pkgVersion,
            description:
              "UOHS (Úřad pro ochranu hospodářské soutěže — Czech Office for the Protection of Competition) MCP server. Provides access to competition enforcement decisions, merger control cases, public procurement oversight, and sector inquiries under Czech competition law (ZOHS).",
            data_source: "UOHS (https://www.uohs.cz/)",
            coverage: {
              decisions: "UOHS abuse of dominance, cartel, public procurement, and sector inquiry decisions",
              mergers: "UOHS merger control decisions (Fusionskontrolle) under ZOHS",
              sectors: "Sectors with UOHS enforcement activity",
            },
            tools: TOOLS.map((t) => ({ name: t.name, description: t.description })),
          });
        }

        case "cz_comp_list_sources": {
          return textContent({ sources: SOURCES, count: SOURCES.length });
        }

        case "cz_comp_check_data_freshness": {
          const freshness = getDataFreshness();
          return textContent(freshness);
        }

        default:
          return errorContent(`Unknown tool: ${name}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return errorContent(`Error executing ${name}: ${message}`);
    }
  });

  return server;
}

// --- HTTP server -------------------------------------------------------------

async function main(): Promise<void> {
  const sessions = new Map<
    string,
    { transport: StreamableHTTPServerTransport; server: Server }
  >();

  const httpServer = createServer((req, res) => {
    handleRequest(req, res, sessions).catch((err) => {
      console.error(`[${SERVER_NAME}] Unhandled error:`, err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    });
  });

  async function handleRequest(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
    activeSessions: Map<
      string,
      { transport: StreamableHTTPServerTransport; server: Server }
    >,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", server: SERVER_NAME, version: pkgVersion }));
      return;
    }

    if (url.pathname === "/mcp") {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      if (sessionId && activeSessions.has(sessionId)) {
        const session = activeSessions.get(sessionId)!;
        await session.transport.handleRequest(req, res);
        return;
      }

      const mcpServer = createMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK type mismatch with exactOptionalPropertyTypes
      await mcpServer.connect(transport as any);

      transport.onclose = () => {
        if (transport.sessionId) {
          activeSessions.delete(transport.sessionId);
        }
        mcpServer.close().catch(() => {});
      };

      await transport.handleRequest(req, res);

      if (transport.sessionId) {
        activeSessions.set(transport.sessionId, { transport, server: mcpServer });
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }

  httpServer.listen(PORT, () => {
    console.error(`${SERVER_NAME} v${pkgVersion} (HTTP) listening on port ${PORT}`);
    console.error(`MCP endpoint:  http://localhost:${PORT}/mcp`);
    console.error(`Health check:  http://localhost:${PORT}/health`);
  });

  process.on("SIGTERM", () => {
    console.error("Received SIGTERM, shutting down...");
    httpServer.close(() => process.exit(0));
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
