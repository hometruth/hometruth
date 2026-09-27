#!/usr/bin/env bun
/** Run one argument-safe HomeTruth CLI action selected by a GitHub Actions event. */
import { readFile } from "node:fs/promises";
import { siteCommand } from "./site";

const MAX_ARGUMENTS = 64;
const MAX_ARGUMENT_LENGTH = 2_048;
const MAX_ARGUMENTS_LENGTH = 8_192;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function argumentList(value: unknown): string[] {
  let parsed = value;
  if (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed) as unknown; }
    catch { throw new Error("Action arguments must be a JSON array of strings"); }
  }
  if (!Array.isArray(parsed) || parsed.length > MAX_ARGUMENTS || parsed.some(item => typeof item !== "string")) {
    throw new Error("Action arguments must be a JSON array of at most 64 strings");
  }
  const args = parsed as string[];
  if (args.some(item => item.length > MAX_ARGUMENT_LENGTH || item.includes("\0"))
    || args.join("\0").length > MAX_ARGUMENTS_LENGTH) {
    throw new Error("Action arguments exceed the allowed size");
  }
  return args;
}

async function eventArguments(): Promise<{ eventName: string; args: string[] }> {
  const eventName = process.env.GITHUB_EVENT_NAME;
  if (!eventName) throw new Error("This command must run inside a GitHub Actions event");

  let fromEvent: unknown;
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (eventPath) {
    let event: unknown;
    try { event = JSON.parse(await readFile(eventPath, "utf8")) as unknown; }
    catch { throw new Error("GitHub Actions event data is unavailable or invalid"); }
    const payload = record(event);
    if (eventName === "workflow_dispatch") fromEvent = record(payload?.inputs)?.arguments;
    if (eventName === "repository_dispatch") fromEvent = record(payload?.client_payload)?.arguments;
  }

  const selected = fromEvent ?? process.env.HOMETRUTH_ACTION_ARGUMENTS;
  if (selected === undefined) {
    throw new Error("No HomeTruth action arguments were provided for this event");
  }
  return { eventName, args: argumentList(selected) };
}

async function main(): Promise<number> {
  try {
    const { eventName, args } = await eventArguments();
    const installation = process.cwd();
    const launch = await siteCommand(installation, "ht", args);
    const child = Bun.spawn(launch.argv, {
      cwd: launch.cwd,
      env: { ...process.env, ...launch.env },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
    const exitCode = await child.exited;
    if (exitCode !== 0) {
      console.error(`HomeTruth action failed for GitHub event ${eventName} (exit ${exitCode}); command output was withheld.`);
      return exitCode || 1;
    }
    console.log(`HomeTruth action completed for GitHub event ${eventName}.`);
    return 0;
  } catch (error) {
    // Do not echo event payloads, argument values, paths, or device details into hosted logs.
    const message = error instanceof Error && error.message.startsWith("No HomeTruth action arguments")
      ? error.message
      : "HomeTruth action could not run; details and command output were withheld.";
    console.error(message);
    return 1;
  }
}

if (import.meta.main) process.exitCode = await main();
