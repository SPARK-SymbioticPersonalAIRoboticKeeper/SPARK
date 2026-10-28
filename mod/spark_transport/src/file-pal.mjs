import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

// No durable mutation snapshots are created by SPARK PAL.
// Git is authoritative for tracked source; callers MUST checkpoint uncommitted
// work before destructive changes. Untracked/private data needs a separately
// approved recovery policy instead of an invented recovery directory.
export function createFilePal() {
  async function ensureAbsent(target) {
    try {
      await fs.lstat(target);
      const error = new Error('destination already exists');
      error.code = 'ALREADY_EXISTS';
      throw error;
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
  }

  async function readBytes(absolutePath) { return fs.readFile(absolutePath); }

  async function listDirectory(absolutePath) {
    const dirents = await fs.readdir(absolutePath, { withFileTypes: true });
    const entries = [];
    for (const d of dirents) {
      const absolute = path.join(absolutePath, d.name);
      let type = 'other';
      let size;
      try {
        const st = await fs.lstat(absolute);
        if (st.isSymbolicLink()) type = 'symlink';
        else if (st.isDirectory()) type = 'directory';
        else if (st.isFile()) { type = 'file'; size = st.size; }
      } catch { type = 'unavailable'; }
      entries.push({ name: d.name, type, ...(size === undefined ? {} : { size }) });
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    return entries;
  }

  async function createTextFile(absolutePath, text) {
    const bytes = Buffer.from(text, 'utf8');
    await fs.writeFile(absolutePath, bytes, { flag: 'wx' });
    return { bytes: bytes.length, sha256: sha256(bytes) };
  }

  async function replaceTextFile({ absolutePath, text, expectedBeforeSha256 }) {
    const before = await fs.readFile(absolutePath);
    const beforeSha256 = sha256(before);
    if (expectedBeforeSha256 && expectedBeforeSha256 !== beforeSha256) {
      const error = new Error('file changed after logical read; replacement was not attempted');
      error.code = 'STALE_FILE';
      throw error;
    }
    const after = Buffer.from(text, 'utf8');
    try {
      await fs.writeFile(absolutePath, after);
      if (sha256(await fs.readFile(absolutePath)) !== sha256(after)) {
        const error = new Error('file verification failed after replacement');
        error.code = 'FILE_VERIFY_FAILED';
        throw error;
      }
    } catch (writeError) {
      try {
        await fs.writeFile(absolutePath, before);
        if (sha256(await fs.readFile(absolutePath)) !== beforeSha256) {
          throw new Error('in-memory restoration hash mismatch');
        }
      } catch {
        const error = new Error('file replacement failed and in-memory rollback failed; check Git immediately');
        error.code = 'PAL_ROLLBACK_FAILED';
        error.cause = writeError;
        throw error;
      }
      throw writeError;
    }
    return { before: { bytes: before.length, sha256: beforeSha256 },
      after: { bytes: after.length, sha256: sha256(after) } };
  }

  async function createDirectory(absolutePath, recursive = false) {
    await fs.mkdir(absolutePath, { recursive });
  }
  async function copyPath(sourceAbsolutePath, destinationAbsolutePath, isDirectory) {
    await ensureAbsent(destinationAbsolutePath);
    await fs.cp(sourceAbsolutePath, destinationAbsolutePath, { recursive: isDirectory, errorOnExist: true, force: false });
  }
  async function movePath(sourceAbsolutePath, destinationAbsolutePath) {
    await ensureAbsent(destinationAbsolutePath);
    await fs.rename(sourceAbsolutePath, destinationAbsolutePath);
  }
  return { readBytes, listDirectory, createTextFile, replaceTextFile, createDirectory, copyPath, movePath };
}
