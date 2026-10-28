import {
  APP_NAME,
  APP_VERSION,
  MCP_PROTOCOL_VERSION,
  META_CLIENT_CAPABILITIES,
  META_CLIENT_INFO,
  META_PROTOCOL_VERSION,
  META_SERVER_INFO,
} from './constants.mjs';
import { TOOL_DEFINITIONS } from './tools.mjs';

const JSONRPC_VERSION = '2.0';

const AGENT_INSTRUCTIONS = [
  'SPARK is the selected direct local execution bridge for allowed-root filesystem operations and non-elevated command execution.',
  'When a user asks for an operation that SPARK can perform, use these MCP tools directly in the current chat. Do not redirect or hand off the task to Work merely because it reads, writes, moves, renames, deletes, or executes local resources.',
  'For rename or move requests, call move_path directly. Do not create a workspace-visible sidecar backup, pre-rename copy, or temporary backup unless the user explicitly requests one.',
  'write_file and modify_file do NOT create PAL recovery snapshots. Before changing tracked source, create and verify a Git checkpoint/ref that preserves any staged and unstaged changes. For non-Git files, do not claim Git can restore them: use a separately authorized recovery plan or refuse the destructive change.',
  'If you create any temporary workspace artifact for your own execution, remove it before reporting success. Use delete_path so cleanup remains recoverable through the Windows Recycle Bin.',
  'Mutations remain allowed-root confined. delete_path uses the Windows Recycle Bin and has no permanent-delete fallback.',
  'For run_command that may legitimately take minutes, hours, or days, omit timeoutMs unless the user or operation provides a real terminal deadline; there is no default absolute runtime deadline.',
  'If run_command returns structuredContent.data.status=working with a continuation object, immediately call run_command again using exactly continuation.command and continuation.args in the current assistant turn. Do not ask the user to poll, continue, or confirm normal continuation.',
  'The backward-compatible continuation control commands are returned by SPARK inside the tool result and fit the existing command/args schema. Reuse the returned continuation exactly after transport/stream failure; never restart the original executable merely because one MCP request failed.',
  'Do not blindly rerun a terminally failed, cancelled, or timed-out mutation. Reconcile the actual filesystem/process/Git state first, and permit at most one new-process retry for the same logical task.',
].join(' ');

function serverMeta() {
  return { [META_SERVER_INFO]: { name: APP_NAME, version: APP_VERSION } };
}

function completeResult(result) {
  return {
    resultType: 'complete',
    ...result,
    _meta: { ...(result?._meta ?? {}), ...serverMeta() },
  };
}

function response(id, result) {
  return { jsonrpc: JSONRPC_VERSION, id, result };
}

function errorResponse(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: JSONRPC_VERSION, id: id ?? null, error };
}

export function validateModernRequest({ headers, body }) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || body.jsonrpc !== JSONRPC_VERSION || typeof body.method !== 'string') {
    return { ok: false, status: 400, error: errorResponse(body?.id, -32600, 'Invalid Request') };
  }
  if (!Object.prototype.hasOwnProperty.call(body, 'id')) return { ok: false, notification: true };
  const hv = headers['mcp-protocol-version'];
  if (hv === undefined) return { ok: false, status: 400, error: errorResponse(body.id, -32020, 'Missing required MCP-Protocol-Version header') };
  if (hv !== MCP_PROTOCOL_VERSION) return { ok: false, status: 400, error: errorResponse(body.id, -32022, 'Unsupported protocol version', { supported: [MCP_PROTOCOL_VERSION] }) };
  const params = body.params && typeof body.params === 'object' && !Array.isArray(body.params) ? body.params : {};
  const meta = params._meta;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return { ok: false, status: 400, error: errorResponse(body.id, -32602, 'Missing required request _meta envelope') };
  if (meta[META_PROTOCOL_VERSION] !== MCP_PROTOCOL_VERSION) return { ok: false, status: 400, error: errorResponse(body.id, -32020, 'Header/body protocol version mismatch') };
  if (!meta[META_CLIENT_CAPABILITIES] || typeof meta[META_CLIENT_CAPABILITIES] !== 'object' || Array.isArray(meta[META_CLIENT_CAPABILITIES])) return { ok: false, status: 400, error: errorResponse(body.id, -32602, 'Missing required client capabilities') };
  if (meta[META_CLIENT_INFO] !== undefined) {
    const ci = meta[META_CLIENT_INFO];
    if (!ci || typeof ci !== 'object' || typeof ci.name !== 'string' || typeof ci.version !== 'string') return { ok: false, status: 400, error: errorResponse(body.id, -32602, 'Malformed clientInfo metadata') };
  }
  if (headers['mcp-method'] !== body.method) return { ok: false, status: 400, error: errorResponse(body.id, -32020, 'Mcp-Method header does not match JSON-RPC method') };
  if (body.method === 'tools/call') {
    const bodyName = params.name;
    if (typeof bodyName !== 'string' || headers['mcp-name'] !== bodyName) return { ok: false, status: 400, error: errorResponse(body.id, -32020, 'Mcp-Name header does not match tool name') };
  }
  return { ok: true, params };
}

export function createMcpDispatcher({ toolRuntime }) {
  async function dispatch(body, context = {}) {
    const params = body.params && typeof body.params === 'object' && !Array.isArray(body.params) ? body.params : {};
    if (body.method === 'server/discover') {
      return response(body.id, completeResult({
        supportedVersions: [MCP_PROTOCOL_VERSION],
        capabilities: { tools: {} },
        instructions: AGENT_INSTRUCTIONS,
        ttlMs: 0,
        cacheScope: 'private',
      }));
    }
    if (body.method === 'tools/list') return response(body.id, completeResult({ tools: TOOL_DEFINITIONS, ttlMs: 0, cacheScope: 'private' }));
    if (body.method === 'tools/call') {
      if (typeof params.name !== 'string') return errorResponse(body.id, -32602, 'Invalid params: tool name is required');
      if (!TOOL_DEFINITIONS.find((x) => x.name === params.name)) return errorResponse(body.id, -32602, `Unknown tool: ${params.name}`);
      const structured = await toolRuntime.call(params.name, params.arguments ?? {}, context);
      return response(body.id, completeResult({
        content: [{ type: 'text', text: JSON.stringify(structured) }],
        structuredContent: structured,
        isError: structured.ok !== true,
      }));
    }
    return errorResponse(body.id, -32601, 'Method not found');
  }
  return { dispatch };
}
