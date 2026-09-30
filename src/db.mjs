/**
 * Una base por proceso y migraciones transaccionales. environment_lock impide reutilizar TEST como PROD. PGlite es local; PostgreSQL sirve para despliegue.
 */
import { readFile } from 'node:fs/promises';
export async function openDatabase(config) {
  let db;
  if (config.databaseUrl) {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
    db = {
      query: (sql, args = []) => pool.query(sql, args),
      exec: (sql) => pool.query(sql),
      transaction: async (fn) => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const value = await fn({ query: (sql, args = []) => client.query(sql, args), exec: sql => client.query(sql) });
          await client.query('COMMIT');
          return value;
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
      },
      close: () => pool.end(),
    };
  } else {
    if (config.environment !== 'test' && !config.localPreview) throw new Error('La base embebida solo está habilitada para test');
    const { PGlite } = await import('@electric-sql/pglite');
    const local = new PGlite(config.localData === ':memory:' ? undefined : config.localData);
    await local.waitReady;
    db = {
      query: (sql, args = []) => local.query(sql, args),
      exec: (sql) => local.exec(sql),
      transaction: (fn) => local.transaction(tx => fn({ query: (sql, args = []) => tx.query(sql, args), exec: sql => tx.exec(sql) })),
      close: () => local.close(),
    };
  }
  try {
    await db.transaction(async tx => {
      // Serialize migrations across the API and standalone workers on PostgreSQL.
      if (config.databaseUrl) await tx.query('SELECT pg_advisory_xact_lock(716482901)');
      await tx.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
      if (!(await tx.query('SELECT version FROM schema_migrations WHERE version=1')).rows.length) {
        await tx.exec(await readFile(new URL('../migrations/001_initial.sql', import.meta.url), 'utf8'));
        await tx.query('INSERT INTO schema_migrations (version) VALUES (1)');
      }
      await tx.query('INSERT INTO environment_lock (id, environment, audax_mode) VALUES (1, $1, $2) ON CONFLICT DO NOTHING', [config.environment, config.mode]);
      if (!(await tx.query('SELECT version FROM schema_migrations WHERE version=2')).rows.length) {
        await tx.exec(await readFile(new URL('../migrations/002_test_connection.sql', import.meta.url), 'utf8'));
        await tx.query('INSERT INTO schema_migrations (version) VALUES (2)');
      }
      if (!(await tx.query('SELECT version FROM schema_migrations WHERE version=3')).rows.length) {
        await tx.exec(await readFile(new URL('../migrations/003_environments.sql', import.meta.url), 'utf8'));
        await tx.query('INSERT INTO schema_migrations(version) VALUES(3)');
      }
      const row = (await tx.query('SELECT environment,audax_mode FROM environment_lock WHERE id = 1')).rows[0];
      if (config.allowTestLiveMigration && row.environment === 'test' && config.environment === 'test' && row.audax_mode === 'mock' && config.mode === 'live') {
        await tx.query("UPDATE environment_lock SET audax_mode='live' WHERE id=1");
        await tx.query('DELETE FROM access_tokens');
        row.audax_mode = 'live';
      }
      if (row.environment !== config.environment || row.audax_mode !== config.mode) throw new Error('Esta base pertenece a otro ambiente o modo de conexión. Usá una base independiente.');
    });
  } catch (error) { await db.close(); throw error; }
  return db;
}
