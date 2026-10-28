import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sparkDataRoot } from '../../../out/spark/data-path.mjs';
import { digestAccessToken, normalizeAccessToken } from './auth.mjs';
import {
  DEFAULT_COMMAND_HEARTBEAT_MS,
  DEFAULT_COMMAND_INITIAL_WAIT_MS,
  DEFAULT_COMMAND_REQUEST_SEGMENT_MS,
  DEFAULT_COMMAND_TIMEOUT_MS,
  DEFAULT_HEALTH_PATH,
  DEFAULT_HOST,
  DEFAULT_HTTP_REQUEST_TIMEOUT_MS,
  DEFAULT_MAX_COMMAND_OUTPUT_BYTES,
  DEFAULT_MAX_READ_BYTES,
  DEFAULT_MCP_PATH,
  DEFAULT_OPERATION_TIMEOUT_MS,
  DEFAULT_PORT,
  DEFAULT_SERVER_CLOSE_TIMEOUT_MS,
} from './constants.mjs';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const MODULE_ROOT = path.resolve(MODULE_DIR, '..');
export const PROJECT_ROOT = path.resolve(MODULE_DIR, '..', '..', '..');
export const RUNTIME_CONFIG_PATH = path.join(PROJECT_ROOT, '.runtime', 'config', 'spark.local.json');
export const ACCESS_TOKEN_PATH = path.join(PROJECT_ROOT, '.runtime', 'secrets', 'Access_token');
export const USER_DATA_ROOT = sparkDataRoot({ projectRoot: PROJECT_ROOT });
const ROOT_PERMISSION_ORDER = Object.freeze(['R', 'W', 'X']);

// Local private configuration is never loaded from a source module.
// Explicit configPath and existing SPARK_CONFIG remain for controlled deployments/tests.
export function resolveConfigPath({ override, envPath, runtimePath = RUNTIME_CONFIG_PATH } = {}) {
  if (override) return path.resolve(override);
  if (envPath && fs.existsSync(envPath)) return path.resolve(envPath);
  return path.resolve(runtimePath);
}

function positiveInteger(value, fallback, name) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function readJsonIfExists(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw new Error(`failed to read config ${filePath}: ${error.message}`);
  }
}

function resolveLogDirectory(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw new Error('logging.logDir / SPARK_LOG_DIR must be an absolute path');
  }
  const logDir = path.resolve(value);
  const relative = path.relative(PROJECT_ROOT, logDir);
  const insideRepo = !relative || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
  const approvedLog = path.join(PROJECT_ROOT, 'log');
  const relativeToLog = path.relative(approvedLog, logDir);
  const insideApprovedLogCategory = Boolean(relativeToLog) && relativeToLog !== '..' &&
    !relativeToLog.startsWith('..' + path.sep) && !path.isAbsolute(relativeToLog);
  if (insideRepo && !insideApprovedLogCategory) {
    throw new Error('SPARK logs inside the source repository are allowed only under log/<category>');
  }
  if (!fs.existsSync(logDir) || !fs.statSync(logDir).isDirectory()) {
    throw new Error('Log directory must already exist: user agreement is required before creating a folder');
  }
  return logDir;
}

function resolveStateDirectory(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('transport.stateDir must be a path');
  const resolved = path.isAbsolute(value) ? path.resolve(value) : path.resolve(PROJECT_ROOT, value);
  const privateRoot = path.join(PROJECT_ROOT, '.runtime');
  const relative = path.relative(privateRoot, resolved);
  if (!relative || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))) {
    throw new Error('transport.stateDir cannot use credential-only .runtime');
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error('transport.stateDir must be a pre-existing user-approved directory');
  }
  return resolved;
}

function normalizeRootPermissions(value, index) {
  if (value === undefined || value === null || value === '') return 'RWX';
  if (typeof value !== 'string') throw new Error(`transport.allowedRoot[${index}].permissions must be a string containing R, W and/or X`);
  const compact = value.toUpperCase().replace(/[\s,]+/g, '');
  if (!compact || /[^RWX]/.test(compact)) {
    throw new Error(`transport.allowedRoot[${index}].permissions must contain only R, W and/or X`);
  }
  return ROOT_PERMISSION_ORDER.filter((permission) => compact.includes(permission)).join('');
}

function normalizeAllowedRoots(value) {
  const raw = Array.isArray(value) ? value : [value];
  if (raw.length === 0) throw new Error('transport.allowedRoot must contain at least one path');

  const rootPolicies = raw.map((entry, index) => {
    if (typeof entry === 'string') {
      if (entry.trim() === '') throw new Error(`transport.allowedRoot[${index}] must be a non-empty string path`);
      return { path: path.resolve(entry), permissions: 'RWX' };
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`transport.allowedRoot[${index}] must be a path string or { path, permissions } object`);
    }
    if (typeof entry.path !== 'string' || entry.path.trim() === '') {
      throw new Error(`transport.allowedRoot[${index}].path must be a non-empty string path`);
    }
    return {
      path: path.resolve(entry.path),
      permissions: normalizeRootPermissions(entry.permissions, index),
    };
  });

  const seen = new Set();
  for (const rootPolicy of rootPolicies) {
    const key = process.platform === 'win32' ? rootPolicy.path.toLowerCase() : rootPolicy.path;
    if (seen.has(key)) throw new Error(`transport.allowedRoot contains a duplicate path: ${rootPolicy.path}`);
    seen.add(key);
  }
  return rootPolicies;
}

function normalizeMcpAuth({ transport, overrides }) {
  if (transport.auth !== undefined) {
    throw new Error('transport.auth is no longer supported; remove it from config. SPARK authentication is controlled by .runtime/secrets/Access_token');
  }

  const secretPath = path.resolve(overrides.accessTokenPath ?? ACCESS_TOKEN_PATH);
  let rawToken;
  try {
    rawToken = fs.readFileSync(secretPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { mode: 'missing', bearerTokenSha256: '' };
    }
    throw new Error(`failed to read Access_token ${secretPath}: ${error.message}`);
  }
  const token = normalizeAccessToken(rawToken);
  return { mode: 'bearer', bearerTokenSha256: digestAccessToken(token) };
}

function resolveTunnelClientDir(configuredDir) {
  const current = path.join(PROJECT_ROOT, 'mod', 'spark_transport', 'tool', 'tunnel_client');
  const legacy = path.join(PROJECT_ROOT, 'mod', 'transport', 'tool', 'tunnel_client');
  const selected = path.resolve(PROJECT_ROOT, configuredDir ?? path.join('mod', 'spark_transport', 'tool', 'tunnel_client'));
  // Existing private configurations may name the pre-rename directory.
  // Resolve that exact former bundled path without reading or modifying the private config.
  if ((process.platform === 'win32'
      ? selected.toLowerCase() === legacy.toLowerCase()
      : selected === legacy) &&
      !fs.existsSync(legacy) && fs.existsSync(current)) {
    return current;
  }
  return selected;
}

export function loadConfig(overrides = {}) {
  const env = process.env;
  const configPath = resolveConfigPath({ override: overrides.configPath, envPath: env.SPARK_CONFIG });
  const file = readJsonIfExists(configPath);
  const transport = file.transport ?? {};
  const tunnel = file.tunnel ?? {};
  const logging = file.logging ?? {};

  const configuredRoots = overrides.root ?? env.SPARK_ROOT ?? transport.allowedRoot;
  if (!configuredRoots || (Array.isArray(configuredRoots) && configuredRoots.length === 0)) {
    throw new Error('allowed root is required: set transport.allowedRoot in config or SPARK_ROOT');
  }
  const rootPolicies = normalizeAllowedRoots(configuredRoots);
  const roots = rootPolicies.map((entry) => entry.path);

  return {
    configPath,
    root: roots[0],
    roots,
    rootPolicies,
    host: overrides.host ?? env.SPARK_HOST ?? transport.host ?? DEFAULT_HOST,
    port: positiveInteger(overrides.port ?? env.SPARK_PORT ?? transport.port, DEFAULT_PORT, 'port'),
    mcpPath: overrides.mcpPath ?? env.SPARK_MCP_PATH ?? transport.mcpPath ?? DEFAULT_MCP_PATH,
    healthPath: overrides.healthPath ?? env.SPARK_HEALTH_PATH ?? transport.healthPath ?? DEFAULT_HEALTH_PATH,
    maxReadBytes: positiveInteger(overrides.maxReadBytes ?? env.SPARK_MAX_READ_BYTES ?? transport.maxReadBytes, DEFAULT_MAX_READ_BYTES, 'maxReadBytes'),
    commandTimeoutMs: positiveInteger(overrides.commandTimeoutMs ?? env.SPARK_COMMAND_TIMEOUT_MS ?? transport.commandTimeoutMs, DEFAULT_COMMAND_TIMEOUT_MS, 'commandTimeoutMs'),
    commandHeartbeatMs: positiveInteger(overrides.commandHeartbeatMs ?? env.SPARK_COMMAND_HEARTBEAT_MS ?? transport.commandHeartbeatMs, DEFAULT_COMMAND_HEARTBEAT_MS, 'commandHeartbeatMs'),
    commandInitialWaitMs: positiveInteger(overrides.commandInitialWaitMs ?? env.SPARK_COMMAND_INITIAL_WAIT_MS ?? transport.commandInitialWaitMs, DEFAULT_COMMAND_INITIAL_WAIT_MS, 'commandInitialWaitMs'),
    commandRequestSegmentMs: positiveInteger(overrides.commandRequestSegmentMs ?? env.SPARK_COMMAND_REQUEST_SEGMENT_MS ?? transport.commandRequestSegmentMs, DEFAULT_COMMAND_REQUEST_SEGMENT_MS, 'commandRequestSegmentMs'),
    operationTimeoutMs: positiveInteger(overrides.operationTimeoutMs ?? env.SPARK_OPERATION_TIMEOUT_MS ?? transport.operationTimeoutMs, DEFAULT_OPERATION_TIMEOUT_MS, 'operationTimeoutMs'),
    httpRequestTimeoutMs: positiveInteger(overrides.httpRequestTimeoutMs ?? env.SPARK_HTTP_REQUEST_TIMEOUT_MS ?? transport.httpRequestTimeoutMs, DEFAULT_HTTP_REQUEST_TIMEOUT_MS, 'httpRequestTimeoutMs'),
    serverCloseTimeoutMs: positiveInteger(overrides.serverCloseTimeoutMs ?? env.SPARK_SERVER_CLOSE_TIMEOUT_MS ?? transport.serverCloseTimeoutMs, DEFAULT_SERVER_CLOSE_TIMEOUT_MS, 'serverCloseTimeoutMs'),
    maxCommandOutputBytes: positiveInteger(overrides.maxCommandOutputBytes ?? env.SPARK_MAX_COMMAND_OUTPUT_BYTES ?? transport.maxCommandOutputBytes, DEFAULT_MAX_COMMAND_OUTPUT_BYTES, 'maxCommandOutputBytes'),
    stateDir: resolveStateDirectory(overrides.stateDir ?? env.SPARK_STATE_DIR ?? transport.stateDir ?? path.join(PROJECT_ROOT, 'log', 'system')),
    durableLedgerDir: path.join(USER_DATA_ROOT, 'audit'),
    logDir: resolveLogDirectory(overrides.logDir ?? env.SPARK_LOG_DIR ?? logging.logDir ?? path.join(PROJECT_ROOT, 'log', 'system')),
    recycleBin: transport.recycleBin !== false,
    auth: normalizeMcpAuth({ transport, overrides: {
      ...overrides,
      accessTokenPath: overrides.accessTokenPath ?? (env.NODE_ENV === 'test' ? env.SPARK_TEST_ACCESS_TOKEN_PATH : undefined),
    } }),
    tunnel: {
      enabled: tunnel.enabled !== false,
      id: env.SPARK_TUNNEL_ID ?? tunnel.id ?? '',
      profile: tunnel.profile ?? 'spark',
      localMcpUrl: tunnel.localMcpUrl ?? `http://127.0.0.1:${positiveInteger(transport.port, DEFAULT_PORT, 'port')}${transport.mcpPath ?? DEFAULT_MCP_PATH}`,
      clientVersion: tunnel.clientVersion ?? 'v0.0.14',
      clientDir: resolveTunnelClientDir(tunnel.clientDir),
    },
  };
}
