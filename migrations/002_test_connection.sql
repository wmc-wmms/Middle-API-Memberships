-- Preserve which transport produced previous data before moving the local demo to real TEST.
ALTER TABLE operations ADD COLUMN audax_mode text;
UPDATE operations SET audax_mode=(SELECT audax_mode FROM environment_lock WHERE id=1);
ALTER TABLE operations ALTER COLUMN audax_mode SET NOT NULL;
ALTER TABLE operations ADD CONSTRAINT operations_mode_check CHECK(audax_mode IN ('mock','live'));
ALTER TABLE operations ADD COLUMN connection_fingerprint text;
ALTER TABLE operations ADD COLUMN source text NOT NULL DEFAULT 'api' CHECK(source IN ('api','manual'));
ALTER TABLE operations ADD COLUMN created_by text;
ALTER TABLE memberships ADD COLUMN audax_mode text;
UPDATE memberships SET audax_mode=(SELECT audax_mode FROM environment_lock WHERE id=1);
ALTER TABLE memberships ALTER COLUMN audax_mode SET NOT NULL;
ALTER TABLE memberships DROP CONSTRAINT memberships_pkey;
ALTER TABLE memberships ADD PRIMARY KEY(client_id,membership_key,audax_mode);
ALTER TABLE clients ADD COLUMN business_plan_pairs jsonb NOT NULL DEFAULT '[]';

CREATE TABLE audax_settings (
  id integer PRIMARY KEY CHECK(id=1), environment text NOT NULL CHECK(environment='test'),
  client_id text NOT NULL DEFAULT '', scope text NOT NULL DEFAULT '', secret_encrypted text,
  fingerprint text NOT NULL DEFAULT '', revision integer NOT NULL DEFAULT 0,
  verified_at timestamptz, last_error text, updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO audax_settings(id,environment) VALUES(1,'test');
CREATE TABLE catalog_sync_runs (
  id uuid PRIMARY KEY, fingerprint text NOT NULL, settings_revision integer NOT NULL,
  status text NOT NULL CHECK(status IN ('queued','running','finished','failed')),
  requested_by text NOT NULL, counts jsonb NOT NULL DEFAULT '{}', warnings jsonb NOT NULL DEFAULT '[]',
  error text, lease_id uuid, lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz
);
CREATE UNIQUE INDEX one_catalog_sync ON catalog_sync_runs ((1)) WHERE status IN ('queued','running');
CREATE TABLE catalog_entries (
  fingerprint text NOT NULL, catalog text NOT NULL,
  external_id text NOT NULL, name text NOT NULL, data jsonb NOT NULL,
  active boolean NOT NULL DEFAULT true, synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(fingerprint,catalog,external_id)
);
CREATE TABLE business_plan_links (
  fingerprint text NOT NULL, business_id text NOT NULL, plan_id text NOT NULL,
  source text NOT NULL CHECK(source IN ('audax','admin')), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(fingerprint,business_id,plan_id)
);
