import { MCPClient, MCPServerConfig } from "./mcp-client.js";
import { ToolDefinition } from "./executor.js";
import { Capability } from "./types.js";

export interface MCPAgentConfig {
  servers: MCPServerConfig[];
}

export class MCPAgent {
  private mcpClient: MCPClient;
  private isInitialized: boolean = false;

  constructor(private config: MCPAgentConfig) {
    this.mcpClient = new MCPClient();
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    console.log("🚀 Initializing MCP Agent...");
    
    for (const serverConfig of this.config.servers) {
      try {
        await this.mcpClient.addServer(serverConfig);
      } catch (error) {
        console.error(`Failed to add MCP server ${serverConfig.name}:`, error);
        // Continue with other servers even if one fails
      }
    }

    this.isInitialized = true;
    console.log("✅ MCP Agent initialized");
  }

  async addServer(config: MCPServerConfig): Promise<void> {
    await this.mcpClient.addServer(config);
  }

  async removeServer(serverName: string): Promise<void> {
    await this.mcpClient.removeServer(serverName);
  }

  getAvailableTools(): ToolDefinition[] {
    if (!this.isInitialized) {
      return [];
    }
    return this.mcpClient.getExecutorToolDefinitions();
  }

  getRequiredCapabilities(): Capability[] {
    const serverNames = this.mcpClient.getServerNames();
    return serverNames.map(serverName => ({
      id: `MCP_TOOL:${serverName}`,
      kind: "ToolCap",
      scope: "mcp",
      description: `Access to MCP tools from ${serverName} server`
    }));
  }

  async healthCheck(): Promise<boolean> {
    if (!this.isInitialized) {
      return false;
    }
    return await this.mcpClient.healthCheck();
  }

  async shutdown(): Promise<void> {
    if (this.isInitialized) {
      await this.mcpClient.close();
      this.isInitialized = false;
      console.log("🔌 MCP Agent shutdown complete");
    }
  }

  // Get tool by name for direct access
  async callTool(toolName: string, args: unknown): Promise<unknown> {
    if (!this.isInitialized) {
      throw new Error("MCP Agent not initialized");
    }
    
    const result = await this.mcpClient.callTool(toolName, args);
    return result;
  }

  // Get available MCP tools with their server info
  getMCPTools() {
    return this.mcpClient.getAvailableTools();
  }

  // Get connected server names
  getServerNames(): string[] {
    return this.mcpClient.getServerNames();
  }
}

// Default configuration for common MCP servers
export const defaultMCPConfig: MCPAgentConfig = {
  servers: [
    // File system MCP server for testing
    {
      name: "filesystem",
      command: "mcp-server-filesystem",
      args: [process.cwd() + "/test-mcp-files"]
    }
  ]
};