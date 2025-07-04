import { MCPClient, MCPServerConfig } from "./mcp-client.js";
import { ToolDefinition } from "./executor.js";
import { Capability } from "./types.js";

export interface MCPAgentConfig {
  servers: MCPServerConfig[];
}

export class MCPAgent {
  private mcpClient: MCPClient;
  private isInitialized: boolean = false;
  private initializationErrors: Map<string, string> = new Map();
  private serverStatuses: Map<string, 'connecting' | 'connected' | 'failed' | 'disconnected'> = new Map();

  constructor(private config: MCPAgentConfig) {
    this.mcpClient = new MCPClient();
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    console.log("🚀 Initializing MCP Agent...");
    this.initializationErrors.clear();
    
    const initPromises = this.config.servers.map(async (serverConfig) => {
      try {
        this.serverStatuses.set(serverConfig.name, 'connecting');
        await this.mcpClient.addServer(serverConfig);
        this.serverStatuses.set(serverConfig.name, 'connected');
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.initializationErrors.set(serverConfig.name, errorMessage);
        this.serverStatuses.set(serverConfig.name, 'failed');
        console.error(`Failed to add MCP server ${serverConfig.name}:`, error);
        // Continue with other servers even if one fails
      }
    });

    // Wait for all initialization attempts to complete
    await Promise.allSettled(initPromises);

    this.isInitialized = true;
    
    const successCount = this.config.servers.length - this.initializationErrors.size;
    const totalCount = this.config.servers.length;
    
    if (this.initializationErrors.size > 0) {
      console.log(`⚠️  MCP Agent initialized with ${successCount}/${totalCount} servers successful`);
      console.log("Failed servers:", Array.from(this.initializationErrors.keys()));
    } else {
      console.log(`✅ MCP Agent initialized successfully (${successCount}/${totalCount} servers)`);
    }
  }

  async addServer(config: MCPServerConfig): Promise<void> {
    try {
      this.serverStatuses.set(config.name, 'connecting');
      await this.mcpClient.addServer(config);
      this.serverStatuses.set(config.name, 'connected');
      
      // Remove from initialization errors if it was previously failed
      if (this.initializationErrors.has(config.name)) {
        this.initializationErrors.delete(config.name);
      }
      
    } catch (error) {
      this.serverStatuses.set(config.name, 'failed');
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.initializationErrors.set(config.name, errorMessage);
      throw error;
    }
  }

  async removeServer(serverName: string): Promise<void> {
    try {
      this.serverStatuses.set(serverName, 'disconnected');
      await this.mcpClient.removeServer(serverName);
      
      // Clean up tracking data
      this.serverStatuses.delete(serverName);
      this.initializationErrors.delete(serverName);
      
    } catch (error) {
      this.serverStatuses.set(serverName, 'failed');
      throw error;
    }
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
    
    try {
      const result = await this.mcpClient.healthCheck();
      
      // Update server statuses based on health check
      for (const serverName of this.getServerNames()) {
        const currentStatus = this.serverStatuses.get(serverName);
        if (currentStatus === 'connected') {
          // Keep as connected if health check passes
          continue;
        } else if (currentStatus === 'failed') {
          // Try to re-establish connection status if health check passes overall
          if (result) {
            this.serverStatuses.set(serverName, 'connected');
          }
        }
      }
      
      return result;
    } catch (error) {
      console.error("Health check failed:", error);
      
      // Mark all servers as failed if health check fails
      for (const serverName of this.getServerNames()) {
        this.serverStatuses.set(serverName, 'failed');
      }
      
      return false;
    }
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

  // Get server status information
  getServerStatus(serverName: string): 'connecting' | 'connected' | 'failed' | 'disconnected' | 'unknown' {
    return this.serverStatuses.get(serverName) || 'unknown';
  }

  // Get all server statuses
  getAllServerStatuses(): Map<string, 'connecting' | 'connected' | 'failed' | 'disconnected'> {
    return new Map(this.serverStatuses);
  }

  // Get initialization errors
  getInitializationErrors(): Map<string, string> {
    return new Map(this.initializationErrors);
  }

  // Get detailed health status
  getDetailedStatus(): {
    isInitialized: boolean;
    totalServers: number;
    connectedServers: number;
    failedServers: number;
    serverDetails: Array<{
      name: string;
      status: string;
      error?: string;
      toolCount?: number;
    }>;
  } {
    const serverDetails = Array.from(this.serverStatuses.entries()).map(([name, status]) => ({
      name,
      status,
      error: this.initializationErrors.get(name),
      toolCount: this.getMCPTools().filter(tool => tool.server_name === name).length
    }));

    return {
      isInitialized: this.isInitialized,
      totalServers: this.serverStatuses.size,
      connectedServers: Array.from(this.serverStatuses.values()).filter(s => s === 'connected').length,
      failedServers: Array.from(this.serverStatuses.values()).filter(s => s === 'failed').length,
      serverDetails
    };
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