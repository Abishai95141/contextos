/**
 * ContextOS Hooks Bridge
 *
 * HTTP server that receives Claude Code lifecycle hooks and
 * routes them to ContextOS backend services.
 */

import { config } from './config.js';

console.log(`ContextOS Hooks Bridge — starting on port ${config.HOOKS_BRIDGE_PORT}`);
console.log('Phase 2: Implement hook handlers');
