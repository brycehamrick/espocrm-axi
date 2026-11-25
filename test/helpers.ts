import { resolveConfig, type EspoConfig } from "../src/lib/env.js";
import { createEspoClient, type EspoClient, type FetchLike } from "../src/api/client.js";
import { createCommandContext, type CommandContext } from "../src/context.js";

/** Test config that never touches a real instance. */
export const TEST_ENV: NodeJS.ProcessEnv = {
  ESPO_CRM_DOMAIN: "crm.example.test",
  ESPO_CRM_API_KEY: "k".repeat(32),
  ESPO_CRM_USERNAME: "ada",
  ESPO_CRM_PASSWORD: "pw-secret-123",
};

export const TEST_CONFIG: EspoConfig = resolveConfig(TEST_ENV);

export interface Recorded {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface FakeResponse {
  status: number;
  body?: string;
  headers?: Record<string, string>;
}

/** Scripted responses, consumed in order (last one repeats). */
export function fakeFetch(script: FakeResponse[]): { fetch: FetchLike; calls: Recorded[] } {
  const calls: Recorded[] = [];
  let index = 0;
  const fetch: FetchLike = async (url, init) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = key === "authorization" || key === "x-api-key" || key === "espo-authorization" ? value : value;
    });
    calls.push({ method: init.method ?? "GET", url, headers, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const step = script[Math.min(index++, script.length - 1)] ?? { status: 200, body: "{}" };
    return new Response(step.body ?? "", { status: step.status, headers: step.headers });
  };
  return { fetch, calls };
}

/** A client with scripted HTTP; no network access, ever. */
export function clientFor(script: FakeResponse[], env: NodeJS.ProcessEnv = TEST_ENV): { client: EspoClient; calls: Recorded[] } {
  const { fetch, calls } = fakeFetch(script);
  const client = createEspoClient(resolveConfig(env), { fetchImpl: fetch });
  return { client, calls };
}

/** A CommandContext whose client records every request and replays scripted payloads. */
export function contextFor(script: FakeResponse[] = [{ status: 200, body: "{}" }], env: NodeJS.ProcessEnv = TEST_ENV): { ctx: CommandContext; calls: Recorded[] } {
  const { fetch, calls } = fakeFetch(script);
  const ctx = createCommandContext({ fetchImpl: fetch }, env);
  return { ctx, calls };
}

export const OK_LIST = (list: unknown[], total = list.length): FakeResponse => ({ status: 200, body: JSON.stringify({ list, total }) });
export const OK = (payload: unknown): FakeResponse => ({ status: 200, body: JSON.stringify(payload) });
export const ERR = (status: number, reason?: string, body = ""): FakeResponse => ({ status, body, headers: reason ? { "x-status-reason": reason } : {} });

export function lastUrl(calls: Recorded[]): URL {
  return new URL(calls[calls.length - 1]!.url);
}
