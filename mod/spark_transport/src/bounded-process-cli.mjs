import { runProcess } from './command-runner.mjs';

function usage() {
  process.stderr.write('Usage: node bounded-process-cli.mjs <timeoutMs> <command> [args...]\n');
}

const [timeoutText, command, ...args] = process.argv.slice(2);
const timeoutMs = Number(timeoutText);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || !command) {
  usage();
  process.exitCode = 2;
} else {
  const result = await runProcess({
    command,
    args,
    cwd: process.cwd(),
    timeoutMs,
    maxOutputBytes: 4 * 1024 * 1024,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (!result.ok && result.error?.code === 'COMMAND_TIMEOUT') {
    process.stderr.write(`bounded process timeout after ${timeoutMs} ms: ${command}\n`);
    process.exitCode = 124;
  } else if (!result.ok) {
    process.exitCode = Number.isInteger(result.exitCode) && result.exitCode !== 0 ? result.exitCode : 1;
  }
}
