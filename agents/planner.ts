import { PlannerRequest, PlannerResponse, Plan, Step, PlanSchema } from "./types.js";

const PLANNER_TEMPLATE = String.raw`
You are a deterministic planning LLM inside an "agentic notebook".
Output **only** JSON - an array of step objects with fields:
  op          // snake_case verb
  args        // arbitrary JSON-serializable payload
  tool_caps   // array of required ToolCap IDs
  data_caps   // array of required DataCap IDs (for consumed entities)
  deps        // array of step indices this one depends on

Available operations:
- create_document: Create new documents or content
- send_message: Send messages via email, chat, etc.
- fetch_data: Retrieve information from various sources
- search_entities: Search existing entities by content
- analyze_content: Analyze or process content
- transform_data: Transform data from one format to another

Available tool capabilities:
- READ_FILE: Read files from filesystem
- WRITE_FILE: Write files to filesystem
- SEND_EMAIL: Send email messages
- HTTP_REQUEST: Make HTTP requests
- SEARCH_WEB: Search the web

Available data capabilities:
- share_with:public: Share data publicly
- share_with:team: Share data with team members
- pii_allowed: Handle personally identifiable information

User prompt: {PROMPT}

IMPORTANT: Always respond with a JSON array starting with [ and ending with ]. Even for a single step, wrap it in an array.
Example: [{"op":"create_document","args":{"title":"Hello","content":"Hello World"},"tool_caps":["WRITE_FILE"],"data_caps":["share_with:public"],"deps":[]}]`;

export class PlannerAgent {
  private ollamaEndpoint: string;
  private modelName: string;

  constructor(
    ollamaEndpoint: string = "http://localhost:11434",
    modelName: string = "gemma3:latest"
  ) {
    this.ollamaEndpoint = ollamaEndpoint;
    this.modelName = modelName;
  }

  async generatePlan(request: PlannerRequest): Promise<PlannerResponse> {
    const prompt = PLANNER_TEMPLATE.replace("{PROMPT}", request.prompt);
    
    try {
      const response = await fetch(`${this.ollamaEndpoint}/api/generate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.modelName,
          prompt,
          format: "json",
          stream: false,
        }),
      });

      if (!response.ok) {
        throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      
      if (!data.response) {
        throw new Error("No response from Ollama");
      }

      let steps: Step[];
      try {
        const parsed = JSON.parse(data.response);
        // Handle both single object and array responses
        steps = Array.isArray(parsed) ? parsed : [parsed];
      } catch (parseError) {
        throw new Error(`Failed to parse JSON response: ${parseError}`);
      }

      // Validate the steps array
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

      // Validate the entire plan
      PlanSchema.parse(plan);

      // Calculate confidence based on plan quality
      const confidence = this.calculateConfidence(plan, data);

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
      const response = await fetch(`${this.ollamaEndpoint}/api/version`);
      return response.ok;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<string[]> {
    try {
      const response = await fetch(`${this.ollamaEndpoint}/api/tags`);
      if (!response.ok) {
        return [];
      }
      const data = await response.json();
      return data.models?.map((model: any) => model.name) || [];
    } catch {
      return [];
    }
  }
}