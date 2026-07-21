#!/usr/bin/env node
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import Database from "better-sqlite3";
import { z } from "zod";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

if (process.platform !== "darwin") {
  console.error(
    "things3-mcp only works on macOS — Things 3 is a macOS-only app."
  );
  process.exit(1);
}

const AUTH_TOKEN = process.env.THINGS_AUTH_TOKEN;

const DB_PATH = path.join(
  homedir(),
  "Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/Things Database.thingsdatabase/main.sqlite"
);

// ---------------------------------------------------------------------------
// Things URL scheme (write operations)
// ---------------------------------------------------------------------------

class ThingsError extends Error {}

function buildThingsUrl(action: string, params: Record<string, unknown>): string {
  const pairs: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    pairs.push(`${key}=${encodeURIComponent(String(value))}`);
  }
  return `things:///${action}${pairs.length ? "?" + pairs.join("&") : ""}`;
}

async function openThingsUrl(url: string): Promise<void> {
  try {
    await execFileAsync("open", ["-g", url]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ThingsError(`Failed to open Things URL: ${msg}`);
  }
}

function requireAuthToken(): string {
  if (!AUTH_TOKEN) {
    throw new ThingsError(
      "THINGS_AUTH_TOKEN environment variable is required for update operations. " +
        "Get it from Things → Settings → General → Enable Things URLs."
    );
  }
  return AUTH_TOKEN;
}

function toolResult(data: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [
      {
        type: "text",
        text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
      },
    ],
  };
}

function errorResult(err: unknown): { content: Array<{ type: "text"; text: string }> } {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: `Error: ${message}` }] };
}

// ---------------------------------------------------------------------------
// Things date encoding
// ---------------------------------------------------------------------------
// Things packs startDate/deadline into a single integer as
// (year << 16) | (month << 12) | (day << 7), which conveniently also sorts
// correctly as a plain integer.

function encodeThingsDate(date: Date): number {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  return (year << 16) | (month << 12) | (day << 7);
}

function decodeThingsDate(value: number | null): string | null {
  if (value === null) return null;
  const year = value >> 16;
  const month = (value >> 12) & 0xf;
  const day = (value >> 7) & 0x1f;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// Core Data timestamps are seconds since 2001-01-01, not the Unix epoch.
const CORE_DATA_EPOCH_OFFSET = 978307200;

function decodeCoreDataDate(value: number | null): string | null {
  if (value === null) return null;
  return new Date((value + CORE_DATA_EPOCH_OFFSET) * 1000).toISOString();
}

// ---------------------------------------------------------------------------
// SQLite (read operations)
// ---------------------------------------------------------------------------

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (db) return db;
  if (!existsSync(DB_PATH)) {
    throw new ThingsError(
      `Could not find the Things 3 database at "${DB_PATH}". ` +
        "Make sure Things 3 is installed and has been opened at least once."
    );
  }
  db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  return db;
}

const STATUS_LABELS: Record<number, string> = {
  0: "open",
  2: "canceled",
  3: "completed",
};

interface TaskRow {
  uuid: string;
  title: string;
  notes: string | null;
  status: number;
  startDate: number | null;
  deadline: number | null;
  stopDate: number | null;
  tags: string | null;
  project: string | null;
  area: string | null;
}

function formatTaskRow(row: TaskRow) {
  return {
    id: row.uuid,
    title: row.title,
    notes: row.notes || undefined,
    status: STATUS_LABELS[row.status] ?? String(row.status),
    when: decodeThingsDate(row.startDate) ?? undefined,
    deadline: decodeThingsDate(row.deadline) ?? undefined,
    completedAt: decodeCoreDataDate(row.stopDate) ?? undefined,
    tags: row.tags ? row.tags.split(", ") : undefined,
    project: row.project ?? undefined,
    area: row.area ?? undefined,
  };
}

const TASK_SELECT = `
  SELECT
    t.uuid, t.title, t.notes, t.status, t.startDate, t.deadline, t.stopDate,
    (SELECT group_concat(tag.title, ', ')
       FROM TMTaskTag tt JOIN TMTag tag ON tt.tags = tag.uuid
      WHERE tt.tasks = t.uuid) AS tags,
    p.title AS project,
    a.title AS area
  FROM TMTask t
  LEFT JOIN TMTask p ON t.project = p.uuid
  LEFT JOIN TMArea a ON t.area = a.uuid
`;

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "things3-mcp",
  version: "1.0.0",
});

// --- Write tools -----------------------------------------------------------

server.tool(
  "add_todo",
  "Create a new to-do in Things 3.",
  {
    title: z.string().describe("The to-do's title (required)"),
    notes: z.string().optional().describe("Notes for the to-do"),
    when: z
      .string()
      .optional()
      .describe("When to schedule it: 'today', 'tomorrow', 'evening', 'someday', or a YYYY-MM-DD date"),
    deadline: z.string().optional().describe("Deadline as a YYYY-MM-DD date"),
    tags: z.array(z.string()).optional().describe("Tags to apply (must already exist in Things)"),
    checklistItems: z.array(z.string()).optional().describe("Checklist item titles to add"),
    list: z.string().optional().describe("Name of the destination project or area"),
  },
  async ({ title, notes, when, deadline, tags, checklistItems, list }) => {
    try {
      const url = buildThingsUrl("add", {
        title,
        notes,
        when,
        deadline,
        tags: tags?.join(","),
        "checklist-items": checklistItems?.join("\n"),
        list,
      });
      await openThingsUrl(url);
      return toolResult({ status: "ok", url });
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.tool(
  "add_project",
  "Create a new project in Things 3.",
  {
    title: z.string().describe("The project's title (required)"),
    notes: z.string().optional().describe("Notes for the project"),
    area: z.string().optional().describe("Name of the destination area"),
    tags: z.array(z.string()).optional().describe("Tags to apply (must already exist in Things)"),
    todos: z.array(z.string()).optional().describe("Titles of initial to-dos to create inside the project"),
  },
  async ({ title, notes, area, tags, todos }) => {
    try {
      const url = buildThingsUrl("add-project", {
        title,
        notes,
        area,
        tags: tags?.join(","),
        "to-dos": todos?.join("\n"),
      });
      await openThingsUrl(url);
      return toolResult({ status: "ok", url });
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.tool(
  "update_todo",
  "Update an existing to-do in Things 3. Requires THINGS_AUTH_TOKEN to be set.",
  {
    id: z.string().describe("The to-do's id (required)"),
    title: z.string().optional().describe("New title"),
    notes: z.string().optional().describe("New notes (replaces existing notes)"),
    when: z.string().optional().describe("New schedule: 'today', 'tomorrow', 'evening', 'someday', or a YYYY-MM-DD date"),
    deadline: z.string().optional().describe("New deadline as a YYYY-MM-DD date"),
    tags: z.array(z.string()).optional().describe("Replace all tags with this set"),
    checklistItems: z.array(z.string()).optional().describe("Replace the checklist with these items"),
    completed: z.boolean().optional().describe("Mark as completed"),
    canceled: z.boolean().optional().describe("Mark as canceled"),
  },
  async ({ id, tags, checklistItems, ...rest }) => {
    try {
      const token = requireAuthToken();
      const url = buildThingsUrl("update", {
        id,
        "auth-token": token,
        ...rest,
        tags: tags?.join(","),
        "checklist-items": checklistItems?.join("\n"),
      });
      await openThingsUrl(url);
      return toolResult({ status: "ok" });
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.tool(
  "update_project",
  "Update an existing project in Things 3. Requires THINGS_AUTH_TOKEN to be set.",
  {
    id: z.string().describe("The project's id (required)"),
    title: z.string().optional().describe("New title"),
    notes: z.string().optional().describe("New notes (replaces existing notes)"),
    area: z.string().optional().describe("Move the project to this area"),
    tags: z.array(z.string()).optional().describe("Replace all tags with this set"),
    completed: z.boolean().optional().describe("Mark as completed"),
    canceled: z.boolean().optional().describe("Mark as canceled"),
  },
  async ({ id, tags, ...rest }) => {
    try {
      const token = requireAuthToken();
      const url = buildThingsUrl("update-project", {
        id,
        "auth-token": token,
        ...rest,
        tags: tags?.join(","),
      });
      await openThingsUrl(url);
      return toolResult({ status: "ok" });
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.tool(
  "search",
  "Open Things 3 and search for a term.",
  {
    query: z.string().describe("The search term"),
  },
  async ({ query }) => {
    try {
      const url = buildThingsUrl("search", { query });
      await openThingsUrl(url);
      return toolResult({ status: "ok" });
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.tool(
  "show",
  "Open a built-in list (Today, Upcoming, Anytime, Someday, Logbook, Inbox) or a project/area by id in Things 3.",
  {
    list: z.string().optional().describe("Built-in list name, e.g. 'today', 'upcoming', 'anytime', 'someday', 'logbook', 'inbox'"),
    id: z.string().optional().describe("Id of a specific project, area, or to-do to open"),
  },
  async ({ list, id }) => {
    try {
      if (!list && !id) {
        throw new ThingsError("Provide either 'list' or 'id'.");
      }
      const url = buildThingsUrl("show", { list, id });
      await openThingsUrl(url);
      return toolResult({ status: "ok" });
    } catch (err) {
      return errorResult(err);
    }
  }
);

// --- Read tools --------------------------------------------------------

server.tool("list_today", "List to-dos scheduled for Today.", {}, async () => {
  try {
    const rows = getDb()
      .prepare(
        `${TASK_SELECT}
         WHERE t.type = 0 AND t.trashed = 0 AND t.status = 0
           AND t.start = 1 AND t.startDate IS NOT NULL
         ORDER BY t."index" ASC`
      )
      .all() as TaskRow[];
    return toolResult(rows.map(formatTaskRow));
  } catch (err) {
    return errorResult(err);
  }
});

server.tool(
  "list_upcoming",
  "List to-dos scheduled for a future date or with an upcoming deadline.",
  {
    limit: z.number().int().min(1).max(200).default(50).describe("Max number of results (default 50)"),
  },
  async ({ limit }) => {
    try {
      const todayEncoded = encodeThingsDate(new Date());
      const rows = getDb()
        .prepare(
          `${TASK_SELECT}
           WHERE t.type = 0 AND t.trashed = 0 AND t.status = 0
             AND (
               (t.startDate IS NOT NULL AND t.startDate > @today)
               OR (t.deadline IS NOT NULL AND t.deadline >= @today)
             )
           ORDER BY COALESCE(t.startDate, t.deadline) ASC
           LIMIT @limit`
        )
        .all({ today: todayEncoded, limit }) as TaskRow[];
      return toolResult(rows.map(formatTaskRow));
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.tool("list_projects", "List open (non-trashed, incomplete) projects.", {}, async () => {
  try {
    const rows = getDb()
      .prepare(
        `${TASK_SELECT}
         WHERE t.type = 1 AND t.trashed = 0 AND t.status = 0
         ORDER BY t."index" ASC`
      )
      .all() as TaskRow[];
    return toolResult(rows.map(formatTaskRow));
  } catch (err) {
    return errorResult(err);
  }
});

server.tool("list_inbox", "List unclassified to-dos in the Inbox.", {}, async () => {
  try {
    const rows = getDb()
      .prepare(
        `${TASK_SELECT}
         WHERE t.type = 0 AND t.trashed = 0 AND t.status = 0 AND t.start = 0
         ORDER BY t."index" ASC`
      )
      .all() as TaskRow[];
    return toolResult(rows.map(formatTaskRow));
  } catch (err) {
    return errorResult(err);
  }
});

server.tool(
  "get_todo",
  "Get full details for a single to-do by id, including its checklist.",
  {
    id: z.string().describe("The to-do's id"),
  },
  async ({ id }) => {
    try {
      const row = getDb()
        .prepare(`${TASK_SELECT} WHERE t.uuid = @id AND t.type = 0`)
        .get({ id }) as TaskRow | undefined;
      if (!row) {
        throw new ThingsError(`No to-do found with id "${id}".`);
      }
      const checklist = getDb()
        .prepare(`SELECT title, status FROM TMChecklistItem WHERE task = @id ORDER BY "index" ASC`)
        .all({ id }) as Array<{ title: string; status: number }>;
      return toolResult({
        ...formatTaskRow(row),
        checklist: checklist.map((item) => ({
          title: item.title,
          status: STATUS_LABELS[item.status] ?? String(item.status),
        })),
      });
    } catch (err) {
      return errorResult(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Things 3 MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
