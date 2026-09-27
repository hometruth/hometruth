import { createHash } from "node:crypto";
import { mkdir, rename, rm } from "node:fs/promises";
import { resolve } from "node:path";

const directory = resolve(".hometruth/bluetooth");
const binary = resolve(directory, "govee-scan");
let building: Promise<string> | undefined;

/** Build the small native receiver once. No package downloads or Bluetooth access here. */
export function ensureGoveeScanner(): Promise<string> {
  building ??= build().finally(() => { building = undefined; });
  return building;
}

async function build(): Promise<string> {
  if (process.platform !== "darwin") throw new Error("Govee Bluetooth currently requires a macOS HomeTruth server");
  const source = resolve(import.meta.dir, "scan.swift");
  const plist = resolve(import.meta.dir, "Info.plist");
  const hash = createHash("sha256").update(await Bun.file(source).text()).update(await Bun.file(plist).text()).update(process.arch).digest("hex");
  if (await Bun.file(binary).exists() && await Bun.file(`${binary}.sha256`).text().catch(() => "") === hash) return binary;
  await mkdir(directory, { recursive: true });
  const temporary = `${binary}.${process.pid}.${crypto.randomUUID()}`;
  try {
    const child = Bun.spawn(["/usr/bin/swiftc", source, "-o", temporary, "-module-cache-path", resolve(directory, "module-cache"),
      "-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", plist],
    { stdout: "ignore", stderr: "pipe" });
    const timeout = setTimeout(() => child.kill(), 120_000);
    try {
      const [code, errors] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      if (code !== 0) throw new Error(`Could not build Govee Bluetooth receiver; install Xcode Command Line Tools. ${errors.slice(-300)}`);
    } finally { clearTimeout(timeout); }
    await rename(temporary, binary);
    await Bun.write(`${binary}.sha256`, hash);
    return binary;
  } finally { await rm(temporary, { force: true }); }
}

if (import.meta.main) console.log(await ensureGoveeScanner());
