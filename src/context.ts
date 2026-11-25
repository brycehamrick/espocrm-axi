import { resolveConfig, type EspoConfig } from "./lib/env.js";
import { createEspoClient, type EspoClient, type EspoClientDeps } from "./api/client.js";

/**
 * Shared command context. It is resolved lazily per invocation (only for
 * handlers that run - `--help` and version probes never build a client) and
 * can be constructed in tests with an injected fetch implementation.
 */

export interface CommandContext {
  config: EspoConfig;
  client: EspoClient;
}

export function createCommandContext(deps: EspoClientDeps = {}, env: NodeJS.ProcessEnv | undefined = undefined): CommandContext {
  const config = env ? resolveConfig(env) : resolveConfig();
  const client = createEspoClient(config, deps);
  return { config, client };
}
