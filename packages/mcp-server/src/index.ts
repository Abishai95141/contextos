/**
 * ContextOS MCP Server
 *
 * Universal entry point for all MCP-capable AI agents.
 * Exposes Feature Packs as Resources, Context Packs as searchable Resources,
 * and policy checks as Tools.
 */

// TODO: Phase 1 implementation
// - Initialize MCP SDK with HTTP transport
// - Register tools: get_feature_pack, save_context_pack, check_policy,
//   query_run_history, search_packs_nl, record_decision
// - Register resources: feature-pack://{id}, context-pack://{id}, run-history://{issue}
// - Connect to PostgreSQL via @contextos/db

const MCP_SERVER_PORT = process.env.MCP_SERVER_PORT ?? 3100;

console.log(`ContextOS MCP Server — starting on port ${MCP_SERVER_PORT}`);
console.log("Phase 1: Implement MCP tools and resources");
