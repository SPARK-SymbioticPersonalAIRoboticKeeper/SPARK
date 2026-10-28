#!/usr/bin/env node

import { generateAccessToken } from './auth.mjs';

function usage() {
  return `SPARK authentication helper

Usage:
  node mod/spark_transport/src/auth-cli.mjs generate [--json]

Commands:
  generate   Generate one 256-bit Access_token value for a SPARK instance.

Store the generated spk_ value only under .runtime/secrets/Access_token.
`;
}

function main() {
  const args = process.argv.slice(2);
  const command = args.shift();
  const json = args.includes('--json');
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(usage());
    return;
  }
  if (command !== 'generate' || args.some((arg) => arg !== '--json')) {
    process.stderr.write(usage());
    process.exitCode = 2;
    return;
  }

  const generated = generateAccessToken();
  const result = {
    token: generated.token,
    entropyBits: generated.entropyBits,
    secretPath: '.runtime/secrets/Access_token',
  };
  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  process.stdout.write('Access_token value (spk_...):\n');
  process.stdout.write(`${generated.token}\n\n`);
  process.stdout.write('Store it in .runtime/secrets/Access_token and paste the same value into the ChatGPT App Access token field.\n');
  process.stdout.write(`Entropy: ${generated.entropyBits} bits (Node.js crypto.randomBytes / OS CSPRNG)\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`SPARK auth: ${error?.message ?? error}\n`);
  process.exitCode = 1;
}
