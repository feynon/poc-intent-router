#!/usr/bin/env bun
const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
};

function log(message: string, color = colors.reset) {
  console.log(`${color}${message}${colors.reset}`);
}

async function testAppStructuredOutputs() {
  log("🌐 Testing Ollama Structured Outputs via App API", colors.bright);
  log("=".repeat(50), colors.cyan);

  const baseUrl = "http://localhost:3000";
  
  // Test 1: Health check
  log("\n1. Testing server health...", colors.blue);
  try {
    const response = await fetch(`${baseUrl}/health`);
    if (response.ok) {
      const health = await response.json();
      log("✅ Server health check passed", colors.green);
      log(`   Planner: ${health.services.planner}`, colors.cyan);
      log(`   Executor: ${health.services.executor}`, colors.cyan);
      log(`   MCP: ${health.services.mcp}`, colors.cyan);
    } else {
      log("❌ Server health check failed", colors.red);
      return;
    }
  } catch (error) {
    log(`❌ Failed to connect to server: ${error}`, colors.red);
    return;
  }

  // Test 2: Test structured outputs endpoint
  log("\n2. Testing structured outputs endpoint...", colors.blue);
  try {
    const testData = {
      prompt: "Create a file called 'test.txt' with content 'Hello World' and then email it to user@example.com",
      contextHistory: [
        { content: "Previous file operations were successful", priority: 7 }
      ]
    };

    const startTime = Date.now();
    const response = await fetch(`${baseUrl}/test/structured-outputs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(testData),
    });

    const result = await response.json();
    const duration = Date.now() - startTime;

    if (response.ok) {
      log(`✅ Structured outputs test passed in ${duration}ms`, colors.green);
      log(`📊 Test metadata:`, colors.cyan);
      log(`   Duration: ${result.test_metadata.duration_ms}ms`, colors.reset);
      log(`   Ollama structured outputs: ${result.test_metadata.ollama_structured_outputs}`, colors.reset);
      log(`   Validation engine: ${result.test_metadata.validation_engine}`, colors.reset);
      
      log(`📋 Planner response:`, colors.cyan);
      log(`   Plan ID: ${result.planner_response.plan_id}`, colors.reset);
      log(`   Confidence: ${(result.planner_response.confidence * 100).toFixed(1)}%`, colors.reset);
      log(`   Steps count: ${result.planner_response.steps_count}`, colors.reset);
      
      if (result.planner_response.steps.length > 0) {
        log(`📝 Steps:`, colors.yellow);
        result.planner_response.steps.forEach((step: any, index: number) => {
          log(`   ${index + 1}. ${step.op}`, colors.yellow);
          log(`      Args: ${JSON.stringify(step.args)}`, colors.reset);
          log(`      Tool caps: [${step.tool_caps.join(", ")}]`, colors.reset);
          log(`      Data caps: [${step.data_caps.join(", ")}]`, colors.reset);
        });
      }
      
      log(`🔒 Policy validation:`, colors.cyan);
      log(`   Passed: ${result.policy_validation.passed}`, colors.reset);
      log(`   Violations: ${result.policy_validation.violations_count}`, colors.reset);
      
      log(`✅ JSON schema validation:`, colors.cyan);
      log(`   Valid: ${result.json_schema_validation.valid}`, colors.reset);
      log(`   Enforced by: ${result.json_schema_validation.schema_enforced_by}`, colors.reset);
      
    } else {
      log(`❌ Structured outputs test failed: ${result.error}`, colors.red);
      if (result.suggestion) {
        log(`💡 Suggestion: ${result.suggestion}`, colors.yellow);
      }
    }
  } catch (error) {
    log(`❌ API test failed: ${error}`, colors.red);
  }

  // Test 3: Test regular prompt endpoint
  log("\n3. Testing regular prompt endpoint with structured outputs...", colors.blue);
  try {
    const promptData = {
      content: "Find all PDF files in the current directory and create a summary report",
      metadata: { source: "test", priority: "high" }
    };

    const startTime = Date.now();
    const response = await fetch(`${baseUrl}/prompt`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(promptData),
    });

    const result = await response.json();
    const duration = Date.now() - startTime;

    if (response.ok) {
      log(`✅ Regular prompt processed in ${duration}ms`, colors.green);
      log(`📋 Result:`, colors.cyan);
      log(`   Prompt ID: ${result.prompt_id}`, colors.reset);
      log(`   Plan ID: ${result.plan_id}`, colors.reset);
      log(`   Status: ${result.status}`, colors.reset);
      log(`   Confidence: ${(result.confidence * 100).toFixed(1)}%`, colors.reset);
      log(`   Steps: ${result.steps}`, colors.reset);
    } else {
      log(`❌ Regular prompt failed: ${result.error}`, colors.red);
    }
  } catch (error) {
    log(`❌ Regular prompt test failed: ${error}`, colors.red);
  }

  // Test 4: Test malformed input
  log("\n4. Testing error handling...", colors.blue);
  try {
    const response = await fetch(`${baseUrl}/test/structured-outputs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ invalid: "data" }),
    });

    const result = await response.json();
    
    if (!response.ok && result.error) {
      log(`✅ Error handling working correctly: ${result.error}`, colors.green);
    } else {
      log(`⚠️  Unexpected response to malformed input`, colors.yellow);
    }
  } catch (error) {
    log(`❌ Error handling test failed: ${error}`, colors.red);
  }

  log("\n" + "=".repeat(50), colors.cyan);
  log("🎉 App Structured Outputs Testing Complete!", colors.bright);
}

// Run the tests
if (import.meta.main) {
  testAppStructuredOutputs().catch(console.error);
}