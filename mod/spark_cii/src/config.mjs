import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const SPARK_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const DEFAULT_CONFIG_PATH = path.join(SPARK_ROOT, ".runtime", "config", "config_cii");
export const MAX_PREFIX_BYTES = 16 * 1024;

export function normalizePrefix(source) {
  if (typeof source !== "string") throw new TypeError("Cii config must be UTF-8 text.");
  const prefix = source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim();
  if (!prefix) throw new Error("Cii config is empty; injection is disabled.");
  if (prefix.includes("\u0000")) throw new Error("Cii config contains a NUL character.");
  if (Buffer.byteLength(prefix, "utf8") > MAX_PREFIX_BYTES) {
    throw new Error("Cii config exceeds the 16 KiB limit.");
  }
  return prefix;
}

export async function loadPrefix(filePath = DEFAULT_CONFIG_PATH) {
  const data = await readFile(filePath);
  if (data.byteLength > MAX_PREFIX_BYTES + 4) {
    throw new Error("Cii config exceeds the 16 KiB limit.");
  }
  return normalizePrefix(new TextDecoder("utf-8", { fatal: true }).decode(data));
}
