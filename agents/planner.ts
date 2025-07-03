import { PlannerRequest, PlannerResponse, Plan, Step, PlanSchema } from "./types.js";
import { render, SystemMessage, UserMessage, PromptElement } from "@anysphere/priompt";
import { Ollama } from "ollama";

interface PlannerPromptProps {
  userPrompt: string;
  availableOperations?: string[];
  availableToolCaps?: string[];
  availableDataCaps?: string[];
  contextHistory?: Array<{content: string; priority: number}>;
}

function PlannerPrompt(props: PlannerPromptProps): PromptElement {
  const {
    userPrompt,
    availableOperations = [
      "create_document: Create new documents or content",
      "send_message: Send messages via email, chat, etc.",
      "fetch_data: Retrieve information from various sources",
      "search_entities: Search existing entities by content",
      "analyze_content: Analyze or process content",
      "transform_data: Transform data from one format to another"
    ],
    availableToolCaps = [
      "READ_FILE: Read files from filesystem",
      "WRITE_FILE: Write files to filesystem",
      "SEND_EMAIL: Send email messages",
      "HTTP_REQUEST: Make HTTP requests",
      "SEARCH_WEB: Search the web"
    ],
    availableDataCaps = [
      "share_with:public: Share data publicly",
      "share_with:team: Share data with team members",
      "pii_allowed: Handle personally identifiable information"
    ],
    contextHistory = []
  } = props;

  const elements: PromptElement[] = [];
  
  // Core system message with highest priority
  elements.push(SystemMessage({
    p: 10,
    children: `You are a deterministic planning LLM inside an "agentic notebook".
Output **only** valid JSON - an array of step objects with these exact fields:
  "op": "string"          // snake_case verb like "create_file", "send_email", etc.
  "args": {}              // object with operation parameters
  "tool_caps": []         // array of required ToolCap IDs
  "data_caps": []         // array of required DataCap IDs
  "deps": []              // array of step indices this depends on

CRITICAL: Respond with ONLY a valid JSON array. No other text. Format:
[{"op":"operation_name","args":{"key":"value"},"tool_caps":[],"data_caps":[],"deps":[]}]

Example: [{"op":"create_file","args":{"path":"hello.txt","content":"Hello World"},"tool_caps":["WRITE_FILE"],"data_caps":["share_with:public"],"deps":[]}]`
  }));
  
  // Available operations
  elements.push(SystemMessage({
    p: 8,
    children: `Available operations:\n${availableOperations.map(op => `- ${op}`).join('\n')}`
  }));
  
  // Available tool capabilities
  elements.push(SystemMessage({
    p: 6,
    children: `Available tool capabilities:\n${availableToolCaps.map(cap => `- ${cap}`).join('\n')}`
  }));
  
  // Available data capabilities
  elements.push(SystemMessage({
    p: 5,
    children: `Available data capabilities:\n${availableDataCaps.map(cap => `- ${cap}`).join('\n')}`
  }));
  
  // Context history with variable priorities
  contextHistory.forEach((context, index) => {
    elements.push(SystemMessage({
      p: context.priority,
      children: `Context: ${context.content}`
    }));
  });
  
  // User prompt with high priority
  elements.push(UserMessage({
    p: 9,
    children: userPrompt
  }));

  return elements;
}

export class PlannerAgent {
  private ollama: Ollama;
  private modelName: string;

  constructor(
    ollamaEndpoint: string = "http://localhost:11434",
    modelName: string = "qwen3:4b"
  ) {
    this.ollama = new Ollama({ host: ollamaEndpoint });
    this.modelName = modelName;
  }

  async generatePlan(request: PlannerRequest): Promise<PlannerResponse> {
    // Use Priompt to render the prompt with priority-based token inclusion
    const promptElement = PlannerPrompt({
      userPrompt: request.prompt,
      contextHistory: request.contextHistory || []
    });
    
    const renderedPrompt = render(promptElement, {
      tokenLimit: 4000, // Adjust based on your model's context limit
      tokenizer: {
        numTokens: (text: string) => Math.ceil(text.length / 4) // Simple approximation
      }
    });
    
    const prompt = renderedPrompt.toString();
    
    // Define JSON schema for structured outputs
    const schema = {
      type: "array",
      items: {
        type: "object",
        properties: {
          op: {
            type: "string",
            description: "Operation name in snake_case"
          },
          args: {
            type: "object",
            description: "Operation arguments as key-value pairs"
          },
          tool_caps: {
            type: "array",
            items: { type: "string" },
            description: "Required tool capabilities"
          },
          data_caps: {
            type: "array", 
            items: { type: "string" },
            description: "Required data capabilities"
          },
          deps: {
            type: "array",
            items: { type: "number" },
            description: "Dependencies on other step indices"
          }
        },
        required: ["op", "args", "tool_caps", "data_caps", "deps"],
        additionalProperties: false
      }
    };

    try {
      const response = await this.ollama.generate({
        model: this.modelName,
        prompt,
        format: schema,
        stream: false,
        options: {
          temperature: 0.1, // Lower temperature for more deterministic planning
        }
      });

      if (!response.response) {
        throw new Error("No response from Ollama");
      }

      let steps: Step[];
      try {
        const parsed = JSON.parse(response.response);
        // Handle both single object and array responses
        steps = Array.isArray(parsed) ? parsed : [parsed];
      } catch (parseError) {
        throw new Error(`Failed to parse JSON response: ${parseError}`);
      }

      // Validate the steps array with Zod schema
      const validatedSteps = steps.map((step, index) => {
        try {
          return {
            op: step.op,
            args: step.args || {},
            tool_caps: Array.isArray(step.tool_caps) ? step.tool_caps : [],
            data_caps: Array.isArray(step.data_caps) ? step.data_caps : [],
            deps: Array.isArray(step.deps) ? step.deps : [],
          };
        } catch (error) {
          throw new Error(`Invalid step at index ${index}: ${error}`);
        }
      });

      const plan: Plan = {
        id: crypto.randomUUID(),
        prompt_id: crypto.randomUUID(), // This should be passed from the caller
        steps: validatedSteps,
        timestamp: new Date().toISOString(),
        status: "pending",
      };

      // Validate the entire plan with Zod
      PlanSchema.parse(plan);

      // Calculate confidence based on plan quality
      const confidence = this.calculateConfidence(plan, response);

      return {
        plan,
        confidence,
      };
    } catch (error) {
      throw new Error(`Planning failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private calculateConfidence(plan: Plan, ollamaResponse: any): number {
    let confidence = 0.7; // Base confidence

    // Increase confidence for well-structured plans
    if (plan.steps.length > 0) {
      confidence += 0.1;
    }

    // Increase confidence if all steps have required fields
    const wellFormedSteps = plan.steps.filter(step => 
      step.op && 
      Array.isArray(step.tool_caps) && 
      Array.isArray(step.data_caps)
    );
    
    if (wellFormedSteps.length === plan.steps.length) {
      confidence += 0.1;
    }

    // Increase confidence for reasonable dependency chains
    const hasValidDeps = plan.steps.every(step => 
      step.deps.every(dep => dep >= 0 && dep < plan.steps.length)
    );
    
    if (hasValidDeps) {
      confidence += 0.1;
    }

    return Math.min(confidence, 1.0);
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.ollama.list();
      return true;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<string[]> {
    try {
      const response = await this.ollama.list();
      return response.models?.map((model: any) => model.name) || [];
    } catch {
      return [];
    }
  }
}