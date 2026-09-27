import { realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

function contains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

/** Source and installation are independent trees; all runtime writes use the latter. */
export function runtimePaths(sourceDirectory: string, installationDirectory: string) {
  const source = realpathSync(sourceDirectory);
  const installation = realpathSync(installationDirectory);
  if (contains(source, installation) || contains(installation, source)) {
    throw new Error("Keep the installation outside the source checkout. Use bun run site <private-directory> <command>.");
  }
  const state = join(installation, ".hometruth");
  return { source, installation, state, cache: join(state, "dev") };
}
