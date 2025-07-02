import { Plan, Step, Entity, Capability, PolicyViolation } from "./types.js";

export class PolicyEngine {
  private capabilities: Map<string, Capability> = new Map();

  constructor(capabilities: Capability[] = []) {
    for (const cap of capabilities) {
      this.capabilities.set(cap.id, cap);
    }
  }

  addCapability(capability: Capability): void {
    this.capabilities.set(capability.id, capability);
  }

  getCapability(id: string): Capability | undefined {
    return this.capabilities.get(id);
  }

  listCapabilities(): Capability[] {
    return Array.from(this.capabilities.values());
  }

  async validatePlan(
    plan: Plan,
    entities: Entity[] = [],
    toolRegistry: Record<string, string[]> = {}
  ): Promise<PolicyViolation[]> {
    const violations: PolicyViolation[] = [];
    const entityMap = new Map(entities.map(e => [e.id, e]));

    for (let stepIndex = 0; stepIndex < plan.steps.length; stepIndex++) {
      const step = plan.steps[stepIndex];
      
      // Validate tool capabilities
      const toolViolations = this.validateToolCapabilities(step, stepIndex, toolRegistry);
      violations.push(...toolViolations);

      // Validate data capabilities
      const dataViolations = await this.validateDataCapabilities(step, stepIndex, entityMap);
      violations.push(...dataViolations);

      // Validate dependencies
      const depViolations = this.validateDependencies(step, stepIndex, plan.steps.length);
      violations.push(...depViolations);
    }

    return violations;
  }

  private validateToolCapabilities(
    step: Step,
    stepIndex: number,
    toolRegistry: Record<string, string[]>
  ): PolicyViolation[] {
    const violations: PolicyViolation[] = [];
    
    // Get required capabilities for this operation
    const requiredToolCaps = toolRegistry[step.op] || [];
    
    // Check if step declares all required tool capabilities
    const missingToolCaps = requiredToolCaps.filter(
      cap => !step.tool_caps.includes(cap)
    );

    if (missingToolCaps.length > 0) {
      violations.push({
        step_index: stepIndex,
        violation_type: "missing_tool_cap",
        required: requiredToolCaps,
        available: step.tool_caps,
        message: `Step ${stepIndex} (${step.op}) missing required tool capabilities: ${missingToolCaps.join(", ")}`,
      });
    }

    // Check if declared tool capabilities exist
    const invalidToolCaps = step.tool_caps.filter(
      cap => !this.capabilities.has(cap) || this.capabilities.get(cap)?.kind !== "ToolCap"
    );

    if (invalidToolCaps.length > 0) {
      violations.push({
        step_index: stepIndex,
        violation_type: "missing_tool_cap",
        required: step.tool_caps,
        available: Array.from(this.capabilities.keys()).filter(
          id => this.capabilities.get(id)?.kind === "ToolCap"
        ),
        message: `Step ${stepIndex} declares invalid tool capabilities: ${invalidToolCaps.join(", ")}`,
      });
    }

    return violations;
  }

  private async validateDataCapabilities(
    step: Step,
    stepIndex: number,
    entityMap: Map<string, Entity>
  ): Promise<PolicyViolation[]> {
    const violations: PolicyViolation[] = [];

    // Get all entities that this step might consume
    const consumedEntityIds = this.extractEntityReferences(step.args);
    
    for (const entityId of consumedEntityIds) {
      const entity = entityMap.get(entityId);
      if (!entity) {
        // Entity doesn't exist - this might be handled elsewhere
        continue;
      }

      // Check if step has sufficient data capabilities for this entity
      const entityDataCaps = entity.capabilities.filter(cap => 
        this.capabilities.get(cap)?.kind === "DataCap"
      );

      const missingDataCaps = entityDataCaps.filter(
        cap => !step.data_caps.includes(cap)
      );

      if (missingDataCaps.length > 0) {
        violations.push({
          step_index: stepIndex,
          violation_type: "missing_data_cap",
          required: entityDataCaps,
          available: step.data_caps,
          message: `Step ${stepIndex} missing data capabilities for entity ${entityId}: ${missingDataCaps.join(", ")}`,
        });
      }
    }

    // Check if declared data capabilities exist
    const invalidDataCaps = step.data_caps.filter(
      cap => !this.capabilities.has(cap) || this.capabilities.get(cap)?.kind !== "DataCap"
    );

    if (invalidDataCaps.length > 0) {
      violations.push({
        step_index: stepIndex,
        violation_type: "missing_data_cap",
        required: step.data_caps,
        available: Array.from(this.capabilities.keys()).filter(
          id => this.capabilities.get(id)?.kind === "DataCap"
        ),
        message: `Step ${stepIndex} declares invalid data capabilities: ${invalidDataCaps.join(", ")}`,
      });
    }

    return violations;
  }

  private validateDependencies(
    step: Step,
    stepIndex: number,
    totalSteps: number
  ): PolicyViolation[] {
    const violations: PolicyViolation[] = [];

    for (const dep of step.deps) {
      // Check if dependency index is valid
      if (dep < 0 || dep >= totalSteps) {
        violations.push({
          step_index: stepIndex,
          violation_type: "invalid_dependency",
          required: step.deps.map(String),
          available: Array.from({ length: totalSteps }, (_, i) => i.toString()),
          message: `Step ${stepIndex} has invalid dependency: ${dep} (valid range: 0-${totalSteps - 1})`,
        });
      }

      // Check if dependency refers to a later step (circular dependency)
      if (dep >= stepIndex) {
        violations.push({
          step_index: stepIndex,
          violation_type: "invalid_dependency",
          required: step.deps.map(String),
          available: Array.from({ length: stepIndex }, (_, i) => i.toString()),
          message: `Step ${stepIndex} cannot depend on step ${dep} (circular or forward dependency)`,
        });
      }
    }

    return violations;
  }

  private extractEntityReferences(args: any): string[] {
    const entityIds: string[] = [];
    
    const traverse = (obj: any) => {
      if (typeof obj === "string" && this.isUUID(obj)) {
        entityIds.push(obj);
      } else if (Array.isArray(obj)) {
        obj.forEach(traverse);
      } else if (obj && typeof obj === "object") {
        Object.values(obj).forEach(traverse);
      }
    };

    traverse(args);
    return entityIds;
  }

  private isUUID(str: string): boolean {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return uuidRegex.test(str);
  }

  async checkStepExecution(
    step: Step,
    entities: Entity[],
    toolRegistry: Record<string, string[]>
  ): Promise<{ allowed: boolean; violations: PolicyViolation[] }> {
    const entityMap = new Map(entities.map(e => [e.id, e]));
    const violations: PolicyViolation[] = [];

    // Check tool capabilities
    const toolViolations = this.validateToolCapabilities(step, 0, toolRegistry);
    violations.push(...toolViolations);

    // Check data capabilities
    const dataViolations = await this.validateDataCapabilities(step, 0, entityMap);
    violations.push(...dataViolations);

    return {
      allowed: violations.length === 0,
      violations,
    };
  }

  createApprovalContext(violations: PolicyViolation[]): {
    summary: string;
    details: PolicyViolation[];
    requiresUserApproval: boolean;
  } {
    const hasCriticalViolations = violations.some(v => 
      v.violation_type === "missing_tool_cap" || 
      v.violation_type === "missing_data_cap"
    );

    const summary = violations.length === 1 
      ? violations[0].message
      : `${violations.length} policy violations detected`;

    return {
      summary,
      details: violations,
      requiresUserApproval: hasCriticalViolations,
    };
  }
}