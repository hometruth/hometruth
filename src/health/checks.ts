import { createConnection } from "node:net";

/** Existence check only: never sends a control, opens a stream, or changes network routing. */
export async function checkTcpPorts(host: string, ports: readonly number[]): Promise<void> {
  await Promise.any(ports.map(port => new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host, port });
    const finish = (error?: Error) => { socket.destroy(); error ? reject(error) : resolve(); };
    socket.setTimeout(5_000, () => finish(new Error("Connection timed out")));
    socket.once("connect", () => finish());
    socket.once("error", () => finish(new Error("Connection failed")));
  })));
}
