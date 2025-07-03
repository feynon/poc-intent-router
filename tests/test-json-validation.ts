#!/usr/bin/env bun
import { PlannerAgent } from "../agents/planner.js";
import { PlannerRequest, PlanSchema, StepSchema } from "../agents/types.js";
import { z } from "zod";

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

async function validateJSONStructure() {
  log("🔍 Comprehensive JSON Validation Test", colors.bright);
  log("=".repeat(50), colors.cyan);

  const planner = new PlannerAgent();

  // Test with various prompts to ensure consistent JSON structure
  const testCases = [
    {
      name: "Simple file operation",
      prompt: "Create a file named 'hello.txt' with content 'Hello World'"
    },
    {
      name: "Multi-step workflow",
      prompt: "Download a file from https://example.com/data.csv, analyze the data, and create a summary report"
    },
    {
      name: "Complex workflow with dependencies",
      prompt: "Search for all Python files, run tests on them, and if tests pass, deploy to staging environment"
    },
    {
      name: "Email and notification workflow",
      prompt: "Generate a weekly report from database, save as PDF, and email to stakeholders"
    }
  ];

  let passedTests = 0;
  let totalTests = testCases.length;

  for (let i = 0; i < testCases.length; i++) {
    const testCase = testCases[i];
    log(`\n${i + 1}. Testing: ${testCase.name}`, colors.blue);
    
    try {
      const request: PlannerRequest = {
        prompt: testCase.prompt,
        contextHistory: [
          { content: "Test environment with all capabilities enabled", priority: 8 }
        ]
      };

      const startTime = Date.now();
      const response = await planner.generatePlan(request);
      const duration = Date.now() - startTime;

      log(`   ⏱️  Generated in ${duration}ms`, colors.cyan);
      log(`   📊 Confidence: ${(response.confidence * 100).toFixed(1)}%`, colors.cyan);

      // Validate overall plan structure
      try {
        PlanSchema.parse(response.plan);
        log(`   ✅ Plan schema validation passed`, colors.green);
      } catch (error) {
        log(`   ❌ Plan schema validation failed: ${error}`, colors.red);
        continue;
      }

      // Validate each step structure
      let allStepsValid = true;
      for (let j = 0; j < response.plan.steps.length; j++) {
        const step = response.plan.steps[j];
        try {
          StepSchema.parse(step);
          
          // Additional validations
          if (typeof step.op !== 'string' || step.op.length === 0) {
            throw new Error("Invalid op field");
          }
          
          if (!Array.isArray(step.tool_caps)) {
            throw new Error("tool_caps must be an array");
          }
          
          if (!Array.isArray(step.data_caps)) {
            throw new Error("data_caps must be an array");
          }
          
          if (!Array.isArray(step.deps)) {
            throw new Error("deps must be an array");
          }
          
          // Validate dependency references
          for (const dep of step.deps) {
            if (typeof dep !== 'number' || dep < 0 || dep >= response.plan.steps.length) {
              throw new Error(`Invalid dependency reference: ${dep}`);
            }
          }
          
        } catch (error) {
          log(`   ❌ Step ${j} validation failed: ${error}`, colors.red);
          allStepsValid = false;
        }
      }

      if (allStepsValid) {
        log(`   ✅ All ${response.plan.steps.length} steps validated successfully`, colors.green);
        
        // Log step details
        if (response.plan.steps.length > 0) {
          log(`   📝 Steps breakdown:`, colors.yellow);
          response.plan.steps.forEach((step, index) => {
            log(`      ${index + 1}. ${step.op}`, colors.reset);
            log(`         Tool caps: [${step.tool_caps.join(", ")}]`, colors.reset);
            log(`         Data caps: [${step.data_caps.join(", ")}]`, colors.reset);
            log(`         Dependencies: [${step.deps.join(", ")}]`, colors.reset);
          });
        } else {
          log(`   ⚠️  No steps generated for this prompt`, colors.yellow);
        }
        
        passedTests++;
      }

      // Test JSON serialization/deserialization
      try {
        const serialized = JSON.stringify(response.plan);
        const deserialized = JSON.parse(serialized);
        PlanSchema.parse(deserialized);
        log(`   ✅ JSON serialization/deserialization test passed`, colors.green);
      } catch (error) {
        log(`   ❌ JSON serialization test failed: ${error}`, colors.red);
      }

    } catch (error) {
      log(`   ❌ Test failed: ${error}`, colors.red);
    }
  }

  // Summary
  log(`\n${"=".repeat(50)}`, colors.cyan);
  log(`📊 Test Results: ${passedTests}/${totalTests} tests passed`, 
    passedTests === totalTests ? colors.green : colors.yellow);
  
  if (passedTests === totalTests) {
    log(`🎉 All JSON validation tests passed!`, colors.bright);
    log(`✅ Ollama structured outputs are working correctly`, colors.green);
    log(`✅ Zod schema validation is enforced`, colors.green);
    log(`✅ JSON structure is consistent and valid`, colors.green);
  } else {
    log(`⚠️  Some tests failed. Review the output above.`, colors.yellow);
  }

  return passedTests === totalTests;
}

// Run the validation
if (import.meta.main) {
  validateJSONStructure()
    .then(success => {
      process.exit(success ? 0 : 1);
    })
    .catch(error => {
      console.error("Validation failed:", error);
      process.exit(1);
    });
}