#!/usr/bin/env node
// Pre-commit secret scan (complements gitleaks in CI). Prints file names only,
// never values. Fails when a credential-looking literal appears outside .env.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".github"]);
const SKIP_FILES = new Set(["package-lock.json", "scan-secrets.mjs", ".env", ".env.example"]);
const TEXT_EXT = /\.(ts|js|mjs|json|md|yml|yaml|txt|example)$/i;

const patterns = [
  [/ESPO_CRM_API_KEY\s*=\s*["']?([A-Za-z0-9]{24,})["']?/g, "ESPO_CRM_API_KEY with a real-looking value"],
  [/ESPO_CRM_PASSWORD\s*=\s*["']?([^\s"'#]{6,})["']?/g, "ESPO_CRM_PASSWORD with a value"],
  [/X-Api-Key:\s*[A-Fa-f0-9]{32}\b/g, "X-Api-Key header with a 32-hex key"],
  [/Espo-Authorization:\s*[A-Za-z0-9+/=]{16,}/g, "Espo-Authorization header with a token"],
  [/Authorization:\s*Basic\s+[A-Za-z0-9+/=]{16,}/g, "Basic Authorization header with a token"],
];

const hits = new Map();
function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full);
      continue;
    }
    if (SKIP_FILES.has(entry) || !TEXT_EXT.test(entry)) continue;
    const text = readFileSync(full, "utf8");
    for (const [re, label] of patterns) {
      re.lastIndex = 0;
      if (re.test(text)) hits.set(full, [...(hits.get(full) ?? []), label]);
    }
  }
}
walk(root);

// Also look for the actual local .env credential copied anywhere else.
const envPath = join(root, ".env");
try {
  const key = /^ESPO_CRM_API_KEY=(.+)$/m.exec(readFileSync(envPath, "utf8"))?.[1]?.trim();
  if (key && key.length >= 16) {
    const scan = (dir) => {
      for (const entry of readdirSync(dir)) {
        if (SKIP_DIRS.has(entry)) continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          scan(full);
          continue;
        }
        if (SKIP_FILES.has(entry) || hits.get(full)?.includes("contains the local .env key")) continue;
        try {
          if (readFileSync(full, "utf8").includes(key)) hits.set(full, [...(hits.get(full) ?? []), "contains the local .env key"]);
        } catch {
          // binary
        }
      }
    };
    scan(root);
  }
} catch {
  // no .env - nothing to cross-check
}

if (hits.size > 0) {
  console.error("secret scan failed - credential-looking content in:");
  for (const [file, labels] of hits) console.error(`  - ${file.replace(root + "/", "")}: ${labels.join("; ")}`);
  process.exit(1);
}
console.log("secret scan ok: no credential-looking literals outside .env");
