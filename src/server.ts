import { Database } from "duckdb";
import * as path from "path";
import * as fs from "fs";
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
    
    // Initialize database with persistent storage option
    const dbPath = process.env.DATABASE_PATH || ":memory:";
    
    // Ensure database directory exists for persistent storage
    if (dbPath !== ":memory:") {
      this.ensureDatabaseDirectory(dbPath);
    }
    
    this.db = new Database(dbPath);
    
    if (dbPath !== ":memory:") {
      console.log(`📁 Using persistent database: ${dbPath}`);
    } else {
      console.log("⚠️  Using in-memory database (data will be lost on restart)");
    }
    
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
    this.policy = new PolicyEngine([], this.db);
    
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
    // Note: initializeCapabilities is now called after database is ready
  }

  private ensureDatabaseDirectory(dbPath: string): void {
    try {
      const dir = path.dirname(dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        console.log(`📁 Created database directory: ${dir}`);
      }
    } catch (err) {
      console.error(`Failed to create database directory: ${err}`);
      throw err;
    }
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
          description TEXT,
          is_system BOOLEAN DEFAULT FALSE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          metadata JSON DEFAULT '{}'
        );
      `);
    } catch (err) {
      console.error("Failed to initialize database:", err);
      throw err;
    }
  }

  private async initializeCapabilities(): Promise<void> {
    try {
      // First, load existing capabilities from database
      await this.policy.loadCapabilitiesFromDatabase();
      
      // Define default system capabilities
      const defaultCapabilities: (Capability & { is_system: boolean })[] = [
        { id: "READ_FILE", kind: "ToolCap", scope: "fs", description: "Read files from filesystem", is_system: true },
        { id: "WRITE_FILE", kind: "ToolCap", scope: "fs", description: "Write files to filesystem", is_system: true },
        { id: "SEND_EMAIL", kind: "ToolCap", scope: "smtp", description: "Send email messages", is_system: true },
        { id: "HTTP_REQUEST", kind: "ToolCap", scope: "network", description: "Make HTTP requests", is_system: true },
        { id: "SEARCH_WEB", kind: "ToolCap", scope: "network", description: "Search the web", is_system: true },
        { id: "share_with:public", kind: "DataCap", scope: "sharing", description: "Share data publicly", is_system: true },
        { id: "share_with:team", kind: "DataCap", scope: "sharing", description: "Share data with team", is_system: true },
        { id: "pii_allowed", kind: "DataCap", scope: "privacy", description: "Handle PII data", is_system: true },
      ];

      // Add default capabilities if they don't exist
      for (const capability of defaultCapabilities) {
        const existing = this.policy.getCapability(capability.id);
        if (!existing) {
          await this.policy.addCapability(capability, true);
          console.log(`🔧 Added system capability: ${capability.id}`);
        }
      }

      // Add MCP capabilities
      const mcpCapabilities = this.mcpAgent.getRequiredCapabilities();
      for (const capability of mcpCapabilities) {
        const existing = this.policy.getCapability(capability.id);
        if (!existing) {
          await this.policy.addCapability({
            ...capability,
            is_system: false, // MCP capabilities are not system capabilities
            metadata: { source: "mcp", auto_generated: true }
          } as any, true);
          console.log(`🔌 Added MCP capability: ${capability.id}`);
        }
      }
      
      console.log(`✅ Capability system initialized with ${this.policy.listCapabilities().length} capabilities`);
      
    } catch (error) {
      console.error("Failed to initialize capabilities:", error);
      throw error;
    }
  }

  async start(): Promise<void> {
    // Initialize MCP agent
    await this.mcpAgent.initialize();
    
    // Initialize capabilities after MCP agent is ready
    await this.initializeCapabilities();
    
    Bun.serve({
      port: this.port,
      fetch: this.handleRequest.bind(this),
    });

    console.log(`🚀 Agent server running on http://localhost:${this.port}`);
    console.log(`📊 Health check: http://localhost:${this.port}/health`);
    console.log(`🔐 Capability registry: ${this.policy.listCapabilities().length} capabilities loaded`);
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
      
      if (path === "/mcp/status" && method === "GET") {
        return this.handleGetMCPStatus();
      }
      
      if (path.startsWith("/mcp/servers/") && path.endsWith("/remove") && method === "DELETE") {
        const serverName = path.split("/")[3];
        return this.handleRemoveMCPServer(serverName);
      }
      
      if (path === "/capabilities" && method === "GET") {
        return this.handleGetCapabilities();
      }
      
      if (path === "/capabilities" && method === "POST") {
        return this.handleAddCapability(request);
      }
      
      if (path.startsWith("/capabilities/") && method === "GET") {
        const capabilityId = path.split("/")[2];
        return this.handleGetCapability(capabilityId);
      }
      
      if (path.startsWith("/capabilities/") && method === "PUT") {
        const capabilityId = path.split("/")[2];
        return this.handleUpdateCapability(capabilityId, request);
      }
      
      if (path.startsWith("/capabilities/") && method === "DELETE") {
        const capabilityId = path.split("/")[2];
        return this.handleDeleteCapability(capabilityId);
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
        ...this.mcpAgent.getDetailedStatus(),
        initialization_errors: Object.fromEntries(this.mcpAgent.getInitializationErrors()),
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
      const rows = this.db.all("SELECT * FROM plans ORDER BY timestamp DESC LIMIT 50");
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
      const rows = this.db.all("SELECT * FROM plans WHERE id = ?", planId);
      
      if (!rows || rows.length === 0) {
        return new Response(JSON.stringify({ error: "Plan not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }
      
      return new Response(JSON.stringify(rows[0]), {
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
    try {
      // Fetch the plan from database
      const planRows = this.db.all("SELECT * FROM plans WHERE id = ?", planId);
      
      if (!planRows || planRows.length === 0) {
        return new Response(JSON.stringify({ error: "Plan not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }
      
      const planRow = planRows[0];

      // Parse the plan
      const plan = {
        id: planRow.id,
        prompt_id: planRow.prompt_id,
        steps: JSON.parse(planRow.steps),
        timestamp: planRow.timestamp,
        status: planRow.status
      };

      // Check if plan is already executing or completed
      if (plan.status === "executing") {
        return new Response(JSON.stringify({
          plan_id: planId,
          status: "already_executing",
          message: "Plan is already being executed",
        }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      if (plan.status === "completed") {
        return new Response(JSON.stringify({
          plan_id: planId,
          status: "already_completed",
          message: "Plan has already been completed",
        }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      // Update plan status to executing
      await this.updatePlanStatus(planId, "executing");

      // Execute the plan
      const executionResult = await this.executePlan(plan);

      // Update final plan status
      const finalStatus = executionResult.success ? "completed" : "failed";
      await this.updatePlanStatus(planId, finalStatus);

      return new Response(JSON.stringify({
        plan_id: planId,
        status: finalStatus,
        total_steps: plan.steps.length,
        executed_steps: executionResult.executedSteps,
        failed_steps: executionResult.failedSteps,
        events: executionResult.events,
        error: executionResult.error
      }), {
        headers: { "Content-Type": "application/json" },
      });

    } catch (error) {
      // Mark plan as failed if it exists
      try {
        await this.updatePlanStatus(planId, "failed");
      } catch (updateError) {
        console.error("Failed to update plan status:", updateError);
      }

      return new Response(JSON.stringify({
        plan_id: planId,
        status: "failed",
        error: error instanceof Error ? error.message : "Plan execution failed",
      }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  private async handleGetEntities(): Promise<Response> {
    try {
      const rows = this.db.all("SELECT * FROM entities ORDER BY timestamp DESC LIMIT 50");
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
      const rows = this.db.all("SELECT * FROM events ORDER BY timestamp DESC LIMIT 100");
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
      this.db.run(
        "INSERT INTO prompts (id, content, timestamp, metadata) VALUES (?, ?, ?, ?)",
        prompt.id, prompt.content, prompt.timestamp, JSON.stringify(prompt.metadata)
      );
    } catch (err) {
      throw new Error(`Failed to store prompt: ${err}`);
    }
  }

  private async storePlan(plan: Plan): Promise<void> {
    try {
      this.db.run(
        "INSERT INTO plans (id, prompt_id, steps, timestamp, status) VALUES (?, ?, ?, ?, ?)",
        plan.id, plan.prompt_id, JSON.stringify(plan.steps), plan.timestamp, plan.status
      );
    } catch (err) {
      throw new Error(`Failed to store plan: ${err}`);
    }
  }

  private async updatePlanStatus(planId: string, status: string): Promise<void> {
    try {
      this.db.run("UPDATE plans SET status = ? WHERE id = ?", status, planId);
    } catch (err) {
      throw new Error(`Failed to update plan status: ${err}`);
    }
  }

  private async executePlan(plan: any): Promise<{
    success: boolean;
    executedSteps: number;
    failedSteps: number;
    events: any[];
    error?: string;
  }> {
    const events: any[] = [];
    let executedSteps = 0;
    let failedSteps = 0;
    const stepResults = new Map<number, any>();

    try {
      // Execute steps in dependency order
      const sortedSteps = this.topologicalSort(plan.steps);
      
      for (const stepIndex of sortedSteps) {
        const step = plan.steps[stepIndex];
        
        try {
          // Resolve dependencies by getting results from previous steps
          const context = this.buildStepContext(step, stepResults);
          
          // Validate step capabilities before execution
          const violations = await this.policy.validateStep(step, []);
          if (violations.length > 0) {
            throw new Error(`Capability violations: ${violations.map((v: any) => v.message).join(', ')}`);
          }

          // Execute the step using ExecutorAgent
          const executorRequest = { step, context };
          const executorResponse = await this.executor.executeStep(executorRequest);
          
          if (executorResponse.error) {
            throw new Error(executorResponse.error);
          }

          // Store step result
          stepResults.set(stepIndex, executorResponse.result);
          
          // Store any entities created by this step
          if (executorResponse.entities) {
            for (const entity of executorResponse.entities) {
              await this.storeEntity(entity);
            }
          }

          // Create event record
          const event = {
            id: crypto.randomUUID(),
            plan_id: plan.id,
            step_index: stepIndex,
            op: step.op,
            produces: executorResponse.entities?.map(e => e.id) || [],
            consumes: this.getConsumedEntities(step, context),
            result: executorResponse.result,
            timestamp: new Date().toISOString(),
          };

          await this.storeEvent(event);
          events.push(event);
          executedSteps++;

        } catch (stepError) {
          failedSteps++;
          
          // Create error event
          const errorEvent = {
            id: crypto.randomUUID(),
            plan_id: plan.id,
            step_index: stepIndex,
            op: step.op,
            produces: [],
            consumes: [],
            result: null,
            error: stepError instanceof Error ? stepError.message : String(stepError),
            timestamp: new Date().toISOString(),
          };

          await this.storeEvent(errorEvent);
          events.push(errorEvent);
          
          // Stop execution on first failure
          throw stepError;
        }
      }

      return {
        success: true,
        executedSteps,
        failedSteps,
        events,
      };

    } catch (error) {
      return {
        success: false,
        executedSteps,
        failedSteps,
        events,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private topologicalSort(steps: any[]): number[] {
    const visited = new Set<number>();
    const result: number[] = [];
    const visiting = new Set<number>();

    const visit = (index: number) => {
      if (visiting.has(index)) {
        throw new Error(`Circular dependency detected involving step ${index}`);
      }
      if (visited.has(index)) {
        return;
      }

      visiting.add(index);
      
      // Visit dependencies first
      const step = steps[index];
      if (step.deps) {
        for (const depIndex of step.deps) {
          if (depIndex >= steps.length) {
            throw new Error(`Invalid dependency: step ${index} depends on non-existent step ${depIndex}`);
          }
          visit(depIndex);
        }
      }

      visiting.delete(index);
      visited.add(index);
      result.push(index);
    };

    // Visit all steps
    for (let i = 0; i < steps.length; i++) {
      visit(i);
    }

    return result;
  }

  private buildStepContext(step: any, stepResults: Map<number, any>): any {
    const context: any = {};
    
    // Add results from dependent steps
    if (step.deps) {
      for (const depIndex of step.deps) {
        const depResult = stepResults.get(depIndex);
        if (depResult !== undefined) {
          context[`step${depIndex}.result`] = depResult;
        }
      }
    }

    return context;
  }

  private getConsumedEntities(step: any, context: any): string[] {
    const consumed: string[] = [];
    
    // Extract entity IDs from step arguments and context
    const extractEntityIds = (obj: any): void => {
      if (typeof obj === 'string' && obj.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
        consumed.push(obj);
      } else if (typeof obj === 'object' && obj !== null) {
        Object.values(obj).forEach(extractEntityIds);
      }
    };

    extractEntityIds(step.args);
    extractEntityIds(context);

    return consumed;
  }

  private async storeEntity(entity: Entity): Promise<void> {
    try {
      this.db.run(
        "INSERT INTO entities (id, content, embedding, capabilities, metadata, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
        entity.id,
        entity.content,
        entity.embedding || null,
        JSON.stringify(entity.capabilities),
        JSON.stringify(entity.metadata),
        entity.timestamp
      );
    } catch (err) {
      throw new Error(`Failed to store entity: ${err}`);
    }
  }

  private async storeEvent(event: Event): Promise<void> {
    try {
      this.db.run(
        "INSERT INTO events (id, plan_id, step_index, op, produces, consumes, result, error, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        event.id,
        event.plan_id,
        event.step_index,
        event.op,
        JSON.stringify(event.produces),
        JSON.stringify(event.consumes),
        event.result ? JSON.stringify(event.result) : null,
        event.error,
        event.timestamp
      );
    } catch (err) {
      throw new Error(`Failed to store event: ${err}`);
    }
  }

  private async handleGetMCPServers(): Promise<Response> {
    const servers = this.mcpAgent.getServerNames();
    return new Response(JSON.stringify({ servers }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  private async handleAddMCPServer(request: Request): Promise<Response> {
    let serverName: string | undefined;
    let validationErrors: string[] = [];
    
    try {
      // Parse and validate request body
      const body = await request.json();
      const validationResult = this.validateMCPServerConfig(body);
      
      if (!validationResult.isValid) {
        return new Response(JSON.stringify({ 
          error: "Invalid MCP server configuration",
          details: validationResult.errors,
          received_config: body
        }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      const { name, command, args, env } = validationResult.config;
      serverName = name;

      // Check if server already exists
      const existingServers = this.mcpAgent.getServerNames();
      if (existingServers.includes(name)) {
        return new Response(JSON.stringify({
          error: `MCP server '${name}' already exists`,
          existing_servers: existingServers,
          suggestion: "Use a different name or remove the existing server first"
        }), {
          status: 409,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Pre-flight validation - check if command exists
      const commandValidation = await this.validateMCPCommand(command, args);
      if (!commandValidation.isValid) {
        return new Response(JSON.stringify({
          error: `Command validation failed for '${command}'`,
          details: commandValidation.errors,
          suggestion: "Ensure the MCP server executable is installed and accessible"
        }), {
          status: 422,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Capture pre-addition state for rollback
      const preAdditionState = {
        serverNames: [...existingServers],
        toolCount: this.mcpAgent.getMCPTools().length,
        capabilityCount: this.policy.listCapabilities().length
      };

      console.log(`🔄 Adding MCP server '${name}' with command '${command}'...`);
      
      // Attempt to add server with timeout
      const addServerResult = await this.addMCPServerWithTimeout(
        { name, command, args, env }, 
        30000 // 30 second timeout
      );

      if (!addServerResult.success) {
        throw new Error(addServerResult.error || "Server addition failed");
      }

      // Verify server was added successfully
      const postAdditionState = await this.verifyMCPServerAddition(name, preAdditionState);
      
      if (!postAdditionState.success) {
        // Rollback the addition
        await this.rollbackMCPServerAddition(name, preAdditionState);
        throw new Error(postAdditionState.error || "Server verification failed");
      }

      // Update capability registry with new MCP capabilities
      try {
        await this.refreshMCPCapabilities();
      } catch (capError) {
        console.warn(`Failed to refresh MCP capabilities after adding ${name}:`, capError);
        // Don't fail the whole operation for capability refresh issues
      }

      console.log(`✅ MCP server '${name}' added successfully`);
      
      return new Response(JSON.stringify({ 
        success: true, 
        message: `MCP server '${name}' added successfully`,
        server_info: {
          name,
          command,
          tools_loaded: this.mcpAgent.getMCPTools().filter(tool => tool.server_name === name).length,
          status: "connected"
        },
        summary: {
          total_servers: this.mcpAgent.getServerNames().length,
          total_tools: this.mcpAgent.getMCPTools().length
        }
      }), {
        headers: { "Content-Type": "application/json" },
      });

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Failed to add MCP server";
      console.error(`❌ Failed to add MCP server ${serverName || 'unknown'}:`, error);

      // Attempt cleanup if we have a server name
      if (serverName) {
        try {
          await this.mcpAgent.removeServer(serverName);
          console.log(`🧹 Cleaned up failed server addition: ${serverName}`);
        } catch (cleanupError) {
          console.error(`Failed to cleanup server ${serverName}:`, cleanupError);
        }
      }

      return new Response(JSON.stringify({ 
        error: errorMessage,
        server_name: serverName,
        troubleshooting: {
          common_issues: [
            "MCP server executable not found in PATH",
            "Incorrect command arguments",
            "Permission denied",
            "Server crashed during initialization"
          ],
          suggestions: [
            "Verify the MCP server is installed correctly",
            "Check command and arguments are valid",
            "Ensure proper permissions for the executable",
            "Review server logs for specific error details"
          ]
        }
      }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  private validateMCPServerConfig(body: any): { 
    isValid: boolean; 
    config?: any; 
    errors: string[] 
  } {
    const errors: string[] = [];
    
    // Check required fields
    if (!body.name || typeof body.name !== 'string') {
      errors.push("Field 'name' is required and must be a string");
    } else if (body.name.trim() === '') {
      errors.push("Field 'name' cannot be empty");
    } else if (!/^[a-zA-Z0-9_-]+$/.test(body.name)) {
      errors.push("Field 'name' can only contain alphanumeric characters, hyphens, and underscores");
    }
    
    if (!body.command || typeof body.command !== 'string') {
      errors.push("Field 'command' is required and must be a string");
    } else if (body.command.trim() === '') {
      errors.push("Field 'command' cannot be empty");
    }
    
    if (!body.args || !Array.isArray(body.args)) {
      errors.push("Field 'args' is required and must be an array");
    } else {
      // Validate each argument is a string
      for (let i = 0; i < body.args.length; i++) {
        if (typeof body.args[i] !== 'string') {
          errors.push(`Argument at index ${i} must be a string`);
        }
      }
    }
    
    // Optional env validation
    if (body.env && typeof body.env !== 'object') {
      errors.push("Field 'env' must be an object");
    } else if (body.env) {
      for (const [key, value] of Object.entries(body.env)) {
        if (typeof value !== 'string') {
          errors.push(`Environment variable '${key}' must be a string`);
        }
      }
    }
    
    if (errors.length > 0) {
      return { isValid: false, errors };
    }
    
    return {
      isValid: true,
      config: {
        name: body.name.trim(),
        command: body.command.trim(),
        args: body.args,
        env: body.env || {}
      },
      errors: []
    };
  }

  private async validateMCPCommand(command: string, args: string[]): Promise<{
    isValid: boolean;
    errors: string[];
  }> {
    const errors: string[] = [];
    
    try {
      // Try to spawn the command with --help to see if it exists
      const { spawn } = require('child_process');
      
      return new Promise((resolve) => {
        const child = spawn(command, ['--help'], {
          stdio: 'pipe',
          timeout: 5000 // 5 second timeout for validation
        });
        
        let hasOutput = false;
        
        child.stdout.on('data', () => {
          hasOutput = true;
        });
        
        child.stderr.on('data', () => {
          hasOutput = true;
        });
        
        child.on('close', (code) => {
          if (hasOutput || code === 0) {
            resolve({ isValid: true, errors: [] });
          } else {
            resolve({
              isValid: false,
              errors: [`Command '${command}' returned exit code ${code}`]
            });
          }
        });
        
        child.on('error', (error: any) => {
          if (error.code === 'ENOENT') {
            resolve({
              isValid: false,
              errors: [`Command '${command}' not found in PATH`]
            });
          } else {
            resolve({
              isValid: false,
              errors: [`Command validation failed: ${error.message}`]
            });
          }
        });
        
        // Timeout handler
        setTimeout(() => {
          child.kill();
          resolve({
            isValid: false,
            errors: [`Command '${command}' validation timed out`]
          });
        }, 5000);
      });
      
    } catch (error) {
      return {
        isValid: false,
        errors: [`Command validation error: ${error}`]
      };
    }
  }

  private async addMCPServerWithTimeout(
    config: any, 
    timeoutMs: number
  ): Promise<{ success: boolean; error?: string }> {
    return new Promise(async (resolve) => {
      const timeout = setTimeout(() => {
        resolve({
          success: false,
          error: `Server addition timed out after ${timeoutMs}ms`
        });
      }, timeoutMs);
      
      try {
        await this.mcpAgent.addServer(config);
        clearTimeout(timeout);
        resolve({ success: true });
      } catch (error) {
        clearTimeout(timeout);
        resolve({
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    });
  }

  private async verifyMCPServerAddition(
    serverName: string, 
    preState: any
  ): Promise<{ success: boolean; error?: string }> {
    try {
      // Check if server appears in server list
      const currentServers = this.mcpAgent.getServerNames();
      if (!currentServers.includes(serverName)) {
        return {
          success: false,
          error: `Server '${serverName}' not found in active servers list`
        };
      }
      
      // Check if tools were loaded
      const currentTools = this.mcpAgent.getMCPTools();
      const serverTools = currentTools.filter(tool => tool.server_name === serverName);
      
      // Try a health check on the specific server
      const healthCheck = await this.mcpAgent.healthCheck();
      if (!healthCheck) {
        return {
          success: false,
          error: `Health check failed after adding server '${serverName}'`
        };
      }
      
      console.log(`✅ Server '${serverName}' verification passed (${serverTools.length} tools loaded)`);
      return { success: true };
      
    } catch (error) {
      return {
        success: false,
        error: `Verification failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      };
    }
  }

  private async rollbackMCPServerAddition(
    serverName: string, 
    preState: any
  ): Promise<void> {
    try {
      console.log(`🔄 Rolling back addition of server '${serverName}'...`);
      
      // Remove the server
      await this.mcpAgent.removeServer(serverName);
      
      // Verify rollback
      const currentServers = this.mcpAgent.getServerNames();
      if (currentServers.includes(serverName)) {
        console.warn(`⚠️  Server '${serverName}' still present after rollback attempt`);
      } else {
        console.log(`✅ Successfully rolled back server '${serverName}'`);
      }
      
    } catch (error) {
      console.error(`❌ Rollback failed for server '${serverName}':`, error);
      // Don't throw here - we're already in an error state
    }
  }

  private async refreshMCPCapabilities(): Promise<void> {
    try {
      // Remove old MCP capabilities that no longer exist
      const currentCapabilities = this.policy.listCapabilities();
      const currentMCPCapabilities = currentCapabilities.filter(cap => cap.id.startsWith('MCP_TOOL:'));
      const newMCPCapabilities = this.mcpAgent.getRequiredCapabilities();
      const newMCPIds = new Set(newMCPCapabilities.map(cap => cap.id));
      
      // Remove obsolete MCP capabilities
      for (const oldCap of currentMCPCapabilities) {
        if (!newMCPIds.has(oldCap.id)) {
          await this.policy.removeCapability(oldCap.id);
          console.log(`🗑️ Removed obsolete MCP capability: ${oldCap.id}`);
        }
      }
      
      // Add new MCP capabilities
      for (const capability of newMCPCapabilities) {
        const existing = this.policy.getCapability(capability.id);
        if (!existing) {
          await this.policy.addCapability({
            ...capability,
            is_system: false,
            metadata: { source: "mcp", auto_generated: true }
          } as any, true);
          console.log(`🔌 Added new MCP capability: ${capability.id}`);
        }
      }
    } catch (error) {
      console.error("Failed to refresh MCP capabilities:", error);
      // Don't throw here as this is often called during error recovery
    }
  }

  private async handleGetMCPTools(): Promise<Response> {
    const tools = this.mcpAgent.getMCPTools();
    return new Response(JSON.stringify({ tools }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  private async handleGetMCPStatus(): Promise<Response> {
    try {
      const status = this.mcpAgent.getDetailedStatus();
      const errors = this.mcpAgent.getInitializationErrors();
      const serverStatuses = this.mcpAgent.getAllServerStatuses();
      
      return new Response(JSON.stringify({
        ...status,
        initialization_errors: Object.fromEntries(errors),
        server_statuses: Object.fromEntries(serverStatuses),
        last_health_check: new Date().toISOString()
      }), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      return new Response(JSON.stringify({
        error: error instanceof Error ? error.message : "Failed to get MCP status"
      }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  private async handleRemoveMCPServer(serverName: string): Promise<Response> {
    try {
      if (!serverName || serverName.trim() === '') {
        return new Response(JSON.stringify({
          error: "Server name is required"
        }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      const existingServers = this.mcpAgent.getServerNames();
      if (!existingServers.includes(serverName)) {
        return new Response(JSON.stringify({
          error: `MCP server '${serverName}' not found`,
          available_servers: existingServers
        }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }

      console.log(`🔄 Removing MCP server '${serverName}'...`);
      
      // Capture pre-removal state
      const preRemovalToolCount = this.mcpAgent.getMCPTools().filter(tool => tool.server_name === serverName).length;
      
      await this.mcpAgent.removeServer(serverName);
      
      // Refresh capabilities after removal
      await this.refreshMCPCapabilities();
      
      console.log(`✅ MCP server '${serverName}' removed successfully`);
      
      return new Response(JSON.stringify({
        success: true,
        message: `MCP server '${serverName}' removed successfully`,
        removed_tools: preRemovalToolCount,
        summary: {
          total_servers: this.mcpAgent.getServerNames().length,
          total_tools: this.mcpAgent.getMCPTools().length
        }
      }), {
        headers: { "Content-Type": "application/json" },
      });

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Failed to remove MCP server";
      console.error(`❌ Failed to remove MCP server ${serverName}:`, error);

      return new Response(JSON.stringify({
        error: errorMessage,
        server_name: serverName
      }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  private async handleGetCapabilities(): Promise<Response> {
    try {
      const capabilities = this.policy.listCapabilities();
      
      // Group capabilities by type and add metadata
      const response = {
        total: capabilities.length,
        capabilities: capabilities.map(cap => ({
          ...cap,
          is_system: (cap as any).is_system || false,
          created_at: (cap as any).created_at,
          updated_at: (cap as any).updated_at,
          metadata: (cap as any).metadata || {}
        })),
        summary: {
          tool_capabilities: capabilities.filter(c => c.kind === 'ToolCap').length,
          data_capabilities: capabilities.filter(c => c.kind === 'DataCap').length,
          system_capabilities: capabilities.filter(c => (c as any).is_system).length,
          custom_capabilities: capabilities.filter(c => !(c as any).is_system).length
        }
      };
      
      return new Response(JSON.stringify(response), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      return new Response(JSON.stringify({
        error: error instanceof Error ? error.message : "Failed to get capabilities"
      }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  private async handleGetCapability(capabilityId: string): Promise<Response> {
    try {
      const capability = this.policy.getCapability(decodeURIComponent(capabilityId));
      
      if (!capability) {
        return new Response(JSON.stringify({
          error: `Capability '${capabilityId}' not found`
        }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }
      
      return new Response(JSON.stringify({
        ...capability,
        is_system: (capability as any).is_system || false,
        created_at: (capability as any).created_at,
        updated_at: (capability as any).updated_at,
        metadata: (capability as any).metadata || {}
      }), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      return new Response(JSON.stringify({
        error: error instanceof Error ? error.message : "Failed to get capability"
      }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  private async handleAddCapability(request: Request): Promise<Response> {
    try {
      const body = await request.json();
      const { id, kind, scope, description, metadata = {} } = body;

      // Validation
      if (!id || typeof id !== 'string') {
        return new Response(JSON.stringify({
          error: "Field 'id' is required and must be a string"
        }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (!kind || !["ToolCap", "DataCap"].includes(kind)) {
        return new Response(JSON.stringify({
          error: "Field 'kind' is required and must be 'ToolCap' or 'DataCap'"
        }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (!scope || typeof scope !== 'string') {
        return new Response(JSON.stringify({
          error: "Field 'scope' is required and must be a string"
        }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Check if capability already exists
      const existing = this.policy.getCapability(id);
      if (existing) {
        return new Response(JSON.stringify({
          error: `Capability '${id}' already exists`,
          suggestion: "Use PUT to update existing capabilities"
        }), {
          status: 409,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Create capability
      const capability = {
        id,
        kind,
        scope,
        description: description || null,
        is_system: false, // Custom capabilities are never system capabilities
        metadata: {
          ...metadata,
          created_by: "api",
          created_at: new Date().toISOString()
        }
      };

      await this.policy.addCapability(capability as any, true);

      console.log(`✅ Added custom capability: ${id}`);

      return new Response(JSON.stringify({
        success: true,
        message: `Capability '${id}' added successfully`,
        capability: {
          ...capability,
          created_at: new Date().toISOString()
        }
      }), {
        headers: { "Content-Type": "application/json" },
      });

    } catch (error) {
      return new Response(JSON.stringify({
        error: error instanceof Error ? error.message : "Failed to add capability"
      }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  private async handleUpdateCapability(capabilityId: string, request: Request): Promise<Response> {
    try {
      const decodedId = decodeURIComponent(capabilityId);
      const existing = this.policy.getCapability(decodedId);
      
      if (!existing) {
        return new Response(JSON.stringify({
          error: `Capability '${decodedId}' not found`
        }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Check if it's a system capability
      if ((existing as any).is_system) {
        return new Response(JSON.stringify({
          error: `Cannot update system capability '${decodedId}'`,
          suggestion: "System capabilities can only be modified through code updates"
        }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        });
      }

      const body = await request.json();
      const { kind, scope, description, metadata = {} } = body;

      // Validate kind if provided
      if (kind && !["ToolCap", "DataCap"].includes(kind)) {
        return new Response(JSON.stringify({
          error: "Field 'kind' must be 'ToolCap' or 'DataCap'"
        }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Update capability
      const updatedCapability = {
        ...existing,
        kind: kind || existing.kind,
        scope: scope || existing.scope,
        description: description !== undefined ? description : existing.description,
        metadata: {
          ...(existing as any).metadata || {},
          ...metadata,
          updated_by: "api",
          updated_at: new Date().toISOString()
        }
      };

      await this.policy.updateCapability(updatedCapability);

      console.log(`✅ Updated capability: ${decodedId}`);

      return new Response(JSON.stringify({
        success: true,
        message: `Capability '${decodedId}' updated successfully`,
        capability: updatedCapability
      }), {
        headers: { "Content-Type": "application/json" },
      });

    } catch (error) {
      return new Response(JSON.stringify({
        error: error instanceof Error ? error.message : "Failed to update capability"
      }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  private async handleDeleteCapability(capabilityId: string): Promise<Response> {
    try {
      const decodedId = decodeURIComponent(capabilityId);
      const existing = this.policy.getCapability(decodedId);
      
      if (!existing) {
        return new Response(JSON.stringify({
          error: `Capability '${decodedId}' not found`
        }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Check if it's a system capability
      if ((existing as any).is_system) {
        return new Response(JSON.stringify({
          error: `Cannot delete system capability '${decodedId}'`,
          suggestion: "System capabilities are required for core functionality"
        }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        });
      }

      const wasRemoved = await this.policy.removeCapability(decodedId);

      if (wasRemoved) {
        console.log(`🗑️ Deleted capability: ${decodedId}`);
        
        return new Response(JSON.stringify({
          success: true,
          message: `Capability '${decodedId}' deleted successfully`
        }), {
          headers: { "Content-Type": "application/json" },
        });
      } else {
        return new Response(JSON.stringify({
          error: `Failed to delete capability '${decodedId}'`
        }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }

    } catch (error) {
      return new Response(JSON.stringify({
        error: error instanceof Error ? error.message : "Failed to delete capability"
      }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
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