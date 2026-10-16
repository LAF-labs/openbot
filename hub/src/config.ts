/**
 * What the hub reads from its environment, read once at boot and refused there when wrong — a hub
 * that starts on a bad value answers every member with a failure that names nothing.
 */
export type HubConfig = {
  databaseUrl: string;
  port: number;
  /** The address members reach this hub at; also the origin a registry body must name. */
  publicOrigin: string;
  /** This hub's registry key (`HMAC(master, "laf-hub-fleet/v1 <origin>")`, hex). */
  fleetSecret: string | undefined;
  privateIp: string | null;
};

const KEY_SHAPE = /^[0-9a-f]{64}$/;
const IPV4 = /^(\d{1,3})(\.\d{1,3}){3}$/;

export function readHubConfig(
  env: Record<string, string | undefined>,
): HubConfig {
  const databaseUrl = env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  const port = Number(env.PORT ?? "7200");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT is not a port");
  }
  const publicOrigin = (env.HUB_PUBLIC_ORIGIN ?? "http://localhost")
    .trim()
    .replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s/]+$/.test(publicOrigin)) {
    throw new Error("HUB_PUBLIC_ORIGIN is not an origin");
  }
  const fleetSecret = env.HUB_FLEET_SECRET?.trim() || undefined;
  if (fleetSecret !== undefined && !KEY_SHAPE.test(fleetSecret)) {
    throw new Error("HUB_FLEET_SECRET is not 64 hex characters");
  }
  const privateIp = env.HUB_PRIVATE_IP?.trim() || null;
  if (privateIp !== null && !IPV4.test(privateIp)) {
    throw new Error("HUB_PRIVATE_IP is not an IPv4 address");
  }
  return { databaseUrl, port, publicOrigin, fleetSecret, privateIp };
}
