import { Anthropic } from "@anthropic-ai/sdk";
import { ExecutorRequest, ExecutorResponse, Step, Entity, Event } from "./types.js";
import { MCPAgent } from "./mcp-agent.js";
import { render, SystemMessage, UserMessage, PromptElement } from "@anysphere/priompt";

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: any;
  handler: (args: any, context: any) => Promise<any>;
  required_capabilities: string[];
}

export class ExecutorAgent {
  private anthropic: Anthropic;
  private tools: Map<string, ToolDefinition> = new Map();
  private model: string;
  private mcpAgent?: MCPAgent;

  constructor(apiKey: string, model: string = "claude-3-5-sonnet-20241022", mcpAgent?: MCPAgent) {
    this.anthropic = new Anthropic({ apiKey });
    this.model = model;
    this.mcpAgent = mcpAgent;
    this.registerDefaultTools();
    
    // Register MCP tools if MCP agent is provided
    if (this.mcpAgent) {
      this.registerMCPTools();
    }
  }

  registerTool(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  private registerMCPTools(): void {
    if (!this.mcpAgent) {
      return;
    }

    const mcpTools = this.mcpAgent.getAvailableTools();
    for (const tool of mcpTools) {
      this.registerTool(tool);
    }
    
    console.log(`📦 Registered ${mcpTools.length} MCP tools`);
  }

  getToolRegistry(): Record<string, string[]> {
    const registry: Record<string, string[]> = {};
    for (const [name, tool] of this.tools) {
      registry[name] = tool.required_capabilities;
    }
    return registry;
  }

  async executeStep(request: ExecutorRequest): Promise<ExecutorResponse> {
    const { step, context } = request;

    try {
      // Get the tool definition
      const tool = this.tools.get(step.op);
      if (!tool) {
        throw new Error(`Unknown operation: ${step.op}`);
      }

      // Prepare messages for Claude
      const messages = this.buildMessages(step, context);
      
      // Get available tools for Claude
      const claudeTools = this.getClaudeTools([tool]);

      // Call Claude
      const response = await this.anthropic.messages.create({
        model: this.model,
        max_tokens: 4096,
        messages,
        tools: claudeTools,
      });

      // Process the response
      const result = await this.processClaudeResponse(response, step, context);

      return {
        result: result.output,
        entities: result.entities,
      };

    } catch (error) {
      return {
        result: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private buildMessages(step: Step, context: any): Anthropic.MessageParam[] {
    // Use Priompt to create a structured prompt with priority-based token inclusion
    const promptElement = this.buildExecutorPrompt(step, context);
    
    const renderedPrompt = render(promptElement, {
      tokenLimit: 8000 // Adjust based on model's context limit
    });
    
    return [
      {
        role: "user",
        content: renderedPrompt.toString(),
      },
    ];
  }

  private buildExecutorPrompt(step: Step, context: any): PromptElement {
    const elements: PromptElement[] = [];
    
    // Core system instructions (highest priority)
    elements.push(SystemMessage({
      p: 10,
      children: `You are an executor agent in an agentic system. 
You will receive a step to execute with specific arguments and context.
Use the provided tools to complete the operation efficiently and accurately.`
    }));
    
    // Operation details (high priority)
    elements.push(SystemMessage({
      p: 9,
      children: `Operation: ${step.op}
Arguments: ${JSON.stringify(step.args, null, 2)}`
    }));
    
    // Context information (medium priority - may be truncated if context is large)
    if (context && Object.keys(context).length > 0) {
      elements.push(SystemMessage({
        p: 6,
        children: `Context: ${JSON.stringify(context, null, 2)}`
      }));
    }
    
    // Tool capabilities (medium priority)
    elements.push(SystemMessage({
      p: 7,
      children: `Required capabilities for this operation: ${step.tool_caps.join(', ')}`
    }));
    
    // Data capabilities (lower priority)
    if (step.data_caps && step.data_caps.length > 0) {
      elements.push(SystemMessage({
        p: 5,
        children: `Data capabilities: ${step.data_caps.join(', ')}`
      }));
    }
    
    // Final instruction (high priority)
    elements.push(UserMessage({
      p: 8,
      children: "Execute this operation and return the result."
    }));
    
    return elements;
  }

  private getClaudeTools(tools: ToolDefinition[]): Anthropic.Tool[] {
    return tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema,
    }));
  }

  private async processClaudeResponse(
    response: Anthropic.Message,
    step: Step,
    context: any
  ): Promise<{ output: any; entities: Entity[] }> {
    const entities: Entity[] = [];
    let output: any = null;

    // Process text content
    const textContent = response.content
      .filter(block => block.type === "text")
      .map(block => block.text)
      .join("\n");

    if (textContent) {
      output = textContent;
    }

    // Process tool use
    for (const block of response.content) {
      if (block.type === "tool_use") {
        const tool = this.tools.get(block.name);
        if (tool) {
          try {
            const toolResult = await tool.handler(block.input, context);
            output = toolResult;

            // If the tool created entities, add them
            if (toolResult && typeof toolResult === "object" && toolResult.entities) {
              entities.push(...toolResult.entities);
            }
          } catch (error) {
            throw new Error(`Tool execution failed: ${error}`);
          }
        }
      }
    }

    return { output, entities };
  }

  private registerDefaultTools(): void {
    // Register default tools
    this.registerTool({
      name: "fetch_data",
      description: "Fetch data from various sources",
      input_schema: {
        type: "object",
        properties: {
          source: { type: "string", description: "Data source identifier" },
          query: { type: "string", description: "Query or filter parameters" },
        },
        required: ["source"],
      },
      handler: async (args, context) => {
        // Implement data fetching logic
        return {
          data: `Fetched data from ${args.source}`,
          timestamp: new Date().toISOString(),
        };
      },
      required_capabilities: ["READ_FILE"],
    });

    this.registerTool({
      name: "send_message",
      description: "Send messages via various channels",
      input_schema: {
        type: "object",
        properties: {
          channel: { type: "string", description: "Message channel (email, chat, etc.)" },
          to: { type: "string", description: "Recipient identifier" },
          subject: { type: "string", description: "Message subject" },
          content: { type: "string", description: "Message content" },
        },
        required: ["channel", "to", "content"],
      },
      handler: async (args, context) => {
        // Implement message sending logic
        return {
          message_id: crypto.randomUUID(),
          sent_at: new Date().toISOString(),
          status: "sent",
        };
      },
      required_capabilities: ["SEND_EMAIL"],
    });

    this.registerTool({
      name: "create_document",
      description: "Create new documents or content",
      input_schema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Document title" },
          content: { type: "string", description: "Document content" },
          format: { type: "string", description: "Document format" },
        },
        required: ["title", "content"],
      },
      handler: async (args, context) => {
        const entity: Entity = {
          id: crypto.randomUUID(),
          content: args.content,
          capabilities: ["share_with:team"],
          metadata: {
            title: args.title,
            format: args.format || "text",
            created_by: "executor",
          },
          timestamp: new Date().toISOString(),
        };

        return {
          document_id: entity.id,
          entities: [entity],
        };
      },
      required_capabilities: ["WRITE_FILE"],
    });

    this.registerTool({
      name: "search_entities",
      description: "Search existing entities by content",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          limit: { type: "number", description: "Maximum number of results" },
        },
        required: ["query"],
      },
      handler: async (args, context) => {
        // This would integrate with the vector search in the database
        return {
          results: [],
          query: args.query,
          total: 0,
        };
      },
      required_capabilities: ["READ_FILE"],
    });

    this.registerTool({
      name: "analyze_content",
      description: "Analyze or process content",
      input_schema: {
        type: "object",
        properties: {
          content: { type: "string", description: "Content to analyze" },
          analysis_type: { type: "string", description: "Type of analysis to perform" },
        },
        required: ["content", "analysis_type"],
      },
      handler: async (args, context) => {
        return {
          analysis: `Analyzed content of type: ${args.analysis_type}`,
          insights: [],
          timestamp: new Date().toISOString(),
        };
      },
      required_capabilities: [],
    });

    this.registerTool({
      name: "transform_data",
      description: "Transform data from one format to another",
      input_schema: {
        type: "object",
        properties: {
          data: { type: "any", description: "Data to transform" },
          from_format: { type: "string", description: "Source format" },
          to_format: { type: "string", description: "Target format" },
        },
        required: ["data", "from_format", "to_format"],
      },
      handler: async (args, context) => {
        return {
          transformed_data: args.data,
          from_format: args.from_format,
          to_format: args.to_format,
          timestamp: new Date().toISOString(),
        };
      },
      required_capabilities: [],
    });
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await this.anthropic.messages.create({
        model: this.model,
        max_tokens: 10,
        messages: [{ role: "user", content: "ping" }],
      });
      
      const anthropicHealthy = response.content.length > 0;
      const mcpHealthy = this.mcpAgent ? await this.mcpAgent.healthCheck() : true;
      
      return anthropicHealthy && mcpHealthy;
    } catch {
      return false;
    }
  }
}