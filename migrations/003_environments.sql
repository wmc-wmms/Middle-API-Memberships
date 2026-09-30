-- Same schema, independent databases. Credentials inherit the database's immutable environment.
ALTER TABLE audax_settings DROP CONSTRAINT audax_settings_environment_check;
UPDATE audax_settings SET environment=(SELECT environment FROM environment_lock WHERE id=1);
ALTER TABLE audax_settings ADD CONSTRAINT audax_settings_environment_check CHECK(environment IN ('test','prod'));
