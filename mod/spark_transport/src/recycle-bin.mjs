import { runProcess } from './command-runner.mjs';

const DEFAULT_RECYCLE_BIN_TIMEOUT_MS = 30_000;

function psQuote(value) { return `'${String(value).replaceAll("'", "''")}'`; }

export async function moveToRecycleBin(absolutePath, isDirectory, { timeoutMs = DEFAULT_RECYCLE_BIN_TIMEOUT_MS } = {}) {
  if (process.platform !== 'win32') {
    const error = new Error('Recycle Bin delete is supported only on Windows in Sprint-2');
    error.code = 'RECYCLE_BIN_UNAVAILABLE';
    throw error;
  }
  const method = isDirectory ? 'DeleteDirectory' : 'DeleteFile';
  const script = [
    'Add-Type -AssemblyName Microsoft.VisualBasic',
    `$p=${psQuote(absolutePath)}`,
    `[Microsoft.VisualBasic.FileIO.FileSystem]::${method}($p, [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs, [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)`,
  ].join('; ');
  const result = await runProcess({
    command: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    cwd: process.cwd(),
    timeoutMs,
    maxOutputBytes: 8 * 1024,
  });
  if (result.ok) return;
  const error = new Error(result.stderr?.trim() || result.error?.message || 'Recycle Bin operation failed');
  error.code = result.error?.code === 'COMMAND_TIMEOUT' ? 'RECYCLE_BIN_TIMEOUT' : 'RECYCLE_BIN_FAILED';
  throw error;
}
