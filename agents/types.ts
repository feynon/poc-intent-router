import { z } from "zod";

export const PromptSchema = z.object({
  id: z.string().uuid(),
  content: z.string(),
  timestamp: z.string().datetime(),
  metadata: z.record(z.unknown()).optional(),
});

export const StepSchema = z.object({
  op: z.string(),
  args: z.any(),
  tool_caps: z.array(z.string()),
  data_caps: z.array(z.string()),
  deps: z.array(z.number()),
});

export const PlanSchema = z.object({
  id: z.string().uuid(),
  prompt_id: z.string().uuid(),
  steps: z.array(StepSchema),
  timestamp: z.string().datetime(),
  status: z.enum(["pending", "in_progress", "completed", "failed"]),
});

export const EntitySchema = z.object({
  id: z.string().uuid(),
  content: z.string(),
  embedding: z.array(z.number()).optional(),
  capabilities: z.array(z.string()),
  metadata: z.record(z.unknown()).optional(),
  timestamp: z.string().datetime(),
});

export const EventSchema = z.object({
  id: z.string().uuid(),
  plan_id: z.string().uuid(),
  step_index: z.number(),
  op: z.string(),
  produces: z.array(z.string().uuid()),
  consumes: z.array(z.string().uuid()),
  result: z.any().optional(),
  error: z.string().optional(),
  timestamp: z.string().datetime(),
});

export const CapabilitySchema = z.object({
  id: z.string(),
  kind: z.enum(["ToolCap", "DataCap"]),
  scope: z.string(),
  description: z.string().optional(),
});

export const ViewSpecSchema = z.object({
  id: z.string().uuid(),
  generated_from: z.array(z.string().uuid()),
  spec: z.record(z.unknown()),
  timestamp: z.string().datetime(),
});

export type Prompt = z.infer<typeof PromptSchema>;
export type Step = z.infer<typeof StepSchema>;
export type Plan = z.infer<typeof PlanSchema>;
export type Entity = z.infer<typeof EntitySchema>;
export type Event = z.infer<typeof EventSchema>;
export type Capability = z.infer<typeof CapabilitySchema>;
export type ViewSpec = z.infer<typeof ViewSpecSchema>;

export interface PlannerRequest {
  prompt: string;
  context?: Record<string, unknown>;
}

export interface PlannerResponse {
  plan: Plan;
  confidence: number;
}

export interface ExecutorRequest {
  step: Step;
  context: Record<string, unknown>;
}

export interface ExecutorResponse {
  result: unknown;
  entities?: Entity[];
  error?: string;
}

export interface PolicyViolation {
  step_index: number;
  violation_type: "missing_tool_cap" | "missing_data_cap" | "invalid_dependency";
  required: string[];
  available: string[];
  message: string;
}