import { fileURLToPath } from "node:url";

/** Multi-provider config (pre-ADR-007) for testing fallback/health mechanics. */
export const MULTI_PROVIDER_CONFIG_DIR = fileURLToPath(new URL("./config-multi", import.meta.url));
