# things3-mcp

[![npm version](https://img.shields.io/npm/v/%40lcajigasm%2Fthings3-mcp)](https://www.npmjs.com/package/@lcajigasm/things3-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that connects Claude to [Things 3](https://culturedcode.com/things/) on macOS. Ask Claude to add to-dos and projects, search, open lists, and read your Today/Upcoming/Inbox — all from a Claude conversation.

> **Unofficial project.** Not affiliated with, endorsed by, or supported by Cultured Code. Things 3 is a trademark of Cultured Code GmbH & Co. KG.

## How it works

Things 3 doesn't expose a network API, so this server uses two different mechanisms:

- **Writing** (`add_todo`, `add_project`, `update_todo`, `update_project`, `search`, `show`) opens Things' [URL scheme](https://culturedcode.com/things/help/url-scheme/) in the background via `open -g things:///...`. This requires Things 3 to be running.
- **Reading** (`list_today`, `list_upcoming`, `list_projects`, `list_inbox`, `get_todo`) queries Things' local SQLite database directly, in read-only mode. The URL scheme has no way to read data back, so this is the only option.

## Prerequisites

- **macOS** with **Things 3** installed and running
- **Node.js 18+**
- To use `update_todo` / `update_project`: enable Things URLs in **Things → Settings → General → Enable Things URLs** and copy the auth token shown there

This server is macOS-only and talks to a local app and a local file — it is not a remote/OAuth-capable MCP server and cannot be hosted or used from another machine.

## Installation

### Claude Desktop

Add the following to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "things3": {
      "command": "npx",
      "args": ["-y", "@lcajigasm/things3-mcp"],
      "env": {
        "THINGS_AUTH_TOKEN": "your-token-here"
      }
    }
  }
}
```

Omit `THINGS_AUTH_TOKEN` if you don't need `update_todo` / `update_project`. Restart Claude Desktop afterwards.

### Claude Code

```bash
claude mcp add things3 --env THINGS_AUTH_TOKEN=your-token-here -- npx -y @lcajigasm/things3-mcp
```

### From source

```bash
git clone https://github.com/lcajigasm/things3-mcp.git
cd things3-mcp
npm install
npm run build
```

Then point Claude Desktop at the built file:

```json
{
  "mcpServers": {
    "things3": {
      "command": "node",
      "args": ["/absolute/path/to/things3-mcp/dist/index.js"],
      "env": {
        "THINGS_AUTH_TOKEN": "your-token-here"
      }
    }
  }
}
```

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `THINGS_AUTH_TOKEN` | Only for `update_todo` / `update_project` | Auth token from Things → Settings → General → Enable Things URls. Never logged or echoed back by this server. |
| `THINGS_DB_PATH` | No | Overrides auto-detection of the database file. Things nests it under a per-install `ThingsData-<id>` folder, which this server locates automatically — set this only if that detection fails for you. |

## Available tools

### Writing (via URL scheme)

| Tool | Description |
|---|---|
| `add_todo` | Create a to-do: title, notes, `when` (today/tomorrow/evening/someday/date), deadline, tags, checklist items, destination list. |
| `add_project` | Create a project: title, notes, area, tags, initial to-dos. |
| `update_todo` | Update a to-do by id. Requires `THINGS_AUTH_TOKEN`. |
| `update_project` | Update a project by id. Requires `THINGS_AUTH_TOKEN`. |
| `search` | Open Things and search for a term. |
| `show` | Open a built-in list (Today, Upcoming, Anytime, Someday, Logbook, Inbox) or a specific project/area/to-do by id. |

### Reading (via local database, read-only)

| Tool | Description |
|---|---|
| `list_today` | To-dos scheduled for Today. |
| `list_upcoming` | To-dos scheduled for a future date or with an upcoming deadline. |
| `list_projects` | Open (incomplete, non-trashed) projects. |
| `list_inbox` | Unclassified to-dos in the Inbox. |
| `get_todo` | Full detail for one to-do by id, including its checklist. |

## Example prompts

- "Add a to-do 'Renew passport' with a deadline of 2026-09-01"
- "Create a project called 'Q3 planning' in my Work area with to-dos for budget, hiring, roadmap"
- "What's on my plate today?"
- "What's coming up in the next few weeks?"
- "Show me everything sitting in my Inbox"
- "Mark to-do abc-123 as completed"
- "Open Things and search for 'invoice'"

## Limitations

- macOS + Things 3 only. No Windows/Linux/iOS support, no remote/hosted mode.
- Writing is fire-and-forget: the URL scheme doesn't return the created item's id, so `add_todo`/`add_project` can't tell you the new id directly (use `search` or `list_inbox` to find it afterwards).
- Reading queries Things' internal SQLite schema, which is undocumented and could change in future Things versions.
- `update_todo`/`update_project` need `THINGS_AUTH_TOKEN`; without it those two tools return an error, everything else still works.

## Troubleshooting

**"things3-mcp only works on macOS"**
This server calls `open -g things:///...` and reads a macOS-only app container path — there's no way around this.

**"Could not find the Things 3 database"**
Make sure Things 3 is installed and has been opened at least once (the database is created on first launch).

**"THINGS_AUTH_TOKEN environment variable is required"**
Only `update_todo`/`update_project` need it. Get it from Things → Settings → General → Enable Things URLs, then add it to your MCP config's `env` block.

**Claude doesn't see the Things 3 tools**
- Restart Claude Desktop after editing the config file
- Validate the JSON in `claude_desktop_config.json` (a trailing comma will break it)
- Run `npx @lcajigasm/things3-mcp` manually in a terminal to check for Node errors

## Development

```bash
npm install
npm run dev    # watch mode via tsx
npm run build  # compile to dist/
```

## License

MIT — see [LICENSE](LICENSE). Not affiliated with Cultured Code.
