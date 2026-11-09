import { createClient } from "redis";

/**
 * ElastiCache Valkey does not support node-redis' optional CLIENT SETINFO or
 * Redis Enterprise maintenance-notification handshakes. Disable both so every
 * successful connection is free of deliberately ignored command errors in the
 * node-level ErrorCount metric.
 */
export function createValkeyClient(url: string) {
  return createClient({
    url,
    disableClientInfo: true,
    maintNotifications: "disabled"
  });
}
