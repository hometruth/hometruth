import { GoveeReceiver } from "./receiver";

// Discovery only; never automatically claims a nearby person's thermometer.
const seconds = Number(process.argv[2] ?? 20);
if (!Number.isFinite(seconds) || seconds < 1 || seconds > 120) throw new Error("Discovery duration must be 1–120 seconds");
const receiver = new GoveeReceiver();
try {
  await receiver.start();
  await Bun.sleep(seconds * 1000);
  console.log(JSON.stringify({ ...receiver.snapshot(""), devices: receiver.discovered() }, null, 2));
} finally { await receiver.close(); }
