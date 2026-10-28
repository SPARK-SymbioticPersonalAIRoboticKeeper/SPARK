import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { loadConfig, resolveConfigPath } from '../src/config.mjs';
import { createPathPolicy } from '../src/path-policy.mjs';
import { createToolRuntime } from '../src/tools.mjs';
import { makeFixture } from './helpers.mjs';

test('private config defaults to .runtime and never selects a module-local private file', async (t) => {
  const f = await makeFixture();
  t.after(f.cleanup);
  const modulePath = path.join(f.base, 'module-config.json');
  const runtimePath = path.join(f.base, 'runtime-config.json');
  const explicitPath = path.join(f.base, 'explicit-config.json');

  await fs.writeFile(runtimePath, '{}', 'utf8');
  assert.equal(resolveConfigPath({ modulePath, runtimePath }), path.resolve(runtimePath));

  // A wrongly placed legacy module config must not take precedence.
  await fs.writeFile(modulePath, '{"tunnel":{"id":"synthetic-placeholder"}}', 'utf8');
  assert.equal(resolveConfigPath({ modulePath, runtimePath }), path.resolve(runtimePath));

  const staleEnvPath = path.join(f.base, 'missing-env-config.json');
  assert.equal(resolveConfigPath({ envPath: staleEnvPath, modulePath, runtimePath }), path.resolve(runtimePath));

  assert.equal(resolveConfigPath({ override: explicitPath, modulePath, runtimePath }), path.resolve(explicitPath));
  await fs.writeFile(explicitPath, '{}', 'utf8');
  assert.equal(resolveConfigPath({ envPath: explicitPath, modulePath, runtimePath }), path.resolve(explicitPath));
  assert.equal(await fs.readFile(modulePath, 'utf8'), '{"tunnel":{"id":"synthetic-placeholder"}}');
});

test('allowedRoot accepts an array while preserving first-root relative paths', async (t) => {
  const f = await makeFixture();
  t.after(f.cleanup);
  const second = path.join(f.base, 'second-root');
  await fs.mkdir(second, { recursive: true });
  await fs.writeFile(path.join(second, 'second.txt'), 'second\n', 'utf8');

  const configPath = path.join(f.base, 'config.json');
  const accessTokenPath = path.join(f.base, 'Access_token-roots');
  await fs.writeFile(configPath, JSON.stringify({ transport: { allowedRoot: [f.root, second] } }), 'utf8');
  await fs.writeFile(accessTokenPath, 'spk_' + Buffer.alloc(32, 0x41).toString('base64url') + '\n', 'utf8');
  const config = loadConfig({ configPath, accessTokenPath });

  assert.deepEqual(config.roots, [path.resolve(f.root), path.resolve(second)]);
  assert.equal(config.root, path.resolve(f.root));

  const policy = await createPathPolicy(config.roots);
  assert.equal((await policy.resolveFile('hello.txt')).displayPath, 'hello.txt');
  assert.equal((await policy.resolveFile(path.join(second, 'second.txt'))).absolutePath, await fs.realpath(path.join(second, 'second.txt')));
  await assert.rejects(() => policy.resolveFile(path.join(f.outside, 'secret.txt')), (error) => error.code === 'OUTSIDE_ALLOWED_ROOT');
});

test('multi-root permits CRUD by absolute path only inside configured roots', async (t) => {
  const f = await makeFixture();
  t.after(f.cleanup);
  const second = path.join(f.base, 'second-root');
  const stateDir = path.join(f.base, 'state');
  await fs.mkdir(second, { recursive: true });
  await fs.writeFile(path.join(second, 'existing.txt'), 'beta\n', 'utf8');

  const policy = await createPathPolicy([f.root, second]);
  const recycled = [];
  const runtime = createToolRuntime({
    policy,
    maxReadBytes: 1024 * 1024,
    stateDir,
    commandTimeoutMs: 1000,
    recycleBin: true,
    recycle: async (target) => { recycled.push(target); },
    runner: async () => ({ ok: true, stdout: '', stderr: '', exitCode: 0, signal: null, durationMs: 1 }),
  });

  let result = await runtime.readFile({ path: path.join(second, 'existing.txt') });
  assert.equal(result.ok, true);
  assert.equal(result.text, 'beta\n');

  const created = path.join(second, 'created.txt');
  result = await runtime.createFile({ path: created, text: 'created' });
  assert.equal(result.ok, true);
  assert.equal(await fs.readFile(created, 'utf8'), 'created');

  result = await runtime.deletePath({ path: second });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'ROOT_DELETE_FORBIDDEN');
  assert.equal(recycled.length, 0);

  result = await runtime.createFile({ path: path.join(f.outside, 'blocked.txt'), text: 'blocked' });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'OUTSIDE_ALLOWED_ROOT');
});

test('single-root compatibility still rejects absolute tool paths', async (t) => {
  const f = await makeFixture();
  t.after(f.cleanup);
  const policy = await createPathPolicy(f.root);
  await assert.rejects(() => policy.resolveFile(path.join(f.root, 'hello.txt')), (error) => error.code === 'ABSOLUTE_PATH_NOT_ALLOWED');
});

test('duplicate relative paths across roots are rejected until an absolute path disambiguates them', async (t) => {
  const f = await makeFixture();
  t.after(f.cleanup);
  const second = path.join(f.base, 'second-root');
  await fs.mkdir(second, { recursive: true });
  await fs.writeFile(path.join(f.root, 'PIM3.md'), 'primary\n', 'utf8');
  await fs.writeFile(path.join(second, 'PIM3.md'), 'secondary\n', 'utf8');

  const policy = await createPathPolicy([f.root, second]);
  await assert.rejects(() => policy.resolveFile('PIM3.md'), (error) => error.code === 'AMBIGUOUS_ROOT_PATH');
  await assert.rejects(() => policy.resolveMutationEntry('PIM3.md'), (error) => error.code === 'AMBIGUOUS_ROOT_PATH');

  const primary = await policy.resolveFile(path.join(f.root, 'PIM3.md'));
  const secondary = await policy.resolveFile(path.join(second, 'PIM3.md'));
  assert.equal(await fs.readFile(primary.absolutePath, 'utf8'), 'primary\n');
  assert.equal(await fs.readFile(secondary.absolutePath, 'utf8'), 'secondary\n');
});

test('allowedRoot supports per-root R/W/X permissions', async (t) => {
  const f = await makeFixture();
  t.after(f.cleanup);
  const second = path.join(f.base, 'second-root');
  const stateDir = path.join(f.base, 'state');
  await fs.mkdir(second, { recursive: true });
  await fs.writeFile(path.join(f.root, 'read-only.txt'), 'readonly\n', 'utf8');

  const configPath = path.join(f.base, 'config-permissions.json');
  const accessTokenPath = path.join(f.base, 'Access_token-permissions');
  await fs.writeFile(configPath, JSON.stringify({ transport: { allowedRoot: [
    { path: f.root, permissions: 'R' },
    { path: second, permissions: 'rwx' }
  ] } }), 'utf8');
  await fs.writeFile(accessTokenPath, 'spk_' + Buffer.alloc(32, 0x42).toString('base64url') + '\n', 'utf8');
  const config = loadConfig({ configPath, accessTokenPath });
  assert.deepEqual(config.rootPolicies, [
    { path: path.resolve(f.root), permissions: 'R' },
    { path: path.resolve(second), permissions: 'RWX' }
  ]);

  const policy = await createPathPolicy(config.rootPolicies);
  const runtime = createToolRuntime({
    policy,
    maxReadBytes: 1024 * 1024,
    stateDir,
    commandTimeoutMs: 1000,
    recycleBin: true,
    recycle: async () => {},
    runner: async () => ({ ok: true, stdout: 'ran', stderr: '', exitCode: 0, signal: null, durationMs: 1 }),
  });

  let result = await runtime.readFile({ path: path.join(f.root, 'read-only.txt') });
  assert.equal(result.ok, true);

  result = await runtime.createFile({ path: path.join(f.root, 'blocked.txt'), text: 'blocked' });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'ROOT_PERMISSION_DENIED');

  result = await runtime.runCommand({ command: process.execPath, args: ['--version'], cwd: f.root });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'ROOT_PERMISSION_DENIED');

  result = await runtime.createFile({ path: path.join(second, 'allowed.txt'), text: 'allowed' });
  assert.equal(result.ok, true);
  result = await runtime.runCommand({ command: process.execPath, args: ['--version'], cwd: second });
  assert.equal(result.ok, true);
});

test('config requires MCP bearer authentication from the Access_token secret file', async (t) => {
  const f = await makeFixture();
  t.after(f.cleanup);
  const token = 'spk_' + Buffer.alloc(32, 0x5a).toString('base64url');
  const digest = crypto.createHash('sha256').update(token, 'utf8').digest('hex');
  const configPath = path.join(f.base, 'config-auth.json');
  const secretPath = path.join(f.base, 'Access_token');
  await fs.writeFile(configPath, JSON.stringify({ transport: { allowedRoot: f.root, operationTimeoutMs: 4567, httpRequestTimeoutMs: 2345, serverCloseTimeoutMs: 765 } }), 'utf8');
  await fs.writeFile(secretPath, token + '\n', 'utf8');
  const config = loadConfig({ configPath, accessTokenPath: secretPath });
  assert.deepEqual(config.auth, { mode: 'bearer', bearerTokenSha256: digest });
  assert.equal(config.operationTimeoutMs, 4567);
  assert.equal(config.commandTimeoutMs, null);
  assert.equal(config.commandInitialWaitMs, 2000);
  assert.equal(config.commandRequestSegmentMs, 45000);
  assert.equal(config.httpRequestTimeoutMs, 2345);
  assert.equal(config.serverCloseTimeoutMs, 765);

  const missingSecretPath = path.join(f.base, 'missing-Access_token');
  assert.deepEqual(loadConfig({ configPath, accessTokenPath: missingSecretPath }).auth, { mode: 'missing', bearerTokenSha256: '' });

  await fs.writeFile(secretPath, 'not-a-valid-key\n', 'utf8');
  assert.throws(() => loadConfig({ configPath, accessTokenPath: secretPath }), /Access_token/);

  const legacyConfigPath = path.join(f.base, 'config-legacy-auth.json');
  await fs.writeFile(legacyConfigPath, JSON.stringify({ transport: { allowedRoot: f.root, auth: { mode: 'bearer', bearerTokenSha256: digest } } }), 'utf8');
  assert.throws(() => loadConfig({ configPath: legacyConfigPath, accessTokenPath: missingSecretPath }), /transport\.auth is no longer supported/);
});
