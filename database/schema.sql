-- POC Intent Router Database Schema
-- Using DuckDB with duckpgq extension for property graph support

INSTALL 'vss';
INSTALL 'json';
LOAD 'vss';
LOAD 'json';

-- Core data model tables

CREATE TABLE prompts (
    id UUID PRIMARY KEY DEFAULT uuid(),
    content TEXT NOT NULL,
    timestamp TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    metadata JSON DEFAULT '{}'
);

CREATE TABLE plans (
    id UUID PRIMARY KEY DEFAULT uuid(),
    prompt_id UUID NOT NULL REFERENCES prompts(id),
    steps JSON NOT NULL, -- Array of Step objects
    timestamp TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    status VARCHAR(20) CHECK (status IN ('pending', 'in_progress', 'completed', 'failed')) DEFAULT 'pending'
);

CREATE TABLE entities (
    id UUID PRIMARY KEY DEFAULT uuid(),
    content TEXT NOT NULL,
    embedding FLOAT[384], -- OpenAI text-embedding-3-small dimension
    capabilities TEXT[] DEFAULT '{}', -- Array of capability IDs
    metadata JSON DEFAULT '{}',
    timestamp TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE events (
    id UUID PRIMARY KEY DEFAULT uuid(),
    plan_id UUID NOT NULL REFERENCES plans(id),
    step_index INTEGER NOT NULL,
    op VARCHAR(100) NOT NULL,
    produces UUID[] DEFAULT '{}', -- Array of entity IDs
    consumes UUID[] DEFAULT '{}', -- Array of entity IDs
    result JSON,
    error TEXT,
    timestamp TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE capabilities (
    id VARCHAR(100) PRIMARY KEY,
    kind VARCHAR(20) CHECK (kind IN ('ToolCap', 'DataCap')) NOT NULL,
    scope VARCHAR(100) NOT NULL,
    description TEXT
);

CREATE TABLE view_specs (
    id UUID PRIMARY KEY DEFAULT uuid(),
    generated_from UUID[] NOT NULL, -- Array of entity IDs
    spec JSON NOT NULL,
    timestamp TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for performance

CREATE INDEX idx_plans_prompt_id ON plans(prompt_id);
CREATE INDEX idx_plans_status ON plans(status);
CREATE INDEX idx_events_plan_id ON events(plan_id);
CREATE INDEX idx_events_timestamp ON events(timestamp);
CREATE INDEX idx_entities_timestamp ON entities(timestamp);

-- Vector similarity index for entity embeddings
CREATE INDEX idx_entities_embedding ON entities 
USING HNSW (embedding) 
WITH (metric = 'cosine');

-- Graph edges for relationships (using arrays for now, could extend with duckpgq)

CREATE TABLE entity_relations (
    from_entity UUID NOT NULL REFERENCES entities(id),
    to_entity UUID NOT NULL REFERENCES entities(id),
    relation_type VARCHAR(50) NOT NULL, -- 'RELATES_TO', 'PART_OF', etc.
    metadata JSON DEFAULT '{}',
    timestamp TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (from_entity, to_entity, relation_type)
);

CREATE TABLE plan_dependencies (
    plan_id UUID NOT NULL REFERENCES plans(id),
    step_index INTEGER NOT NULL,
    depends_on_step INTEGER NOT NULL,
    PRIMARY KEY (plan_id, step_index, depends_on_step)
);

-- Insert default capabilities

INSERT INTO capabilities (id, kind, scope, description) VALUES
('READ_FILE', 'ToolCap', 'fs', 'Read files from filesystem'),
('WRITE_FILE', 'ToolCap', 'fs', 'Write files to filesystem'),
('SEND_EMAIL', 'ToolCap', 'smtp', 'Send email messages'),
('HTTP_REQUEST', 'ToolCap', 'network', 'Make HTTP requests'),
('SEARCH_WEB', 'ToolCap', 'network', 'Search the web'),
('share_with:public', 'DataCap', 'sharing', 'Share data publicly'),
('share_with:team', 'DataCap', 'sharing', 'Share data with team members'),
('pii_allowed', 'DataCap', 'privacy', 'Handle personally identifiable information');

-- Views for common queries

CREATE VIEW plan_execution_status AS
SELECT 
    p.id as plan_id,
    p.prompt_id,
    p.status,
    COUNT(e.id) as executed_steps,
    json_array_length(p.steps) as total_steps,
    MIN(e.timestamp) as started_at,
    MAX(e.timestamp) as last_activity
FROM plans p
LEFT JOIN events e ON p.id = e.plan_id
GROUP BY p.id, p.prompt_id, p.status, p.steps;

CREATE VIEW entity_lineage AS
SELECT 
    e.id as entity_id,
    ev.plan_id,
    ev.step_index,
    ev.op,
    ev.timestamp as created_at
FROM entities e
JOIN events ev ON e.id = ANY(ev.produces)
ORDER BY ev.timestamp;