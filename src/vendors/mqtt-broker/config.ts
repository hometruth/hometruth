import type { MqttBrokerOptions } from "./index";

/** A partial credential setting must never silently open the broker. */
export function mqttBrokerOptions(env: Record<string, string | undefined>): MqttBrokerOptions {
  const username = env.MQTT_USERNAME;
  const password = env.MQTT_PASSWORD;
  if (username !== undefined || password !== undefined) {
    if (!username?.trim() || !password) throw new Error("Set both MQTT_USERNAME and MQTT_PASSWORD to enable broker authentication");
  }
  const port = Number(env.MQTT_PORT ?? 1883);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("MQTT_PORT must be an integer from 0 to 65535");
  return { hostname: env.MQTT_HOST ?? "0.0.0.0", port,
    ...(username && password ? { credentials: { username, password } } : {}),
  };
}
