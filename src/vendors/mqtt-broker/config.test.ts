import { expect, test } from "bun:test";
import { mqttBrokerOptions } from "./config";

test("an incomplete broker credential setting fails closed without echoing its value", () => {
  for (const env of [{ MQTT_USERNAME: "publisher" }, { MQTT_PASSWORD: "test-only-value" }, { MQTT_USERNAME: "", MQTT_PASSWORD: "test-only-value" }]) {
    expect(() => mqttBrokerOptions(env)).toThrow("Set both MQTT_USERNAME and MQTT_PASSWORD");
  }
});
test("broker credentials and bind address are independent of the web listener", () => {
  expect(mqttBrokerOptions({ HOST: "127.0.0.1", MQTT_HOST: "192.0.2.10", MQTT_USERNAME: "publisher", MQTT_PASSWORD: "test-only-value" }))
    .toEqual({ hostname: "192.0.2.10", port: 1883, credentials: { username: "publisher", password: "test-only-value" } });
  expect(mqttBrokerOptions({})).toEqual({ hostname: "0.0.0.0", port: 1883 });
});
