import { Capability } from "./types.js";

export const DEFAULT_CAPABILITIES: Capability[] = [
  // File System Tool Capabilities
  {
    id: "READ_FILE",
    kind: "ToolCap",
    scope: "fs",
    description: "Read files from the filesystem",
  },
  {
    id: "WRITE_FILE",
    kind: "ToolCap",
    scope: "fs",
    description: "Write files to the filesystem",
  },
  {
    id: "LIST_FILES",
    kind: "ToolCap",
    scope: "fs",
    description: "List files and directories",
  },
  {
    id: "DELETE_FILE",
    kind: "ToolCap",
    scope: "fs",
    description: "Delete files from the filesystem",
  },

  // Network Tool Capabilities
  {
    id: "HTTP_REQUEST",
    kind: "ToolCap",
    scope: "network",
    description: "Make HTTP requests to external services",
  },
  {
    id: "SEARCH_WEB",
    kind: "ToolCap",
    scope: "network",
    description: "Search the web using search engines",
  },
  {
    id: "FETCH_URL",
    kind: "ToolCap",
    scope: "network",
    description: "Fetch content from URLs",
  },

  // Communication Tool Capabilities
  {
    id: "SEND_EMAIL",
    kind: "ToolCap",
    scope: "smtp",
    description: "Send email messages",
  },
  {
    id: "SEND_SMS",
    kind: "ToolCap",
    scope: "sms",
    description: "Send SMS messages",
  },
  {
    id: "SEND_WEBHOOK",
    kind: "ToolCap",
    scope: "webhook",
    description: "Send webhook notifications",
  },

  // Database Tool Capabilities
  {
    id: "READ_DATABASE",
    kind: "ToolCap",
    scope: "database",
    description: "Read data from databases",
  },
  {
    id: "WRITE_DATABASE",
    kind: "ToolCap",
    scope: "database",
    description: "Write data to databases",
  },

  // System Tool Capabilities
  {
    id: "EXECUTE_COMMAND",
    kind: "ToolCap",
    scope: "system",
    description: "Execute system commands",
  },
  {
    id: "SCHEDULE_TASK",
    kind: "ToolCap",
    scope: "system",
    description: "Schedule tasks for later execution",
  },

  // Data Sharing Capabilities
  {
    id: "share_with:public",
    kind: "DataCap",
    scope: "sharing",
    description: "Share data publicly without restrictions",
  },
  {
    id: "share_with:team",
    kind: "DataCap",
    scope: "sharing",
    description: "Share data with team members only",
  },
  {
    id: "share_with:organization",
    kind: "DataCap",
    scope: "sharing",
    description: "Share data within the organization",
  },
  {
    id: "share_with:user",
    kind: "DataCap",
    scope: "sharing",
    description: "Share data with specific users only",
  },

  // Privacy and Security Capabilities
  {
    id: "pii_allowed",
    kind: "DataCap",
    scope: "privacy",
    description: "Handle personally identifiable information",
  },
  {
    id: "sensitive_data_allowed",
    kind: "DataCap",
    scope: "privacy",
    description: "Handle sensitive or confidential data",
  },
  {
    id: "financial_data_allowed",
    kind: "DataCap",
    scope: "privacy",
    description: "Handle financial and payment information",
  },
  {
    id: "medical_data_allowed",
    kind: "DataCap",
    scope: "privacy",
    description: "Handle medical and health information",
  },

  // Data Processing Capabilities
  {
    id: "data_transform_allowed",
    kind: "DataCap",
    scope: "processing",
    description: "Transform and modify data",
  },
  {
    id: "data_export_allowed",
    kind: "DataCap",
    scope: "processing",
    description: "Export data to external systems",
  },
  {
    id: "data_analyze_allowed",
    kind: "DataCap",
    scope: "processing",
    description: "Analyze and derive insights from data",
  },

  // Geographic and Compliance Capabilities
  {
    id: "gdpr_compliant",
    kind: "DataCap",
    scope: "compliance",
    description: "Handle data in GDPR-compliant manner",
  },
  {
    id: "hipaa_compliant",
    kind: "DataCap",
    scope: "compliance",
    description: "Handle data in HIPAA-compliant manner",
  },
  {
    id: "region:eu",
    kind: "DataCap",
    scope: "geographic",
    description: "Data can be processed in EU region",
  },
  {
    id: "region:us",
    kind: "DataCap",
    scope: "geographic",
    description: "Data can be processed in US region",
  },
];

export const TOOL_CAPABILITY_REGISTRY: Record<string, string[]> = {
  // Data operations
  fetch_data: ["READ_FILE", "READ_DATABASE"],
  search_entities: ["READ_DATABASE"],
  create_document: ["WRITE_FILE"],
  analyze_content: [],
  transform_data: [],

  // Communication operations
  send_message: ["SEND_EMAIL"],
  send_notification: ["SEND_WEBHOOK"],
  send_sms: ["SEND_SMS"],

  // File operations
  read_file: ["READ_FILE"],
  write_file: ["WRITE_FILE"],
  list_files: ["LIST_FILES"],
  delete_file: ["DELETE_FILE"],

  // Network operations
  http_request: ["HTTP_REQUEST"],
  fetch_url: ["FETCH_URL"],
  search_web: ["SEARCH_WEB"],

  // System operations
  execute_command: ["EXECUTE_COMMAND"],
  schedule_task: ["SCHEDULE_TASK"],

  // Database operations
  query_database: ["READ_DATABASE"],
  update_database: ["WRITE_DATABASE"],
};

export class CapabilityRegistry {
  private capabilities: Map<string, Capability>;
  private toolRegistry: Record<string, string[]>;

  constructor() {
    this.capabilities = new Map();
    this.toolRegistry = { ...TOOL_CAPABILITY_REGISTRY };
    
    // Initialize with default capabilities
    for (const capability of DEFAULT_CAPABILITIES) {
      this.capabilities.set(capability.id, capability);
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

  listToolCapabilities(): Capability[] {
    return Array.from(this.capabilities.values()).filter(
      cap => cap.kind === "ToolCap"
    );
  }

  listDataCapabilities(): Capability[] {
    return Array.from(this.capabilities.values()).filter(
      cap => cap.kind === "DataCap"
    );
  }

  getCapabilitiesByScope(scope: string): Capability[] {
    return Array.from(this.capabilities.values()).filter(
      cap => cap.scope === scope
    );
  }

  registerTool(operation: string, requiredCapabilities: string[]): void {
    this.toolRegistry[operation] = requiredCapabilities;
  }

  getToolRequirements(operation: string): string[] {
    return this.toolRegistry[operation] || [];
  }

  getToolRegistry(): Record<string, string[]> {
    return { ...this.toolRegistry };
  }

  validateCapability(capabilityId: string): boolean {
    return this.capabilities.has(capabilityId);
  }

  validateToolOperation(operation: string, declaredCapabilities: string[]): {
    valid: boolean;
    missing: string[];
    invalid: string[];
  } {
    const requiredCapabilities = this.getToolRequirements(operation);
    const missing = requiredCapabilities.filter(
      cap => !declaredCapabilities.includes(cap)
    );
    const invalid = declaredCapabilities.filter(
      cap => !this.validateCapability(cap)
    );

    return {
      valid: missing.length === 0 && invalid.length === 0,
      missing,
      invalid,
    };
  }

  createCapabilityHierarchy(): Record<string, string[]> {
    const hierarchy: Record<string, string[]> = {};
    
    for (const capability of this.capabilities.values()) {
      if (!hierarchy[capability.scope]) {
        hierarchy[capability.scope] = [];
      }
      hierarchy[capability.scope].push(capability.id);
    }

    return hierarchy;
  }

  exportCapabilities(): Capability[] {
    return this.listCapabilities();
  }

  importCapabilities(capabilities: Capability[]): void {
    for (const capability of capabilities) {
      this.addCapability(capability);
    }
  }
}

export const globalCapabilityRegistry = new CapabilityRegistry();