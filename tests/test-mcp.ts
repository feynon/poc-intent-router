#!/usr/bin/env bun
import { MCPAgent, defaultMCPConfig } from "../agents/mcp-agent.js";

async function testMCPIntegration() {
  console.log("🧪 Testing MCP Integration...");
  
  const mcpAgent = new MCPAgent(defaultMCPConfig);
  
  try {
    // Initialize the MCP agent
    await mcpAgent.initialize();
    
    // Check health
    const healthy = await mcpAgent.healthCheck();
    console.log(`Health check: ${healthy ? "✅ Healthy" : "❌ Unhealthy"}`);
    
    // List available servers
    const servers = mcpAgent.getServerNames();
    console.log(`Connected servers: ${servers.join(", ")}`);
    
    // List available tools
    const tools = mcpAgent.getMCPTools();
    console.log(`Available tools: ${tools.map(t => t.name).join(", ")}`);
    
    // Test a filesystem tool if available
    const readFilesTool = tools.find(t => t.name === "read_file");
    if (readFilesTool) {
      console.log("🔍 Testing read_file tool...");
      try {
        const result = await mcpAgent.callTool("read_file", {
          path: "test-mcp-files/sample.txt"
        });
        console.log("📄 File read result:", result);
      } catch (error) {
        console.error("❌ Failed to read file:", error);
      }
    }
    
    // Test list directory if available
    const listDirTool = tools.find(t => t.name === "list_directory");
    if (listDirTool) {
      console.log("📁 Testing list_directory tool...");
      try {
        const result = await mcpAgent.callTool("list_directory", {
          path: "test-mcp-files"
        });
        console.log("📂 Directory listing:", result);
      } catch (error) {
        console.error("❌ Failed to list directory:", error);
      }
    }
    
    // Test write file 
    const writeFileTool = tools.find(t => t.name === "write_file");
    if (writeFileTool) {
      console.log("✍️ Testing write_file tool...");
      try {
        const result = await mcpAgent.callTool("write_file", {
          path: "test-mcp-files/test-output.txt",
          content: "Hello from MCP write test!"
        });
        console.log("📝 File write result:", result);
      } catch (error) {
        console.error("❌ Failed to write file:", error);
      }
    }
    
    console.log("✅ MCP integration test completed successfully!");
    
  } catch (error) {
    console.error("❌ MCP integration test failed:", error);
  } finally {
    await mcpAgent.shutdown();
  }
}

// Run the test
testMCPIntegration().catch(console.error);