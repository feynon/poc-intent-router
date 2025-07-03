#!/usr/bin/env bun
import { PlannerAgent } from "../agents/planner.js";
import { PlannerRequest } from "../agents/types.js";

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

async function testStructuredOutputs() {
  log("🧪 Testing Ollama Structured Outputs with CLI", colors.bright);
  log("=".repeat(50), colors.cyan);

  const planner = new PlannerAgent();

  // Test 1: Health check
  log("\n1. Testing Ollama connection...", colors.blue);
  try {
    const isHealthy = await planner.healthCheck();
    if (isHealthy) {
      log("✅ Ollama connection successful", colors.green);
    } else {
      log("❌ Ollama connection failed", colors.red);
      return;
    }
  } catch (error) {
    log(`❌ Health check error: ${error}`, colors.red);
    return;
  }

  // Test 2: List models
  log("\n2. Listing available models...", colors.blue);
  try {
    const models = await planner.listModels();
    if (models.length > 0) {
      log(`✅ Found models: ${models.join(", ")}`, colors.green);
    } else {
      log("⚠️  No models found", colors.yellow);
    }
  } catch (error) {
    log(`❌ Model listing error: ${error}`, colors.red);
  }

  // Test 3: Simple planning request
  log("\n3. Testing simple planning request...", colors.blue);
  const simpleRequest: PlannerRequest = {
    prompt: "Create a hello world file and then send it via email to john@example.com"
  };

  try {
    const startTime = Date.now();
    const response = await planner.generatePlan(simpleRequest);
    const duration = Date.now() - startTime;
    
    log(`✅ Plan generated successfully in ${duration}ms`, colors.green);
    log(`📊 Confidence: ${(response.confidence * 100).toFixed(1)}%`, colors.cyan);
    log(`📋 Plan ID: ${response.plan.id}`, colors.cyan);
    log(`📝 Steps (${response.plan.steps.length}):`, colors.cyan);
    
    response.plan.steps.forEach((step, index) => {
      log(`  ${index + 1}. ${step.op}`, colors.yellow);
      log(`     Args: ${JSON.stringify(step.args)}`, colors.reset);
      log(`     Tool caps: [${step.tool_caps.join(", ")}]`, colors.reset);
      log(`     Data caps: [${step.data_caps.join(", ")}]`, colors.reset);
      log(`     Dependencies: [${step.deps.join(", ")}]`, colors.reset);
    });
  } catch (error) {
    log(`❌ Simple planning failed: ${error}`, colors.red);
  }

  // Test 4: Complex planning request with context
  log("\n4. Testing complex planning with context...", colors.blue);
  const complexRequest: PlannerRequest = {
    prompt: "Analyze the quarterly sales data, create a summary report, and schedule a meeting with the team to discuss findings",
    contextHistory: [
      { content: "Previous analysis showed 15% growth in Q3", priority: 7 },
      { content: "Team members: Alice, Bob, Charlie", priority: 6 },
      { content: "Meeting room availability: Tuesdays and Thursdays", priority: 5 }
    ]
  };

  try {
    const startTime = Date.now();
    const response = await planner.generatePlan(complexRequest);
    const duration = Date.now() - startTime;
    
    log(`✅ Complex plan generated successfully in ${duration}ms`, colors.green);
    log(`📊 Confidence: ${(response.confidence * 100).toFixed(1)}%`, colors.cyan);
    log(`📋 Plan ID: ${response.plan.id}`, colors.cyan);
    log(`📝 Steps (${response.plan.steps.length}):`, colors.cyan);
    
    response.plan.steps.forEach((step, index) => {
      log(`  ${index + 1}. ${step.op}`, colors.yellow);
      log(`     Args: ${JSON.stringify(step.args, null, 2).replace(/\n/g, "\n     ")}`, colors.reset);
      log(`     Tool caps: [${step.tool_caps.join(", ")}]`, colors.reset);
      log(`     Data caps: [${step.data_caps.join(", ")}]`, colors.reset);
      log(`     Dependencies: [${step.deps.join(", ")}]`, colors.reset);
    });
  } catch (error) {
    log(`❌ Complex planning failed: ${error}`, colors.red);
  }

  // Test 5: Edge case - Empty prompt
  log("\n5. Testing edge case - empty prompt...", colors.blue);
  const emptyRequest: PlannerRequest = {
    prompt: ""
  };

  try {
    const response = await planner.generatePlan(emptyRequest);
    log(`⚠️  Empty prompt handled: ${response.plan.steps.length} steps generated`, colors.yellow);
  } catch (error) {
    log(`✅ Empty prompt properly rejected: ${error}`, colors.green);
  }

  log("\n" + "=".repeat(50), colors.cyan);
  log("🎉 CLI Structured Outputs Testing Complete!", colors.bright);
}

// Run the tests
if (import.meta.main) {
  testStructuredOutputs().catch(console.error);
}