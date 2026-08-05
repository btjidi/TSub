
CREATE TABLE IF NOT EXISTS subscriptions (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);


CREATE TABLE IF NOT EXISTS profiles (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);


CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_updated_at ON subscriptions(updated_at);
CREATE INDEX IF NOT EXISTS idx_profiles_updated_at ON profiles(updated_at);
CREATE INDEX IF NOT EXISTS idx_settings_updated_at ON settings(updated_at);

CREATE TABLE IF NOT EXISTS deployments (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT '',
    config_revision INTEGER NOT NULL DEFAULT 1,
    data TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS deployment_operations (
    id TEXT PRIMARY KEY,
    deployment_id TEXT NOT NULL,
    action TEXT NOT NULL,
    status TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME,
    FOREIGN KEY(deployment_id) REFERENCES deployments(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS deployment_events (
    id TEXT PRIMARY KEY,
    operation_id TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(operation_id) REFERENCES deployment_operations(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS deployment_snapshots (
    deployment_id TEXT PRIMARY KEY,
    push_generation TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    snapshot_hash TEXT NOT NULL,
    data TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(deployment_id) REFERENCES deployments(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS deployment_commands (
    id TEXT PRIMARY KEY,
    deployment_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    action TEXT NOT NULL,
    status TEXT NOT NULL,
    lease_id TEXT,
    lease_expires_at DATETIME,
    expires_at DATETIME NOT NULL,
    data TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(deployment_id) REFERENCES deployments(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS deployment_agents (
    deployment_id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL,
    generation INTEGER NOT NULL DEFAULT 1,
    revoked_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(deployment_id) REFERENCES deployments(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS deployment_heartbeats (
    deployment_id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    last_seen_at DATETIME NOT NULL,
    FOREIGN KEY(deployment_id) REFERENCES deployments(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS controller_transfers (
    id TEXT PRIMARY KEY,
    deployment_id TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    expires_at DATETIME NOT NULL,
    data TEXT NOT NULL DEFAULT '{}',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(deployment_id) REFERENCES deployments(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS storage_control (
    id TEXT PRIMARY KEY,
    active_storage TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'idle',
    epoch INTEGER NOT NULL DEFAULT 1,
    data TEXT NOT NULL DEFAULT '{}',
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS storage_migrations (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    target TEXT NOT NULL,
    phase TEXT NOT NULL,
    data TEXT NOT NULL DEFAULT '{}',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS scheduler_leases (
    name TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    lease_until DATETIME NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_deployments_status_updated ON deployments(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_operations_deployment_created ON deployment_operations(deployment_id, created_at);
CREATE INDEX IF NOT EXISTS idx_events_operation_created ON deployment_events(operation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_commands_claim ON deployment_commands(deployment_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_commands_lease ON deployment_commands(status, lease_expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_commands_one_active ON deployment_commands(deployment_id)
    WHERE status IN ('pending', 'claimed', 'running');
CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_token_hash ON deployment_agents(token_hash);
CREATE INDEX IF NOT EXISTS idx_heartbeats_seen ON deployment_heartbeats(last_seen_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_controller_transfers_token ON controller_transfers(token_hash);
CREATE INDEX IF NOT EXISTS idx_controller_transfers_expiry ON controller_transfers(status, expires_at);
