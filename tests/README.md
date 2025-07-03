# Tests

This directory contains all test files for the POC Intent Router project.

## Test Files

| File | Description | Command |
|------|-------------|---------|
| `test-summary.ts` | Overview of all available tests | `bun run test` |
| `test-cli-structured.ts` | Direct agent testing with real-time feedback | `bun run test:cli` |
| `test-app-structured.ts` | Full end-to-end API validation | `bun run test:app` |
| `test-json-validation.ts` | Comprehensive schema compliance testing | `bun run test:json` |
| `test-mcp.ts` | MCP (Model Context Protocol) integration testing | `bun run test:mcp` |
| `test-server.ts` | Server functionality testing | `bun run test:server` |
| `test-e2e.ts` | End-to-end workflow testing | `bun run test:e2e` |

## Running Tests

### Run All Tests Summary
```bash
bun run test
```

### Run Individual Tests
```bash
# CLI testing (Ollama structured outputs)
bun run test:cli

# API testing (full server workflow)  
bun run test:app

# JSON schema validation
bun run test:json

# MCP integration
bun run test:mcp

# Server health and endpoints
bun run test:server

# End-to-end workflows
bun run test:e2e
```

### Prerequisites

1. **Ollama running** with `qwen3:4b` model:
   ```bash
   ollama serve
   ollama pull qwen3:4b
   ```

2. **Environment configured** with `.env` file:
   ```bash
   ANTHROPIC_API_KEY=sk-ant-...
   EXECUTOR_MODEL=claude-sonnet-4-0
   OLLAMA_ENDPOINT=http://localhost:11434
   PLANNER_MODEL=qwen3:4b
   ```

3. **Server running** (for API tests):
   ```bash
   bun run dev
   ```

## Test Coverage

- **Health checks**: Ollama connection and model availability
- **JSON validation**: Schema compliance and type safety  
- **Error handling**: Malformed inputs and edge cases
- **Performance**: Response times and token efficiency
- **Integration**: Policy engine and capability validation
- **MCP**: Model Context Protocol server integration
- **API endpoints**: REST API functionality and responses