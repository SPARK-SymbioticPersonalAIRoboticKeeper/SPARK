import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export function createOperationLedger({ stateDir, durableLedgerDir = undefined }) {
  // Historical operation audit data belongs in user data, never .runtime or temporary log.
  const ledgerDir = durableLedgerDir ?? path.join(stateDir, 'ledger');
  const ledgerPath = path.join(ledgerDir, 'operations.jsonl');
  let writeChain = Promise.resolve();

  function nextOperationId() {
    return `op-${crypto.randomUUID()}`;
  }

  async function record(entry) {
    const normalized = {
      operationId: entry.operationId,
      timestamp: entry.timestamp ?? new Date().toISOString(),
      operation: entry.operation,
      target: entry.target ?? null,
      status: entry.status,
      changed: Boolean(entry.changed),
      durationMs: Number(entry.durationMs ?? 0),
      errorCode: entry.errorCode ?? null,
      summary: entry.summary ?? '',
    };
    writeChain = writeChain.then(async () => {
      await fs.mkdir(ledgerDir, { recursive: true });
      await fs.appendFile(ledgerPath, `${JSON.stringify(normalized)}\n`, 'utf8');
    });
    await writeChain;
    return normalized;
  }

  async function recent(limit = 10) {
    const capped = Math.max(1, Math.min(Number(limit) || 10, 100));
    try {
      await writeChain;
      const text = await fs.readFile(ledgerPath, 'utf8');
      const lines = text.split(/\r?\n/).filter(Boolean);
      return lines.slice(-capped).reverse().map((line) => {
        try { return JSON.parse(line); }
        catch { return { status: 'corrupt', summary: line.slice(0, 160) }; }
      });
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
  }

  return { ledgerPath, nextOperationId, record, recent };
}
