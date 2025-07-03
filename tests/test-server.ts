#!/usr/bin/env bun
// Simple test to verify the server and MCP integration

console.log("🧪 Testing server endpoints...");

// Test health endpoint
try {
  const healthResponse = await fetch("http://localhost:3000/health");
  if (healthResponse.ok) {
    const health = await healthResponse.json();
    console.log("✅ Health endpoint working:");
    console.log(`- Status: ${health.status}`);
    console.log(`- Planner: ${health.services.planner}`);
    console.log(`- Executor: ${health.services.executor}`);
    console.log(`- MCP: ${health.services.mcp}`);
    console.log(`- Database: ${health.services.database}`);
    
    if (health.mcp && health.mcp.servers) {
      console.log(`- MCP Servers: ${health.mcp.servers.join(", ")}`);
      console.log(`- MCP Tools: ${health.mcp.tools.length} available`);
      health.mcp.tools.forEach((tool: any) => {
        console.log(`  - ${tool.name} (${tool.server}): ${tool.description}`);
      });
    }
  } else {
    console.log("❌ Health endpoint failed:", healthResponse.status);
  }
} catch (error) {
  console.log("❌ Failed to connect to server:", error);
  process.exit(1);
}

// Test MCP endpoints
try {
  const mcpServersResponse = await fetch("http://localhost:3000/mcp/servers");
  if (mcpServersResponse.ok) {
    const servers = await mcpServersResponse.json();
    console.log("✅ MCP servers endpoint working:");
    console.log(`- Connected servers: ${servers.servers.join(", ")}`);
  }
  
  const mcpToolsResponse = await fetch("http://localhost:3000/mcp/tools");
  if (mcpToolsResponse.ok) {
    const tools = await mcpToolsResponse.json();
    console.log("✅ MCP tools endpoint working:");
    console.log(`- Available tools: ${tools.tools.length}`);
    tools.tools.slice(0, 3).forEach((tool: any) => {
      console.log(`  - ${tool.name}: ${tool.description || 'No description'}`);
    });
  }
} catch (error) {
  console.log("❌ Failed to test MCP endpoints:", error);
}

console.log("🎉 Server test completed!");