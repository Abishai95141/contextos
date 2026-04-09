/**
 * ContextOS Hooks Bridge
 *
 * HTTP server that receives Claude Code lifecycle hooks and
 * routes them to ContextOS backend services.
 */

const HOOKS_BRIDGE_PORT = process.env.HOOKS_BRIDGE_PORT ?? 3101;

console.log(`ContextOS Hooks Bridge — starting on port ${HOOKS_BRIDGE_PORT}`);
console.log("Phase 2: Implement hook handlers");
