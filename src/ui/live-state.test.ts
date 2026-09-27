/**
 * Live state is not something a page remembers to do.
 *
 * Everywhere a value from the state graph reaches a screen it carries `data-live`: that attribute
 * is what gives it live ink and what the hover reads to say how old the reading is. There are only
 * two ways a value gets there, and this file holds both of them shut.
 *
 * An `ht-*` element cannot forget, because the base class stamps its own parts after every render
 * (`HtElement.paint`). A page script can forget, so the rule is mechanical: a file that subscribes
 * to a node must also mark what it draws. If a new page subscribes and renders a reading in plain
 * ink, the second test here fails and names the file.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { COLOR_TOKENS, THEMES } from "./themes";
import { CLIENT_RUNTIME } from "./shell";

const UI = join(import.meta.dir);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return entry.endsWith(".ts") && !entry.endsWith(".test.ts") ? [path] : [];
  });
}

/** A page script that reads the graph directly, rather than through an `ht-*` element. */
const SUBSCRIBES = /\bstate\.subscribe\(/u;
/** Either way of marking: the runtime helper, or the attribute written into server-rendered HTML. */
const MARKS = /ht\.live\(|data-live/u;

describe("live state is marked wherever it is shown", () => {
  test("every theme defines the live ink, in both schemes, mixed from its own tokens", () => {
    expect(COLOR_TOKENS).toContain("live");
    for (const theme of Object.values(THEMES)) {
      for (const scheme of ["light", "dark"] as const) {
        const value = theme[scheme].live;
        expect([theme.id, scheme, typeof value]).toEqual([theme.id, scheme, "string"]);
        // Derived from the theme's own tokens, so live ink can never be a colour a page invented.
        expect([theme.id, scheme, value.startsWith("color-mix(")]).toEqual([theme.id, scheme, true]);
        expect([theme.id, scheme, value.includes("var(--fg)")]).toEqual([theme.id, scheme, true]);
      }
    }
  });

  test("the runtime exposes ht.live and the hover reads the stamp it writes", () => {
    expect(CLIENT_RUNTIME).toContain("const live = (element, observedAt)");
    expect(CLIENT_RUNTIME).toMatch(/return \{[^}]*\blive\b[^}]*\};/u);
    expect(CLIENT_RUNTIME).toContain('setAttribute("data-live", observedAt)');
    // Computed when asked for, never on a schedule: no page may tick to keep an age current.
    expect(CLIENT_RUNTIME).toContain("const relativeTime = (value)");
    expect(CLIENT_RUNTIME).not.toMatch(/setInterval\(/u);
  });

  test("an element stamps its own value parts, so it cannot be forgotten", () => {
    // Read as source: importing the class would need a DOM, and what matters is that the base
    // class does the stamping for every kind rather than each kind doing it for itself.
    const base = readFileSync(join(UI, "browser", "element.ts"), "utf8");
    expect(base).toMatch(/protected get liveParts\(\)/u);
    expect(base).toContain('setAttribute("data-live", at)');
    expect(base).toMatch(/protected paint\(\): void \{\s*this\.render\(\);/u);
    // Nothing may call render() straight past the stamp; paint() is the only way in.
    expect(base.match(/this\.render\(\)/gu) ?? []).toHaveLength(1);
  });

  test("a page that subscribes to the graph marks what it draws", () => {
    const offenders = sourceFiles(UI)
      .filter((path) => SUBSCRIBES.test(readFileSync(path, "utf8")))
      .filter((path) => !MARKS.test(readFileSync(path, "utf8")))
      .map((path) => path.slice(UI.length + 1));
    // A page reading the graph and rendering it in plain ink is the whole failure this guards.
    expect(offenders).toEqual([]);
  });

  test("no page script polls the graph it could subscribe to", () => {
    // Workbook pages drive hardware experiments and are exempt by the owner's decision; automations
    // are parked pending a decision of their own.
    const exempt = new Set(["radio-receiver-page.ts", "dog-automation-page.ts"]);
    const polling = sourceFiles(UI)
      .map((path) => [path.slice(UI.length + 1), readFileSync(path, "utf8")] as const)
      .filter(([name]) => !exempt.has(name))
      .filter(([, source]) => /setInterval\([^)]*\b(refresh|update|reload|fetch|poll)/u.test(source))
      .map(([name]) => name);
    expect(polling).toEqual([]);
  });
});
