/**
 * Database connection for MCP Server.
 * Uses createDb factory from @contextos/db.
 */

import { createDb } from '@contextos/db';
import { config } from '../config.js';

export const db = createDb(config.DATABASE_URL);
