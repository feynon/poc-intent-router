import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { 
  CallToolRequest, 
  CallToolResult, 
  ListToolsRequest, 
  Tool 
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ToolDefinition } from "./executor.js";

export interface MCPServerConfig {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface MCPTool extends Tool {
  server_name: string;
}

export class MCPClient {
  private clients: Map<string, Client> = new Map();
  private tools: Map<string, MCPTool> = new Map();
  private configs: Map<string, MCPServerConfig> = new Map();

  constructor() {}

  async addServer(config: MCPServerConfig): Promise<void> {
    try {
      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: config.env
      });

      const client = new Client(
        {
          name: "intent-router",
          version: "1.0.0",
        },
        {
          capabilities: {
            tools: {}
          }
        }
      );

      await client.connect(transport);
      
      this.clients.set(config.name, client);
      this.configs.set(config.name, config);
      
      // Load tools from the server
      await this.loadToolsFromServer(config.name);
      
      console.log(`✅ Connected to MCP server: ${config.name}`);
    } catch (error) {
      console.error(`❌ Failed to connect to MCP server ${config.name}:`, error);
      throw error;
    }
  }

  async removeServer(serverName: string): Promise<void> {
    const client = this.clients.get(serverName);
    if (client) {
      await client.close();
      this.clients.delete(serverName);
      this.configs.delete(serverName);
      
      // Remove tools from this server
      for (const [toolName, tool] of this.tools) {
        if (tool.server_name === serverName) {
          this.tools.delete(toolName);
        }
      }
      
      console.log(`🔌 Disconnected from MCP server: ${serverName}`);
    }
  }

  private async loadToolsFromServer(serverName: string): Promise<void> {
    const client = this.clients.get(serverName);
    if (!client) {
      throw new Error(`No client found for server: ${serverName}`);
    }

    try {
      const response = await client.listTools();
      
      if (response.tools) {
        for (const tool of response.tools) {
          const mcpTool: MCPTool = {
            ...tool,
            server_name: serverName
          };
          
          this.tools.set(tool.name, mcpTool);
        }
        
        console.log(`🔧 Loaded ${response.tools.length} tools from ${serverName}`);
      }
    } catch (error) {
      console.error(`Failed to load tools from ${serverName}:`, error);
      throw error;
    }
  }

  async callTool(toolName: string, args: unknown): Promise<CallToolResult> {
    const tool = this.tools.get(toolName);
    if (!tool) {
      throw new Error(`Tool not found: ${toolName}`);
    }

    const client = this.clients.get(tool.server_name);
    if (!client) {
      throw new Error(`No client found for server: ${tool.server_name}`);
    }

    try {
      const response = await client.callTool({
        name: toolName,
        arguments: args
      });
      return response;
    } catch (error) {
      console.error(`Tool call failed for ${toolName}:`, error);
      throw error;
    }
  }

  getAvailableTools(): MCPTool[] {
    return Array.from(this.tools.values());
  }

  getToolByName(name: string): MCPTool | undefined {
    return this.tools.get(name);
  }

  getServerNames(): string[] {
    return Array.from(this.clients.keys());
  }

  async healthCheck(): Promise<boolean> {
    try {
      // Check if all clients are connected
      for (const [serverName, client] of this.clients) {
        try {
          // Try to list tools as a health check
          await client.listTools();
        } catch (error) {
          console.error(`Health check failed for ${serverName}:`, error);
          return false;
        }
      }
      return true;
    } catch (error) {
      console.error("MCP health check failed:", error);
      return false;
    }
  }

  async close(): Promise<void> {
    const serverNames = Array.from(this.clients.keys());
    for (const serverName of serverNames) {
      await this.removeServer(serverName);
    }
  }

  // Convert MCP tools to executor tool definitions
  getExecutorToolDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map(mcpTool => ({
      name: mcpTool.name,
      description: mcpTool.description || `MCP tool from ${mcpTool.server_name}`,
      input_schema: mcpTool.inputSchema || {
        type: "object",
        properties: {},
        required: []
      },
      handler: async (args: any, context: any) => {
        const result = await this.callTool(mcpTool.name, args);
        return {
          mcp_result: result,
          server_name: mcpTool.server_name,
          tool_name: mcpTool.name,
        };
      },
      required_capabilities: [`MCP_TOOL:${mcpTool.server_name}`]
    }));
  }
}