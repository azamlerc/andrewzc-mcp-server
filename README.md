# Andrewzc MCP Server

MCP server for vector similarity search on the andrewzc database.

## Setup

1. Install dependencies:
```bash
npm install
```

2. Create `.env` file:
```
MONGODB_URI=your_mongodb_connection_string
MONGODB_DB=andrewzc
OPENAI_API_KEY=your_openai_api_key
```

3. Add to Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "andrewzc": {
      "command": "node",
      "args": [
        "/Users/andrewzc/Projects/andrewzc-mcp-server/index.js"
      ]
    }
  }
}
```

4. Restart Claude Desktop

## Tools

### find_similar

Find entities similar to a given entity using vector similarity search.

**Parameters:**
- `list` (required): List name (e.g., "metros", "train-stations")
- `entity_key` (required): Entity key (e.g., "london", "kings-cross")
- `limit` (optional): Max results (default: 10)

**Example:**
```
Find train stations similar to King's Cross
```

Claude will use: `find_similar(list="train-stations", entity_key="kings-cross", limit=10)`

### semantic_search

Search for entities using natural language queries. Embeds the query text and finds semantically similar entities.

**Parameters:**
- `query` (required): Natural language search query
- `list` (optional): Filter to specific list (e.g., "train-stations", "metros")
- `limit` (optional): Max results (default: 10)

**Examples:**
```
Find Victorian railway termini in Europe
Search for curved metro stations in Spain
Show me major international train stations
```

Claude will use: 
- `semantic_search(query="Victorian railway terminus Europe", list="train-stations")`
- `semantic_search(query="curved metro station Spain", list="stations")`
- `semantic_search(query="major international train station")`
# andrewzc-mcp-server
