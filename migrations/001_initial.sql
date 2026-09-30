CREATE TABLE IF NOT EXISTS environment_lock (
  id integer PRIMARY KEY CHECK (id = 1), environment text NOT NULL CHECK (environment IN ('test','prod')),
  audax_mode text NOT NULL CHECK (audax_mode IN ('mock','live'))
);
CREATE TABLE IF NOT EXISTS admins (
  id uuid PRIMARY KEY, username text NOT NULL UNIQUE, password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash text PRIMARY KEY, admin_id uuid NOT NULL REFERENCES admins(id),
  csrf_hash text NOT NULL, expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS clients (
  id uuid PRIMARY KEY, name text NOT NULL, company_name text NOT NULL, email text NOT NULL DEFAULT '',
  client_id text NOT NULL UNIQUE, secret_hash text NOT NULL, active boolean NOT NULL DEFAULT true,
  business_ids jsonb NOT NULL, plan_ids jsonb NOT NULL, scopes jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS access_tokens (
  token_hash text PRIMARY KEY, client_id uuid NOT NULL REFERENCES clients(id),
  environment text NOT NULL, scopes jsonb NOT NULL, expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS tokens_client_idx ON access_tokens(client_id);
CREATE INDEX IF NOT EXISTS tokens_expiry_idx ON access_tokens(expires_at);
CREATE TABLE IF NOT EXISTS operations (
  seq bigserial UNIQUE, id uuid PRIMARY KEY, client_id uuid NOT NULL REFERENCES clients(id),
  kind text NOT NULL CHECK (kind IN ('insert','update','upgrade','cancel')),
  idempotency_key text NOT NULL, payload_hash text NOT NULL, payload jsonb NOT NULL,
  membership_keys jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','submitted','finished','failed','unknown')),
  audax_process_id text, response jsonb, error jsonb,
  attempts integer NOT NULL DEFAULT 0, poll_attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(), lease_until timestamptz, lease_id uuid,
  tracking_started_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(client_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS operations_queue_idx ON operations(status, next_attempt_at, seq);
CREATE INDEX IF NOT EXISTS operations_client_idx ON operations(client_id, seq DESC);
CREATE TABLE IF NOT EXISTS operation_items (
  operation_id uuid NOT NULL REFERENCES operations(id), item_index integer NOT NULL,
  membership_key text NOT NULL, payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending', error jsonb,
  PRIMARY KEY(operation_id, item_index)
);
CREATE TABLE IF NOT EXISTS memberships (
  client_id uuid NOT NULL REFERENCES clients(id), membership_key text NOT NULL,
  payload jsonb NOT NULL, status text NOT NULL CHECK (status IN ('active','cancelled')),
  last_operation_id uuid NOT NULL REFERENCES operations(id), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(client_id, membership_key)
);
CREATE TABLE IF NOT EXISTS delivery_attempts (
  id bigserial PRIMARY KEY, operation_id uuid NOT NULL REFERENCES operations(id),
  phase text NOT NULL, http_status integer, result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS audit_events (
  id bigserial PRIMARY KEY, actor text NOT NULL, action text NOT NULL, target text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS mock_processes (
  id uuid PRIMARY KEY, fail boolean NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS worker_health (
  id integer PRIMARY KEY CHECK (id = 1), last_seen timestamptz NOT NULL
);
