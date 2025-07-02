# AGENTS.md — Agent Layer Specification

> **Goal**  Bootstrap an MVP of the Prompt → Plan → Event/Entity stack using a minimal TypeScript + Bun runtime, DuckDB for storage, and a *dual‑LLM* security model (CaMeL‑style). All local reasoning and planning run on‑device with **Qwen‑3‑4B** via Ollama; heavy execution or tool calls are delegated to a remote **Claude Sonnet 4** model via the Anthropic API.

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
ollama pull qwen:3-4b     # official Ollama tag

# Project bootstrap
bun create agentic‑mvp ./my‑workspace && cd my‑workspace
cp docs/AGENTS.md .       # this file
bun install               # installs duckdb, @anthropic-ai/sdk
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

### 3.1 Invocation

```
POST http://localhost:11434/api/generate
{
  "model": "qwen:3-4b",
  "prompt": PLANNER_TEMPLATE + user_prompt,
  "format": "json"
}
```

### 3.2 Prompt template (TypeScript string)

```ts
export const PLANNER_TEMPLATE = String.raw`
You are a deterministic planning LLM inside an "agentic notebook".
Output **only** JSON ‑ an array of step objects with fields:
  op          // snake_case verb
  args        // arbitrary JSON‑serialisable payload
  tool_caps   // array of required ToolCap IDs
  data_caps   // array of required DataCap IDs (for consumed entities)
  deps        // array of step indices this one depends on
`;
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

* Chat completion via **Anthropic** (model configurable, default `claude-sonnet-4`)
* Runs only **after** the Policy Engine green‑lights a step.
* May create new *Entity* rows; they inherit union of consumed caps.

```ts
import { Anthropic } from "@anthropic-ai/sdk";
const anthropic = new Anthropic();

const res = await anthropic.messages.create({
  model: process.env.EXECUTOR_MODEL ?? "claude-sonnet-4",
  tools: [{/* JSON schema */}],
  messages: buildMessages(planStep)
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
