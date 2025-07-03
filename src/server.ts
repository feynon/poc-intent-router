import { Database } from "duckdb";
import { PlannerAgent } from "../agents/planner.js";
import { MockPlannerAgent } from "../agents/mock-planner.js";
import { PolicyEngine } from "../agents/policy.js";
import { ExecutorAgent } from "../agents/executor.js";
import { MCPAgent, defaultMCPConfig } from "../agents/mcp-agent.js";
import { 
  Prompt, 
  Plan, 
  Entity, 
  Event, 
  Capability,
  PlannerRequest,
  ExecutorRequest,
  PromptSchema,
  PlanSchema,
  EntitySchema,
  EventSchema
} from "../agents/types.js";

export class AgentServer {
  private db: Database;
  private planner: PlannerAgent | MockPlannerAgent;
  private policy: PolicyEngine;
  private executor: ExecutorAgent;
  private mcpAgent: MCPAgent;
  private port: number;

  constructor(port: number = 3000) {
    this.port = port;
    this.db = new Database(":memory:");
    
    // Initialize MCP agent
    this.mcpAgent = new MCPAgent(defaultMCPConfig);
    
    // Use mock planner for demo or when Ollama has issues
    const useMockPlanner = process.env.USE_MOCK_PLANNER === "true";
    this.planner = useMockPlanner 
      ? new MockPlannerAgent()
      : new PlannerAgent(
          process.env.OLLAMA_ENDPOINT || "http://localhost:11434",
          process.env.PLANNER_MODEL || "qwen3:4b"
        );
    this.policy = new PolicyEngine();
    
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (!anthropicKey) {
      throw new Error("ANTHROPIC_API_KEY environment variable is required");
    }
    
    this.executor = new ExecutorAgent(
      anthropicKey, 
      process.env.EXECUTOR_MODEL || "claude-sonnet-4-0",
      this.mcpAgent
    );
    this.initializeDatabase();
    this.initializeCapabilities();
  }

  private initializeDatabase(): void {
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS prompts (
          id VARCHAR PRIMARY KEY,
          content TEXT NOT NULL,
          timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          metadata JSON DEFAULT '{}'
        );

        CREATE TABLE IF NOT EXISTS plans (
          id VARCHAR PRIMARY KEY,
          prompt_id VARCHAR NOT NULL,
          steps JSON NOT NULL,
          timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          status VARCHAR(20) DEFAULT 'pending'
        );

        CREATE TABLE IF NOT EXISTS entities (
          id VARCHAR PRIMARY KEY,
          content TEXT NOT NULL,
          embedding VARCHAR,
          capabilities JSON DEFAULT '[]',
          metadata JSON DEFAULT '{}',
          timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS events (
          id VARCHAR PRIMARY KEY,
          plan_id VARCHAR NOT NULL,
          step_index INTEGER NOT NULL,
          op VARCHAR(100) NOT NULL,
          produces JSON DEFAULT '[]',
          consumes JSON DEFAULT '[]',
          result JSON,
          error TEXT,
          timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS capabilities (
          id VARCHAR PRIMARY KEY,
          kind VARCHAR(20) NOT NULL,
          scope VARCHAR(100) NOT NULL,
          description TEXT
        );
      `);
    } catch (err) {
      console.error("Failed to initialize database:", err);
      throw err;
    }
  }

  private initializeCapabilities(): void {
    const defaultCapabilities: Capability[] = [
      { id: "READ_FILE", kind: "ToolCap", scope: "fs", description: "Read files from filesystem" },
      { id: "WRITE_FILE", kind: "ToolCap", scope: "fs", description: "Write files to filesystem" },
      { id: "SEND_EMAIL", kind: "ToolCap", scope: "smtp", description: "Send email messages" },
      { id: "HTTP_REQUEST", kind: "ToolCap", scope: "network", description: "Make HTTP requests" },
      { id: "SEARCH_WEB", kind: "ToolCap", scope: "network", description: "Search the web" },
      { id: "share_with:public", kind: "DataCap", scope: "sharing", description: "Share data publicly" },
      { id: "share_with:team", kind: "DataCap", scope: "sharing", description: "Share data with team" },
      { id: "pii_allowed", kind: "DataCap", scope: "privacy", description: "Handle PII data" },
    ];

    for (const capability of defaultCapabilities) {
      this.policy.addCapability(capability);
    }

    // Add MCP capabilities
    const mcpCapabilities = this.mcpAgent.getRequiredCapabilities();
    for (const capability of mcpCapabilities) {
      this.policy.addCapability(capability);
    }
  }

  async start(): Promise<void> {
    // Initialize MCP agent
    await this.mcpAgent.initialize();
    
    const server = Bun.serve({
      port: this.port,
      fetch: this.handleRequest.bind(this),
    });

    console.log(`🚀 Agent server running on http://localhost:${this.port}`);
    console.log(`📊 Health check: http://localhost:${this.port}/health`);
  }

  private async handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      // CORS headers
      const corsHeaders = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      };

      if (method === "OPTIONS") {
        return new Response(null, { headers: corsHeaders });
      }

      // Route handling
      if (path === "/health" && method === "GET") {
        return this.handleHealthCheck();
      }
      
      if (path === "/prompt" && method === "POST") {
        return this.handlePrompt(request);
      }
      
      if (path === "/plans" && method === "GET") {
        return this.handleGetPlans();
      }
      
      if (path.startsWith("/plans/") && method === "GET") {
        const planId = path.split("/")[2];
        return this.handleGetPlan(planId);
      }
      
      if (path.startsWith("/plans/") && path.endsWith("/execute") && method === "POST") {
        const planId = path.split("/")[2];
        return this.handleExecutePlan(planId);
      }
      
      if (path === "/entities" && method === "GET") {
        return this.handleGetEntities();
      }
      
      if (path === "/events" && method === "GET") {
        return this.handleGetEvents();
      }
      
      if (path === "/mcp/servers" && method === "GET") {
        return this.handleGetMCPServers();
      }
      
      if (path === "/mcp/servers" && method === "POST") {
        return this.handleAddMCPServer(request);
      }
      
      if (path === "/mcp/tools" && method === "GET") {
        return this.handleGetMCPTools();
      }
      
      if (path === "/test/structured-outputs" && method === "POST") {
        return this.handleTestStructuredOutputs(request);
      }

      return new Response("Not Found", { 
        status: 404, 
        headers: corsHeaders 
      });

    } catch (error) {
      console.error("Request handling error:", error);
      return new Response(JSON.stringify({ 
        error: error instanceof Error ? error.message : "Internal server error" 
      }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  private async handleHealthCheck(): Promise<Response> {
    const plannerHealthy = await this.planner.healthCheck();
    const executorHealthy = await this.executor.healthCheck();
    const mcpHealthy = await this.mcpAgent.healthCheck();

    const health = {
      status: "ok",
      timestamp: new Date().toISOString(),
      services: {
        planner: plannerHealthy ? "healthy" : "unhealthy",
        executor: executorHealthy ? "healthy" : "unhealthy",
        mcp: mcpHealthy ? "healthy" : "unhealthy",
        database: "healthy", // DuckDB is in-memory, assume healthy
      },
      mcp: {
        servers: this.mcpAgent.getServerNames(),
        tools: this.mcpAgent.getMCPTools().map(tool => ({
          name: tool.name,
          server: tool.server_name,
          description: tool.description
        }))
      }
    };

    return new Response(JSON.stringify(health), {
      headers: { "Content-Type": "application/json" },
    });
  }

  private async handlePrompt(request: Request): Promise<Response> {
    const body = await request.json();
    const { content, metadata = {} } = body;

    if (!content || typeof content !== "string") {
      return new Response(JSON.stringify({ error: "Content is required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Create prompt record
    const prompt: Prompt = {
      id: crypto.randomUUID(),
      content,
      timestamp: new Date().toISOString(),
      metadata,
    };

    // Store prompt in database
    await this.storePrompt(prompt);

    // Generate plan
    const plannerRequest: PlannerRequest = {
      prompt: content,
      context: metadata,
    };

    try {
      const plannerResponse = await this.planner.generatePlan(plannerRequest);
      const plan = { ...plannerResponse.plan, prompt_id: prompt.id };

      // Validate plan with policy engine
      const violations = await this.policy.validatePlan(
        plan,
        [],
        this.executor.getToolRegistry()
      );

      if (violations.length > 0) {
        return new Response(JSON.stringify({
          prompt_id: prompt.id,
          plan_id: plan.id,
          status: "policy_violation",
          violations,
          requires_approval: violations.some(v => 
            v.violation_type === "missing_tool_cap" || 
            v.violation_type === "missing_data_cap"
          ),
        }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      // Store plan
      await this.storePlan(plan);

      return new Response(JSON.stringify({
        prompt_id: prompt.id,
        plan_id: plan.id,
        status: "approved",
        confidence: plannerResponse.confidence,
        steps: plan.steps.length,
      }), {
        headers: { "Content-Type": "application/json" },
      });

    } catch (error) {
      return new Response(JSON.stringify({
        prompt_id: prompt.id,
        error: error instanceof Error ? error.message : "Planning failed",
      }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  private async handleGetPlans(): Promise<Response> {
    try {
      const stmt = this.db.prepare("SELECT * FROM plans ORDER BY timestamp DESC LIMIT 50");
      const rows = stmt.all();
      stmt.finalize();
      return new Response(JSON.stringify(rows || []), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err instanceof Error ? err.message : "Database error" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  private async handleGetPlan(planId: string): Promise<Response> {
    try {
      const stmt = this.db.prepare("SELECT * FROM plans WHERE id = ?");
      const row = stmt.get(planId);
      stmt.finalize();
      
      if (!row) {
        return new Response(JSON.stringify({ error: "Plan not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }
      
      return new Response(JSON.stringify(row), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err instanceof Error ? err.message : "Database error" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  private async handleExecutePlan(planId: string): Promise<Response> {
    // This would implement the full plan execution logic
    // For now, return a placeholder
    return new Response(JSON.stringify({
      plan_id: planId,
      status: "execution_started",
      message: "Plan execution not yet implemented",
    }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  private async handleGetEntities(): Promise<Response> {
    try {
      const stmt = this.db.prepare("SELECT * FROM entities ORDER BY timestamp DESC LIMIT 50");
      const rows = stmt.all();
      stmt.finalize();
      return new Response(JSON.stringify(rows || []), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err instanceof Error ? err.message : "Database error" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  private async handleGetEvents(): Promise<Response> {
    try {
      const stmt = this.db.prepare("SELECT * FROM events ORDER BY timestamp DESC LIMIT 100");
      const rows = stmt.all();
      stmt.finalize();
      return new Response(JSON.stringify(rows || []), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err instanceof Error ? err.message : "Database error" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  private async storePrompt(prompt: Prompt): Promise<void> {
    try {
      const stmt = this.db.prepare(
        "INSERT INTO prompts (id, content, timestamp, metadata) VALUES (?, ?, ?, ?)"
      );
      stmt.run(prompt.id, prompt.content, prompt.timestamp, JSON.stringify(prompt.metadata));
      stmt.finalize();
    } catch (err) {
      throw new Error(`Failed to store prompt: ${err}`);
    }
  }

  private async storePlan(plan: Plan): Promise<void> {
    try {
      const stmt = this.db.prepare(
        "INSERT INTO plans (id, prompt_id, steps, timestamp, status) VALUES (?, ?, ?, ?, ?)"
      );
      stmt.run(plan.id, plan.prompt_id, JSON.stringify(plan.steps), plan.timestamp, plan.status);
      stmt.finalize();
    } catch (err) {
      throw new Error(`Failed to store plan: ${err}`);
    }
  }

  private async handleGetMCPServers(): Promise<Response> {
    const servers = this.mcpAgent.getServerNames();
    return new Response(JSON.stringify({ servers }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  private async handleAddMCPServer(request: Request): Promise<Response> {
    try {
      const body = await request.json();
      const { name, command, args, env } = body;

      if (!name || !command || !args) {
        return new Response(JSON.stringify({ 
          error: "Missing required fields: name, command, args" 
        }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      await this.mcpAgent.addServer({ name, command, args, env });
      
      return new Response(JSON.stringify({ 
        success: true, 
        message: `MCP server ${name} added successfully` 
      }), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      return new Response(JSON.stringify({ 
        error: error instanceof Error ? error.message : "Failed to add MCP server" 
      }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  private async handleGetMCPTools(): Promise<Response> {
    const tools = this.mcpAgent.getMCPTools();
    return new Response(JSON.stringify({ tools }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  private async handleTestStructuredOutputs(request: Request): Promise<Response> {
    try {
      const body = await request.json();
      const { prompt, contextHistory = [] } = body;

      if (!prompt || typeof prompt !== "string") {
        return new Response(JSON.stringify({ 
          error: "Prompt is required and must be a string" 
        }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      const startTime = Date.now();
      
      // Test planner health first
      const plannerHealthy = await this.planner.healthCheck();
      if (!plannerHealthy) {
        return new Response(JSON.stringify({
          error: "Planner service is not available",
          suggestion: "Make sure Ollama is running and the model is pulled"
        }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Generate plan using structured outputs
      const plannerRequest: PlannerRequest = {
        prompt,
        contextHistory
      };

      const plannerResponse = await this.planner.generatePlan(plannerRequest);
      const duration = Date.now() - startTime;

      // Validate with policy engine
      const violations = await this.policy.validatePlan(
        plannerResponse.plan,
        [],
        this.executor.getToolRegistry()
      );

      // Return comprehensive test results
      return new Response(JSON.stringify({
        test_metadata: {
          timestamp: new Date().toISOString(),
          duration_ms: duration,
          ollama_structured_outputs: true,
          validation_engine: "zod"
        },
        planner_response: {
          plan_id: plannerResponse.plan.id,
          confidence: plannerResponse.confidence,
          steps_count: plannerResponse.plan.steps.length,
          steps: plannerResponse.plan.steps
        },
        policy_validation: {
          passed: violations.length === 0,
          violations_count: violations.length,
          violations: violations
        },
        json_schema_validation: {
          valid: true, // If we got here, JSON schema validation passed
          schema_enforced_by: "ollama-js structured outputs"
        }
      }), {
        headers: { "Content-Type": "application/json" },
      });

    } catch (error) {
      return new Response(JSON.stringify({
        error: error instanceof Error ? error.message : "Test failed",
        test_metadata: {
          timestamp: new Date().toISOString(),
          ollama_structured_outputs: true,
          validation_engine: "zod"
        }
      }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }
}

// Start the server if this file is run directly
if (import.meta.main) {
  const server = new AgentServer();
  server.start().catch(console.error);
}