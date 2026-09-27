import { cp, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { runtimePaths } from "./paths";

/** Copy executable source into the private runtime cache without writing to public source. */
export async function createSourceSnapshot(paths: ReturnType<typeof runtimePaths>, session: string) {
  await mkdir(paths.cache, { recursive: true, mode: 0o700 });
  const snapshot = await mkdtemp(join(paths.cache, `${session}-`));
  try {
    await cp(join(paths.source, "src"), join(snapshot, "src"), { recursive: true });
    for (const name of ["node_modules", "package.json"]) {
      await symlink(join(paths.source, name), join(snapshot, name));
    }
    await symlink(paths.state, join(snapshot, ".hometruth"));
    return snapshot;
  } catch (error) {
    await rm(snapshot, { recursive: true, force: true });
    throw error;
  }
}
