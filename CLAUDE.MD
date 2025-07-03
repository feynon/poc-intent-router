# AGENTS.md — Agent Layer Specification

> **Goal**  Bootstrap an MVP of the Prompt → Plan → Event/Entity stack using a minimal TypeScript + Bun runtime, DuckDB for storage, and a *dual‑LLM* security model (CaMeL‑style). All local reasoning and planning run on‑device with **Qwen‑3‑4B** via Ollama; heavy execution or tool calls are delegated to a remote **Claude Sonnet 4** model via the Anthropic API.

---

## Recent Updates

### Ollama Structured Outputs Integration (Latest)

The project now uses **ollama-js** library (v0.5.16) with structured outputs for guaranteed JSON compliance:

- **Schema Enforcement**: JSON structure validated by Ollama at generation time
- **Type Safety**: Zod schemas provide runtime validation and TypeScript types  
- **Reliability**: Eliminates JSON parsing errors and ensures consistent output format
- **Performance**: Reduces token usage by removing format instructions from prompts

### Key Implementation Changes

1. **PlannerAgent Updated**: Now uses `ollama-js` client instead of raw fetch calls
2. **JSON Schema**: Enforces step structure with required fields (op, args, tool_caps, data_caps, deps)
3. **Testing Suite**: Comprehensive test coverage for CLI and API validation
4. **MCP Integration**: Model Context Protocol for extensible tool capabilities

### Dependencies Added
- **ollama** (v0.5.16) - Official Ollama JavaScript library
- **@modelcontextprotocol/sdk** - MCP integration framework

---

## Prompt Engineering with Priompt

This implementation integrates **[Priompt](https://github.com/anysphere/priompt)** for intelligent prompt composition with priority-based token inclusion across both planning and execution agents.

### Key Benefits
- **Dynamic token management**: Automatically includes maximum relevant context within token limits
- **Priority-based inclusion**: Critical instructions preserved while less important context may be truncated
- **Structured prompts**: Uses `SystemMessage` and `UserMessage` components for clear organization
- **Context history support**: Planner accepts variable-priority context history for better planning decisions

### Implementation Details
- **Planner Agent**: 4000 token limit with priority-ordered prompt elements
- **Executor Agent**: 8000 token limit with structured execution prompts
- **Context History**: Optional `contextHistory` array in `PlannerRequest` with custom priorities

---

## Data Model Layers

| Layer                  | Primary nodes     | Key edges / indexes                          | Note                                                 |
| ---------------------- | ----------------- | -------------------------------------------- | ---------------------------------------------------- |
| Content store          | `Entity`          | `RELATES_TO`, `PART_OF`, HNSW on `embedding` | Replaces Notion block tree with semantic graph       |
| History / audit        | `Event`           | `produces[]`, `consumes[]` causal edges      | Full event log, enables replay & data‑flow tracking  |
| Control‑flow           | `Plan`            | `FULFILLED_BY`, `DEPENDS_ON`                 | Deterministic plan DAG, guards against prompt hijack |
| Security & permissions | `Capability`      | caps enforced per data‑flow edge             | Fine‑grained CaMeL capability model                  |
| Data‑flow graph        | (runtime)         | edges derived from `Event`                   | Runtime taint graph for tool gating                  |
| View / render          | `ViewSpec`        | `GENERATED_FROM`                             | Transient UI spec, supports any client renderer      |
| Indexes                | —                 | HNSW + property‑graph (`duckpgq`)            | Hybrid vector + symbolic search                      |
| Sync / collab          | event stream CRDT | vector clock                                 | Offline‑first merging over DuckDB                    |

---

## 0. Quick‑start checklist

```bash
# Prerequisites (macOS / Linux)
brew install bun duckdb ollama

# Pull planning model (≈4 B params, fits in ~6 GB VRAM)
ollama pull qwen3:4b     # official Ollama tag

# Project bootstrap
bun create agentic‑mvp ./my‑workspace && cd my‑workspace
cp docs/AGENTS.md .       # this file
bun install               # installs duckdb, @anthropic-ai/sdk, @anysphere/priompt, ollama, @modelcontextprotocol/sdk
cp .env.example .env      # add your ANTHROPIC_API_KEY
bun run dev               # starts HTTP server on :3000
```

---

## 1. Core data concepts

| Object         | Purpose                                          |
| -------------- | ------------------------------------------------ |
| **Prompt**     | Immutable record of raw user input.              |
| **Plan**       | Deterministic JSON steps (derived).              |
| **Entity**     | Any content chunk; carries capability tags       |
| **Event**      | Append‑only log; links `produces[] / consumes[]` |
| **Capability** | `DataCap` or `ToolCap`; fine‑grained scopes      |

---

## 2. Agent roles & responsibilities

| Agent               | Model / Location                | Main job                                     |
| ------------------- | ------------------------------- | -------------------------------------------- |
| **Planner**         | Qwen‑3‑4B @ Ollama (local)      | Parse *Prompt* → ordered *Plan*; attach caps |
| **Policy Engine**   | In‑proc TypeScript              | Enforce CaMeL checks before every tool call  |
| **Executor**        | Claude Sonnet 4 (remote)        | Perform high‑cost reasoning & tool commands  |
| **Embedding Agent** | OpenAI `text-embedding‑3‑small` | Generate 384‑dim vectors for `Entity`        |
| **Indexer**         | DuckDB `vss`, `duckpgq`         | Maintain HNSW + property‑graph indexes       |

> **Why Qwen‑3‑4B?** It’s small enough for laptop GPUs/Apple Silicon yet outperforms Phi‑3 class models on planning benchmarks. Using Ollama keeps DevOps friction near‑zero.

---

## 3. Planner agent specification

### 3.1 Invocation (Updated with Structured Outputs)

```ts
import { Ollama } from "ollama";

const ollama = new Ollama({ host: "http://localhost:11434" });

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
    required: ["op", "args", "tool_caps", "data_caps", "deps"]
  }
};

const response = await ollama.generate({
  model: "qwen3:4b",
  prompt: PLANNER_TEMPLATE + user_prompt,
  format: schema,  // Structured outputs with JSON schema
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

## 4. Policy‑engine contract (CaMeL‑style)

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

## 5. Executor agent specification

* Chat completion via **Anthropic** (model configurable, default `claude-sonnet-4-0`)
* Runs only **after** the Policy Engine green‑lights a step.
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
  model: process.env.EXECUTOR_MODEL ?? "claude-sonnet-4-0",
  tools: [{/* JSON schema */}],
  messages: [{ role: "user", content: render(promptElement, { tokenLimit: 8000 }).toString() }]
});
```

---

## 6. Directory layout (suggested)

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
/tests
  test-*.ts         # All test files
  README.md         # Test documentation
/docs
  AGENTS.md         # ← you are here
.env.example        # ANTHROPIC_API_KEY, EXECUTOR_MODEL, …
```

---

## 7. Running the full loop (dev script)

```bash
bun run src/server.ts &               # API + policy engine
ollama serve &                        # local LLM
bun run scripts/repl.ts               # REPL: type prompts, see JSON plans + events
```

---

## 8. Extending the capability registry

```ts
// capabilityRegistry.ts
export const CapabilityRegistry = {
  READ_FILE:  { kind: "ToolCap", scope: "fs" },
  SEND_EMAIL: { kind: "ToolCap", scope: "smtp" },
  // add your own…
};
```

Every tool implementation **must** export its required `tool_caps` so the Policy Engine can cross‑check.

---

## 9. Open questions / next steps

1. **CRDT overlay** — leverage DuckDB 1.3’s `crdt` table‑function once stable.
2. **Streaming plans** — adopt SSE to push Plan + Event deltas to the UI.
3. **Fine‑tune Qwen‑3‑4B** on your domain‑specific planning traces for tighter JSON.
4. **Structured outputs optimization** — experiment with different schema designs for better model compliance.

---

## Testing Structured Outputs

### CLI Testing
```bash
bun run test:cli      # Direct agent testing with real-time feedback
bun run test:json     # Comprehensive schema compliance testing
bun run debug-structured-outputs.ts # Raw response inspection and debugging
```

### App Testing
```bash
bun run dev                         # Start the server
bun run test:app      # Full end-to-end API validation
```

### Test Coverage
- **Health checks**: Ollama connection and model availability
- **JSON validation**: Schema compliance and type safety
- **Error handling**: Malformed inputs and edge cases
- **Performance**: Response times and token efficiency
- **Integration**: Policy engine and capability validation
