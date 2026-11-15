/** Dedicated Node process: protocol libraries, private pairing state, parent-only IPC. */
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { randomInt, createHash } from 'node:crypto';
import { join } from 'node:path';

const pending = new Map();
let serial = 0, runtime, interval, ending = false;
export function request(operation, data = {}) {
  if (!process.connected) return Promise.reject(new Error('HomeTruth disconnected'));
  return new Promise((resolve, reject) => {
    const id = ++serial;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('HomeTruth did not respond')); }, 15000);
    pending.set(id, { resolve, reject, timer });
    process.send({ type: 'request', id, operation, ...data });
  });
}
const send = message => { if (process.connected) process.send(message); };
async function close() {
  if (ending) return; ending = true; clearInterval(interval);
  for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Bridge stopped')); }
  pending.clear();
  const deadline = setTimeout(() => process.exit(1), 4000); deadline.unref();
  try { await runtime?.close(); } finally { process.exit(0); }
}
process.on('disconnect', close);
process.on('SIGTERM', close);
process.on('SIGINT', close);
process.on('message', async message => {
  if (message.type === 'reply') {
    const entry = pending.get(message.id); if (!entry) return;
    pending.delete(message.id); clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(message.error)); else entry.resolve(message.value);
  } else if (message.type === 'init') {
    if (runtime) return;
    try {
      await mkdir(message.storage, { recursive: true, mode: 0o700 });
      await chmod(message.storage, 0o700);
      const implementation = await import(message.bridge.protocol === 'homekit' ? './homekit.mjs' : './matter.mjs');
      runtime = await implementation.createBridge(message, request);
      let busy = false;
      const poll = async () => {
        if (busy || ending) return; busy = true;
        try { await runtime.refresh(); send({ type: 'status', status: runtime.status() }); }
        catch { send({ type: 'fault', detail: 'Unable to refresh bridge state' }); }
        finally { busy = false; }
      };
      await poll(); interval = setInterval(poll, 2000);
    } catch (error) {
      // Credentials and media URLs can occur in protocol exceptions. Send only a bounded diagnostic class.
      send({ type: 'fault', detail: `Bridge could not start (${error?.name ?? 'Error'})` });
      console.error('Bridge startup failed:', String(error?.message ?? error).replace(/(?:rtsp|https?):\/\/\S+/g, '[address]').slice(0, 500));
      setTimeout(close, 100);
    }
  } else if (message.type === 'pair') {
    try { await runtime?.pair(); send({ type: 'status', status: runtime.status() }); }
    catch { send({ type: 'fault', detail: 'Unable to open pairing window' }); }
  } else if (message.type === 'event') runtime?.event?.(message.accessory, message.key, message.value);
});

export async function identity(storage, id) {
  const path = join(storage, `${id}.json`);
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  let pin;
  do { pin = String(randomInt(100000000)).padStart(8, '0'); } while (/^(\d)\1+$/.test(pin) || ['12345678','87654321'].includes(pin));
  const digest = createHash('sha256').update(id).digest(); digest[0] = (digest[0] | 2) & 254;
  const result = { username: [...digest.subarray(0, 6)].map(b => b.toString(16).padStart(2,'0')).join(':').toUpperCase(), pincode: `${pin.slice(0,3)}-${pin.slice(3,5)}-${pin.slice(5)}` };
  await writeFile(path, JSON.stringify(result), { flag: 'wx', mode: 0o600 });
  return result;
}
