#!/usr/bin/env node

/**
 * Czech Competition MCP — stdio entry point.
 *
 * Provides MCP tools for querying UOHS (Úřad pro ochranu hospodářské soutěže —
 * Czech Office for the Protection of Competition) decisions, merger control
 * cases, and sector enforcement activity under Czech competition law (ZOHS).
 *
 * Tool prefix: cz_comp_
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  searchDecisions,
  getDecision,
  searchMergers,
  getMerger,
  listSectors,
} from "./db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let pkgVersion = "0.1.0";
try {
  const pkg = JSON.parse(
    readFileSync(join(__dirname, "..", "package.json"), "utf8"),
  ) as { version: string };
  pkgVersion = pkg.version;
} catch {
  // fallback to default
}

const SERVER_NAME = "czech-competition-mcp";

// --- Tool definitions ---------------------------------------------------------

const TOOLS = [
  {
    name: "cz_comp_search_decisions",
    description:
      "Full-text search across UOHS competition enforcement decisions. Covers abuse of dominance, cartel enforcement, public procurement violations, and sector inquiries under Czech competition law (ZOHS). Returns matching decisions with case number, parties, sector, outcome, and summary.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search query (e.g., 'dominantní postavení', 'kartel', 'veřejná zakázka')",
        },
        type: {
          type: "string",
          enum: ["abuse_of_dominance", "cartel", "sector_inquiry", "public_procurement"],
          description: "Filter by case type. Optional.",
        },
        sector: {
          type: "string",
          description: "Filter by industry sector (e.g., 'energy', 'telecommunications', 'retail'). Optional.",
        },
        outcome: {
          type: "string",
          enum: ["infringement", "commitment", "no_infringement", "fine"],
          description: "Filter by decision outcome. Optional.",
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return. Defaults to 20.",
        },
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
        case_number: {
          type: "string",
          description: "UOHS case number",
        },
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
        query: {
          type: "string",
          description: "Search query (e.g., 'spojení soutěžitelů', 'retail', 'energie')",
        },
        sector: {
          type: "string",
          description: "Filter by industry sector. Optional.",
        },
        outcome: {
          type: "string",
          enum: ["cleared", "cleared_with_conditions", "blocked", "withdrawn"],
          description: "Filter by merger outcome. Optional.",
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return. Defaults to 20.",
        },
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
        case_number: {
          type: "string",
          description: "UOHS merger case number",
        },
      },
      required: ["case_number"],
    },
  },
  {
    name: "cz_comp_list_sectors",
    description:
      "List all industry sectors with UOHS enforcement activity covered in this MCP, with decision and merger counts.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "cz_comp_about",
    description: "Return metadata about this MCP server: version, data source, coverage, and tool list.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
];

// --- Zod schemas for argument validation --------------------------------------

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

// --- Helper ------------------------------------------------------------------

function textContent(data: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(data, null, 2) },
    ],
  };
}

function errorContent(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true as const,
  };
}

// --- Server setup ------------------------------------------------------------

const server = new Server(
  { name: SERVER_NAME, version: pkgVersion },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

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
          return errorContent(`Merger decision not found: ${parsed.case_number}`);
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

      default:
        return errorContent(`Unknown tool: ${name}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorContent(`Error executing ${name}: ${message}`);
  }
});

// --- Main --------------------------------------------------------------------

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`${SERVER_NAME} v${pkgVersion} running on stdio\n`);
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
