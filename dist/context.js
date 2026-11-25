import { resolveConfig } from "./lib/env.js";
import { createEspoClient } from "./api/client.js";
export function createCommandContext(deps = {}, env = undefined) {
    const config = env ? resolveConfig(env) : resolveConfig();
    const client = createEspoClient(config, deps);
    return { config, client };
}
