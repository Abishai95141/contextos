export * from './schema.js';

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

/**
 * Create a Drizzle database instance connected to the given DATABASE_URL.
 * Call once at app startup and re-use the returned instance.
 */
export function createDb(databaseUrl: string, poolSize = 10) {
  // prepare: false is required for Supabase transaction-mode pooler (port 6543)
  // and safe to set unconditionally for session-mode pooler and direct connections.
  const sql = postgres(databaseUrl, { max: poolSize, prepare: false });
  return drizzle(sql, { schema });
}

export type Db = ReturnType<typeof createDb>;
