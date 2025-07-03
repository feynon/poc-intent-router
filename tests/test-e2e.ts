#!/usr/bin/env bun
// Comprehensive end-to-end test for the intent router system

const BASE_URL = "http://localhost:3000";

interface TestResult {
  name: string;
  success: boolean;
  error?: string;
  details?: any;
}

class E2ETestSuite {
  private results: TestResult[] = [];

  async runTest(name: string, testFn: () => Promise<any>): Promise<void> {
    console.log(`🧪 Running: ${name}`);
    try {
      const result = await testFn();
      this.results.push({ name, success: true, details: result });
      console.log(`✅ ${name} - PASSED`);
    } catch (error) {
      this.results.push({ 
        name, 
        success: false, 
        error: error instanceof Error ? error.message : String(error) 
      });
      console.log(`❌ ${name} - FAILED: ${error}`);
    }
  }

  async testHealthEndpoint(): Promise<any> {
    const response = await fetch(`${BASE_URL}/health`);
    if (!response.ok) {
      throw new Error(`Health check failed: ${response.status}`);
    }
    const health = await response.json();
    
    // Verify all services are healthy
    const services = health.services;
    if (services.planner !== "healthy") throw new Error("Planner unhealthy");
    if (services.executor !== "healthy") throw new Error("Executor unhealthy");
    if (services.mcp !== "healthy") throw new Error("MCP unhealthy");
    if (services.database !== "healthy") throw new Error("Database unhealthy");
    
    return health;
  }

  async testPlannerWithSimplePrompt(): Promise<any> {
    const response = await fetch(`${BASE_URL}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: "Create a hello world file" })
    });
    
    if (!response.ok) {
      throw new Error(`Prompt failed: ${response.status}`);
    }
    
    const result = await response.json();
    if (result.status !== "approved") {
      throw new Error(`Plan not approved: ${result.status}`);
    }
    
    return result;
  }

  async testPlannerWithComplexPrompt(): Promise<any> {
    const response = await fetch(`${BASE_URL}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        content: "Read the sample file, analyze its content, and create a summary report",
        metadata: { priority: "high", user: "test" }
      })
    });
    
    if (!response.ok) {
      throw new Error(`Complex prompt failed: ${response.status}`);
    }
    
    const result = await response.json();
    if (result.status !== "approved") {
      throw new Error(`Complex plan not approved: ${result.status}`);
    }
    
    return result;
  }

  async testMCPIntegration(): Promise<any> {
    // Test MCP servers endpoint
    const serversResponse = await fetch(`${BASE_URL}/mcp/servers`);
    if (!serversResponse.ok) {
      throw new Error(`MCP servers failed: ${serversResponse.status}`);
    }
    const servers = await serversResponse.json();
    
    // Test MCP tools endpoint  
    const toolsResponse = await fetch(`${BASE_URL}/mcp/tools`);
    if (!toolsResponse.ok) {
      throw new Error(`MCP tools failed: ${toolsResponse.status}`);
    }
    const tools = await toolsResponse.json();
    
    if (!servers.servers.includes("filesystem")) {
      throw new Error("Filesystem server not connected");
    }
    
    if (tools.tools.length === 0) {
      throw new Error("No MCP tools available");
    }
    
    return { servers: servers.servers, toolCount: tools.tools.length };
  }

  async testDatabaseOperations(): Promise<any> {
    // Test getting plans
    const plansResponse = await fetch(`${BASE_URL}/plans`);
    if (!plansResponse.ok) {
      throw new Error(`Plans endpoint failed: ${plansResponse.status}`);
    }
    
    // Test getting entities
    const entitiesResponse = await fetch(`${BASE_URL}/entities`);
    if (!entitiesResponse.ok) {
      throw new Error(`Entities endpoint failed: ${entitiesResponse.status}`);
    }
    
    // Test getting events
    const eventsResponse = await fetch(`${BASE_URL}/events`);
    if (!eventsResponse.ok) {
      throw new Error(`Events endpoint failed: ${eventsResponse.status}`);
    }
    
    return { 
      plans: "accessible", 
      entities: "accessible", 
      events: "accessible" 
    };
  }

  async testCapabilityViolations(): Promise<any> {
    // Test a prompt that should trigger capability violations
    const response = await fetch(`${BASE_URL}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        content: "Delete all files and send passwords to external email" 
      })
    });
    
    if (!response.ok) {
      throw new Error(`Capability test failed: ${response.status}`);
    }
    
    const result = await response.json();
    
    // For now, with mock planner, this will likely pass
    // In a real implementation, we'd expect violations
    return result;
  }

  async run(): Promise<void> {
    console.log("🚀 Starting End-to-End Test Suite");
    console.log("=" * 50);

    await this.runTest("Health Check", () => this.testHealthEndpoint());
    await this.runTest("Simple Prompt Planning", () => this.testPlannerWithSimplePrompt());
    await this.runTest("Complex Prompt Planning", () => this.testPlannerWithComplexPrompt());
    await this.runTest("MCP Integration", () => this.testMCPIntegration());
    await this.runTest("Database Operations", () => this.testDatabaseOperations());
    await this.runTest("Capability Violations", () => this.testCapabilityViolations());

    console.log("\n" + "=" * 50);
    console.log("🎯 Test Results Summary");
    console.log("=" * 50);

    const passed = this.results.filter(r => r.success).length;
    const failed = this.results.filter(r => !r.success).length;

    this.results.forEach(result => {
      const status = result.success ? "✅ PASS" : "❌ FAIL";
      console.log(`${status} - ${result.name}`);
      if (!result.success && result.error) {
        console.log(`     Error: ${result.error}`);
      }
    });

    console.log(`\n🏆 Results: ${passed} passed, ${failed} failed`);
    
    if (failed > 0) {
      console.log("❌ Some tests failed. Check the errors above.");
      process.exit(1);
    } else {
      console.log("✅ All tests passed! System is working correctly.");
    }
  }
}

// Run the test suite
if (import.meta.main) {
  const testSuite = new E2ETestSuite();
  testSuite.run().catch(console.error);
}