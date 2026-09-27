import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export async function buildDtls(output = ".hometruth/hue-proxy/dtls"): Promise<string> {
  const path = resolve(output);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let flags: string[];
  const prefix = process.env.OPENSSL_PREFIX ?? (["/opt/homebrew/opt/openssl@3", "/usr/local/opt/openssl@3"].find(p => Bun.file(`${p}/include/openssl/ssl.h`).size > 0));
  if (prefix) flags = [`-I${prefix}/include`, `-L${prefix}/lib`, `-Wl,-rpath,${prefix}/lib`, "-lssl", "-lcrypto"];
  else {
    const pkg = Bun.spawn(["pkg-config", "--cflags", "--libs", "openssl"], { stdout: "pipe", stderr: "inherit" });
    const result = await new Response(pkg.stdout).text();
    if (await pkg.exited !== 0) throw new Error("Install OpenSSL development headers and pkg-config, or set OPENSSL_PREFIX");
    flags = result.trim().split(/\s+/u);
  }
  const compile = Bun.spawn([process.env.CC ?? "cc", "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", resolve(import.meta.dir, "native/dtls.c"), "-o", path, ...flags], { stdout: "inherit", stderr: "inherit" });
  if (await compile.exited !== 0) throw new Error("Could not build the Hue DTLS helper");
  return path;
}
if (import.meta.main) console.log(await buildDtls(process.argv[2]));
