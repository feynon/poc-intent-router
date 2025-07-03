# AGENTS.md — Agent Layer Specification

> **Goal**  Document the agentic architecture for the Prompt → Plan → Event/Entity stack using TypeScript + Bun, DuckDB for storage, and a dual-LLM security model. Local planning is performed with **Qwen-3-4B** via Ollama using **structured outputs** with the **ollama-js** library; execution is delegated to **Claude Sonnet 4** via Anthropic. Both agents use **Priompt** for intelligent prompt composition. The system integrates **MCP (Model Context Protocol)** for extensible tool capabilities.

---

## Recent Updates: Structured Outputs Implementation

### Ollama-JS Integration
The planner agent now uses the **ollama-js** library (v0.5.16) with structured outputs for guaranteed JSON schema compliance:

- **Schema Enforcement**: JSON structure validated by Ollama at generation time
- **Type Safety**: Zod schemas provide runtime validation and TypeScript types
- **Reliability**: Eliminates JSON parsing errors and ensures consistent output format
- **Performance**: Reduces token usage by removing format instructions from prompts

### MCP Integration
Added **Model Context Protocol** support for extensible tool capabilities:

- **Filesystem Tools**: MCP filesystem server for file operations
- **Extensible Architecture**: Easy addition of new MCP servers and tools
- **Capability Integration**: MCP tools automatically registered with policy engine

### Testing Infrastructure
Comprehensive test suites for validation:

- **CLI Testing**: Direct agent testing with real-time feedback
- **API Testing**: Full end-to-end validation via HTTP endpoints
- **JSON Validation**: Schema compliance and type safety verification
- **Debug Tools**: Raw response inspection and performance analysis

---

## Data Model Layers

| Layer                  | Primary nodes     | Key edges / indexes                          | Note                                                 |
| ---------------------- | ----------------- | -------------------------------------------- | ---------------------------------------------------- |
| Content store          | `Entity`          | `RELATES_TO`, `PART_OF`, HNSW on `embedding` | Semantic graph, replaces block tree                  |
| History / audit        | `Event`           | `produces[]`, `consumes[]` causal edges      | Full event log, enables replay & data-flow tracking  |
| Control-flow           | `Plan`            | `FULFILLED_BY`, `DEPENDS_ON`                 | Deterministic plan DAG, guards against prompt hijack |
| Security & permissions | `Capability`      | caps enforced per data-flow edge             | Fine-grained CaMeL capability model                  |
| Data-flow graph        | (runtime)         | edges derived from `Event`                   | Runtime taint graph for tool gating                  |
| View / render          | `ViewSpec`        | `GENERATED_FROM`                             | Transient UI spec, supports any client renderer      |
| Indexes                | —                 | HNSW + property-graph (`duckpgq`)            | Hybrid vector + symbolic search                      |
| Sync / collab          | event stream CRDT | vector clock                                 | Offline-first merging over DuckDB                    |

---

## 0. Quick-start checklist

```bash
# Prerequisites (macOS / Linux)
brew install bun duckdb ollama

# Pull planning model (Qwen-3-4B)
ollama run qwen3:4b

# Project bootstrap
git clone <repo-url>
cd poc-intent-router
bun install
cp .env.example .env   # Add your ANTHROPIC_API_KEY
bun run dev            # Starts HTTP server on :3000
```

---

## Prompt Engineering with Priompt

This implementation uses **[Priompt](https://github.com/anysphere/priompt)** for intelligent prompt composition with priority-based token inclusion across both planning and execution agents.

### Key Features
- **Dynamic token management**: Automatically includes maximum relevant context within token limits
- **Priority-based inclusion**: Critical instructions preserved while less important context may be truncated  
- **Structured prompts**: Uses `SystemMessage` and `UserMessage` components for clear organization
- **Context history support**: Planner accepts variable-priority context history for better planning decisions

### Agent Integration
- **Planner Agent**: 4000 token limit with priority-ordered prompt elements
- **Executor Agent**: 8000 token limit with structured execution prompts
- **Context History**: Optional `contextHistory` array in `PlannerRequest` with custom priorities

---

## 1. Core data concepts

| Object         | Purpose                                          |
| -------------- | ------------------------------------------------ |
| **Prompt**     | Immutable record of raw user input.              |
| **Plan**       | Deterministic JSON steps (derived).              |
| **Entity**     | Any content chunk; carries capability tags       |
| **Event**      | Append-only log; links `produces[] / consumes[]` |
| **Capability** | `DataCap` or `ToolCap`; fine-grained scopes      |

---

## 2. Agent roles & responsibilities

| Agent               | Model / Location                | Main job                                     |
| ------------------- | ------------------------------- | -------------------------------------------- |
| **Planner**         | Qwen-3-4B @ Ollama (local)      | Parse *Prompt* → ordered *Plan* with structured outputs |
| **Policy Engine**   | In-proc TypeScript              | Enforce CaMeL checks before every tool call  |
| **Executor**        | Claude Sonnet 4 (remote)        | Perform high-cost reasoning & tool commands  |
| **MCP Agent**       | MCP servers (local/remote)      | Provide extensible tool capabilities         |
| **Embedding Agent** | OpenAI `text-embedding-3-small` | Generate 384-dim vectors for `Entity`        |
| **Indexer**         | DuckDB `vss`, `duckpgq`         | Maintain HNSW + property-graph indexes       |

---

## 3. Planner agent specification

### 3.1 Invocation (Updated with Structured Outputs)

```ts
import { Ollama } from "ollama";

const ollama = new Ollama({ host: "http://localhost:11434" });

// JSON schema for structured outputs
const schema = {
  type: "array",
  items: {
    type: "object",
    properties: {
      op: { type: "string", description: "Operation name in snake_case" },
      args: { type: "object", description: "Operation arguments" },
      tool_caps: { type: "array", items: { type: "string" } },
      data_caps: { type: "array", items: { type: "string" } },
      deps: { type: "array", items: { type: "number" } }
    },
    required: ["op", "args", "tool_caps", "data_caps", "deps"],
    additionalProperties: false
  }
};

const response = await ollama.generate({
  model: "qwen3:4b",
  prompt: PLANNER_TEMPLATE + user_prompt,
  format: schema,  // Structured outputs with JSON schema enforcement
  stream: false,
  options: { temperature: 0.1 }
});
```

### 3.2 Prompt composition (Priompt-based)

```ts
function PlannerPrompt(props: PlannerPromptProps): PromptElement {
  const elements: PromptElement[] = [];
  
  // Core system message with highest priority
  elements.push(SystemMessage({
    p: 10,
    children: `You are a deterministic planning LLM inside an "agentic notebook".
Output **only** JSON - an array of step objects with fields:
  op          // snake_case verb
  args        // arbitrary JSON-serializable payload
  tool_caps   // array of required ToolCap IDs
  data_caps   // array of required DataCap IDs (for consumed entities)
  deps        // array of step indices this one depends on

IMPORTANT: Always respond with a JSON array starting with [ and ending with ].`
  }));
  
  // Available operations (priority 8)
  elements.push(SystemMessage({
    p: 8,
    children: `Available operations:\n${availableOperations.map(op => `- ${op}`).join('\n')}`
  }));
  
  // Context history with variable priorities
  contextHistory.forEach((context) => {
    elements.push(SystemMessage({
      p: context.priority,
      children: `Context: ${context.content}`
    }));
  });
  
  // User prompt with high priority
  elements.push(UserMessage({
    p: 9,
    children: userPrompt
  }));

  return elements;
}

// Render with token limit
const renderedPrompt = render(promptElement, { tokenLimit: 4000 });
```

### 3.3 JSON output schema (Zod)

```ts
const Step = z.object({
  op: z.string(),
  args: z.any(),
  tool_caps: z.array(z.string()),
  data_caps: z.array(z.string()),
  deps: z.array(z.number())
});
export const PlanSchema = z.array(Step);
```

### 3.4 Example

```json
[
  {
    "op": "fetch_meeting_notes",
    "args": { "topic": "Q2 OKRs" },
    "tool_caps": ["READ_FILE"],
    "data_caps": ["share_with:bob"],
    "deps": []
  },
  {
    "op": "send_email",
    "args": {
      "to": "bob@example.com",
      "subject": "Notes you requested",
      "attachment_ref": "step0.result"
    },
    "tool_caps": ["SEND_EMAIL"],
    "data_caps": ["share_with:bob"],
    "deps": [0]
  }
]
```

---

## 4. Policy-engine contract (CaMeL-style)

```txt
FOR  each plan_step
    FOR each arg_ref IN plan_step.args
        data_caps ← UNION( Entity.caps WHERE id = arg_ref )
        ASSERT data_caps ⊆ plan_step.data_caps
        ASSERT plan_step.tool_caps ⊆ CapabilityRegistry[plan_step.op]
END
```

If either assertion fails → raise `CAPABILITY_VIOLATION` → surface approval modal in UI.

---

## 5. Executor agent specification

* Chat completion via **Anthropic** (model configurable, default `claude-sonnet-4`)
* Runs only **after** the Policy Engine green-lights a step.
* May create new *Entity* rows; they inherit union of consumed caps.
* Uses **Priompt** for structured prompt composition with priority-based context inclusion.

```ts
import { Anthropic } from "@anthropic-ai/sdk";
import { render, SystemMessage, UserMessage } from "@anysphere/priompt";

private buildExecutorPrompt(step: Step, context: any): PromptElement {
  const elements: PromptElement[] = [];
  
  // Core system instructions (highest priority)
  elements.push(SystemMessage({
    p: 10,
    children: `You are an executor agent in an agentic system. 
Use the provided tools to complete the operation efficiently and accurately.`
  }));
  
  // Operation details (high priority)
  elements.push(SystemMessage({
    p: 9,
    children: `Operation: ${step.op}\nArguments: ${JSON.stringify(step.args, null, 2)}`
  }));
  
  // Context information (medium priority - may be truncated if large)
  if (context && Object.keys(context).length > 0) {
    elements.push(SystemMessage({
      p: 6,
      children: `Context: ${JSON.stringify(context, null, 2)}`
    }));
  }
  
  // Final instruction (high priority)
  elements.push(UserMessage({
    p: 8,
    children: "Execute this operation and return the result."
  }));
  
  return elements;
}

const res = await anthropic.messages.create({
  model: process.env.EXECUTOR_MODEL ?? "claude-sonnet-4",
  tools: [{/* JSON schema */}],
  messages: [{ role: "user", content: render(promptElement, { tokenLimit: 8000 }).toString() }]
});
```

---

## 6. Directory layout (suggested)

```
/agents
  planner.ts        # Ollama wrapper
  executor.ts       # Anthropic wrapper + tool registry
  policy.ts         # capability checks
  embeddings.ts     # vector utils
  types.ts          # Zod + TS types
/database
  schema.sql        # DuckDB DDL (see spec)
/src
  server.ts         # Bun HTTP
  routes.ts         # REST endpoints
/docs
  AGENTS.md         # ← you are here
.env.example        # ANTHROPIC_API_KEY, EXECUTOR_MODEL, …
```

---

## 7. Running the full loop (dev script)

```bash
bun run src/server.ts &               # API + policy engine
ollama serve &                        # local LLM
bun run scripts/repl.ts               # REPL: type prompts, see JSON plans + events
```

---

## 8. Extending the capability registry

Add new tool or data capabilities in `agents/capability-registry.ts` and ensure each tool implementation exports its required `tool_caps` for policy checks.

---

## 9. MCP (Model Context Protocol) Integration

### MCP Agent
The system includes an MCP agent for extensible tool capabilities:

```ts
import { MCPAgent, defaultMCPConfig } from "../agents/mcp-agent.js";

const mcpAgent = new MCPAgent(defaultMCPConfig);
await mcpAgent.initialize();

// Get available MCP tools
const tools = mcpAgent.getMCPTools();
const capabilities = mcpAgent.getRequiredCapabilities();
```

### Default MCP Servers
- **Filesystem Server**: Provides file operation tools with sandboxed access
- **Extensible**: Easy to add additional MCP servers for new capabilities

### API Endpoints
- `GET /mcp/servers` — List MCP servers
- `POST /mcp/servers` — Add MCP server
- `GET /mcp/tools` — List available MCP tools

---

## 10. Testing Structured Outputs

### CLI Testing
```bash
bun run test-cli-structured.ts      # Direct agent testing with feedback
bun run test-json-validation.ts     # Schema compliance testing
bun run debug-structured-outputs.ts # Raw response inspection
bun run test-summary.ts            # Implementation summary
```

### API Testing
```bash
bun run dev                         # Start server
bun run test-app-structured.ts      # End-to-end API validation
```

### Test Coverage
- **Health Checks**: Ollama connection and model availability
- **JSON Validation**: Schema compliance and type safety
- **Error Handling**: Malformed inputs and edge cases
- **Performance**: Response times and token efficiency
- **Integration**: Policy engine and MCP tool validation

---

## 11. Open questions / next steps

1. **CRDT overlay** — leverage DuckDB 1.3's `crdt` table-function once stable.
2. **Streaming plans** — adopt SSE to push Plan + Event deltas to the UI.
3. **Fine-tune Qwen-3-4B** on your domain-specific planning traces for tighter JSON.
4. **Schema optimization** — experiment with different JSON schemas for better model compliance.
5. **MCP expansion** — add more MCP servers for additional tool capabilities. 