import { PlannerRequest, PlannerResponse, Plan, Step } from "./types.js";

export class MockPlannerAgent {
  private ollamaEndpoint: string;
  private modelName: string;

  constructor(
    ollamaEndpoint: string = "http://localhost:11434",
    modelName: string = "mock"
  ) {
    this.ollamaEndpoint = ollamaEndpoint;
    this.modelName = modelName;
  }

  async generatePlan(request: PlannerRequest): Promise<PlannerResponse> {
    // Simulate planning based on prompt content
    const steps = this.generateStepsFromPrompt(request.prompt);

    const plan: Plan = {
      id: crypto.randomUUID(),
      prompt_id: crypto.randomUUID(), // This should be passed from the caller
      steps,
      timestamp: new Date().toISOString(),
      status: "pending",
    };

    return {
      plan,
      confidence: 0.85, // Mock confidence
    };
  }

  private generateStepsFromPrompt(prompt: string): Step[] {
    const lowerPrompt = prompt.toLowerCase();

    if (lowerPrompt.includes("greeting") || lowerPrompt.includes("hello") || lowerPrompt.includes("welcome")) {
      return [{
        op: "create_document",
        args: {
          title: "User Greeting",
          content: "Hello! Welcome to our platform. We're excited to have you here!",
          format: "text"
        },
        tool_caps: ["WRITE_FILE"],
        data_caps: ["share_with:public"],
        deps: []
      }];
    }

    if (lowerPrompt.includes("email") || lowerPrompt.includes("send") || lowerPrompt.includes("message")) {
      return [{
        op: "send_message",
        args: {
          channel: "email",
          to: "user@example.com",
          subject: "Welcome Message",
          content: "Welcome to our service!"
        },
        tool_caps: ["SEND_EMAIL"],
        data_caps: ["share_with:team"],
        deps: []
      }];
    }

    if (lowerPrompt.includes("search") || lowerPrompt.includes("find")) {
      return [{
        op: "search_entities",
        args: {
          query: prompt,
          limit: 10
        },
        tool_caps: ["READ_FILE"],
        data_caps: [],
        deps: []
      }];
    }

    if (lowerPrompt.includes("analyze") || lowerPrompt.includes("process")) {
      return [{
        op: "analyze_content",
        args: {
          content: prompt,
          analysis_type: "general"
        },
        tool_caps: [],
        data_caps: [],
        deps: []
      }];
    }

    // Default: create a document
    return [{
      op: "create_document",
      args: {
        title: "Response to Request",
        content: `Response to: ${prompt}`,
        format: "text"
      },
      tool_caps: ["WRITE_FILE"],
      data_caps: ["share_with:team"],
      deps: []
    }];
  }

  async healthCheck(): Promise<boolean> {
    return true; // Mock planner is always healthy
  }

  async listModels(): Promise<string[]> {
    return ["mock"];
  }
}