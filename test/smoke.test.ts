import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { VERSION } from "../src/version.js";

/**
 * Built-binary smoke test: runs `node bin/espocrm-axi.js` against the compiled
 * dist/ (npm pretest rebuilds it) with every ESPO_CRM_* variable stripped, so
 * it proves the shipped entrypoint works with no credentials and no network.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BIN = resolve(ROOT, "bin", "espocrm-axi.js");
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("ESPO_CRM_")));
const sandbox = mkdtempSync(resolve(tmpdir(), "espocrm-axi-smoke-"));

function run(args: string[], cwd = sandbox): { stdout: string; status: number } {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], { cwd, env: cleanEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { stdout, status: 0 };
  } catch (error) {
    const e = error as { status?: number; stdout?: string };
    return { stdout: e.stdout ?? "", status: e.status ?? 1 };
  }
}

afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

describe("built binary", () => {
  it("answers --version from the fast path", () => {
    expect(run(["--version"]).stdout.trim()).toBe(VERSION);
  });

  it("prints the command list for --help without touching the network", () => {
    const { stdout } = run(["--help"]);
    expect(stdout).toContain("commands:");
    for (const name of ["record", "email", "lead", "api", "setup"]) expect(stdout).toContain(name);
  });

  it("renders an unauthenticated home view (auth: none) with setup guidance", () => {
    const { stdout, status } = run([]);
    expect(status).toBe(0);
    expect(stdout).toContain("auth: none");
    expect(stdout).toContain("ESPO_CRM_DOMAIN");
    expect(stdout).toContain("ESPO_CRM_API_KEY");
  });

  it("fails loud with exit 2 on an unknown flag and never prompts", () => {
    const { stdout, status } = run(["record", "list", "Lead", "--nope"]);
    expect(status).toBe(2);
    expect(stdout).toContain("VALIDATION_ERROR");
  });

  it("reports missing credentials as AUTH_REQUIRED before any request", () => {
    const { stdout, status } = run(["record", "list", "Lead"]);
    expect(status).toBe(1);
    expect(stdout).toContain("AUTH_REQUIRED");
    expect(stdout).toContain("ESPO_CRM_DOMAIN");
  });

  it("reads a ./.env when present (domain only -> AUTH_REQUIRED naming the key, never its value)", () => {
    writeFileSync(resolve(sandbox, ".env"), "ESPO_CRM_DOMAIN=crm.example.test\nESPO_CRM_API_KEY=\n");
    const { stdout, status } = run(["me"]);
    expect(status).toBeGreaterThanOrEqual(1);
    expect(stdout).toMatch(/AUTH_REQUIRED|VALIDATION_ERROR/);
    expect(readFileSync(resolve(sandbox, ".env"), "utf8")).toContain("crm.example.test");
  });
});
