import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Minimal `.env` reader (KEY=VALUE per line, optional `export `, single or
 * double quotes). Real environment variables always win, so an exported
 * ESPO_CRM_API_KEY beats whatever a `.env` says. Only ESPO_CRM_* keys are
 * copied, nothing else from the file touches the environment.
 */

const PREFIX = "ESPO_CRM_";

function parseLine(line: string): [string, string] | undefined {
  let text = line.trim();
  if (text.length === 0 || text.startsWith("#")) return undefined;
  if (text.startsWith("export ")) text = text.slice(7).trim();
  const eq = text.indexOf("=");
  if (eq <= 0) return undefined;
  const key = text.slice(0, eq).trim();
  let value = text.slice(eq + 1).trim();
  if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value[value.length - 1] === value[0]) {
    value = value.slice(1, -1);
  }
  return key.startsWith(PREFIX) ? [key, value] : undefined;
}

export function parseDotEnv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const pair = parseLine(line);
    if (pair && out[pair[0]] === undefined) out[pair[0]] = pair[1];
  }
  return out;
}

/** Return a process.env-like object with `./.env` values filled in where unset. */
export function loadDotEnv(env: NodeJS.ProcessEnv, file = resolve(process.cwd(), ".env")): NodeJS.ProcessEnv {
  if (!existsSync(file)) return env;
  let content: string;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    return env;
  }
  const merged: NodeJS.ProcessEnv = { ...env };
  for (const [key, value] of Object.entries(parseDotEnv(content))) {
    if (merged[key] === undefined) merged[key] = value;
  }
  return merged;
}
