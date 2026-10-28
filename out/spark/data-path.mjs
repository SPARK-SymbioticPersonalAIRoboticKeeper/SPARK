import os from 'node:os';
import path from 'node:path';

// Per-user application data belongs outside the source tree and outside
// .runtime (which contains only configuration and credentials).
export function sparkDataRoot({ env = process.env, platform = process.platform, projectRoot } = {}) {
  const base = platform === 'win32' ? env.LOCALAPPDATA
    : (env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'));
  if (!base || !path.isAbsolute(base)) throw new Error('A valid per-user application data directory is required.');
  const candidate = env.SPARK_DATA_DIR || path.join(base, platform === 'win32' ? 'SPARK' : 'spark');
  if (!path.isAbsolute(candidate)) throw new Error('SPARK_DATA_DIR must be an absolute path outside the source repository.');
  const resolved = path.resolve(candidate);
  if (projectRoot) {
    const relative = path.relative(path.resolve(projectRoot), resolved);
    if (!relative || (relative !== '..' && !relative.startsWith('..' + path.sep)
      && !path.isAbsolute(relative))) {
      throw new Error('Persistent user data must not be inside source, .runtime or disposable log.');
    }
  }
  return resolved;
}
