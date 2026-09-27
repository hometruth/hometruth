import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { FakeDocument, type FakeElement } from "./browser/test-dom";
import { testPageContext } from "./test-context";
import { EVENT_FILTER_CONTROLS_SCRIPT } from "./event-filter-controls";
import { renderEventFilters } from "./services-page";
import { filterSchema, type FilterCondition } from "../models/filter-schema";
import { compileFilterCondition } from "../models/filter";

const record = { slug: "morning-people", filter: { schemaId: filterSchema.$id, id: "filter-test-id", name: "Morning people", condition: { all: [
  { path: "/subject", op: "eq", value: "camera-4" }, { detectionLabels: ["person"] },
  { timeWindow: { start: "09:00", end: "12:00", timeZone: "UTC" } },
] } }, revision: 1 } as const;

function harness(initial: URLSearchParams, lookup: (path: string, options?: { method: string; body: string }) => Promise<unknown> = async () => ({ filters: [record] })) {
  const document = new FakeDocument();
  document.body.innerHTML = renderEventFilters(testPageContext(), ["camera-4", "camera-5", "camera-6"].map(id => ({ id, name: id })), []);
  const get = (id: string) => document.getElementById(id)!;
  const select = get("saved-filter");
  Object.assign(get("saved-filter-form"), { reportValidity: () => true });
  Object.defineProperty(select, "options", { get: () => select.querySelectorAll("option") });
  const camera = (id: string) => get("filter-subject").querySelector(`input[value="${id}"]`)! as FakeElement & { checked: boolean };
  const applied: FilterCondition[] = [];
  const changes: Record<string, unknown>[] = [];
  let watch!: (params: URLSearchParams) => Promise<void>;
  let pending!: Promise<void>;
  let clears = 0;
  const ht = {
    t: (key: string) => key,
    say: (element: FakeElement, message: string) => { element.textContent = message; },
    request: lookup,
    pageState: {
      update: (values: Record<string, unknown>) => { changes.push(values); },
      watch: (_keys: string[], callback: typeof watch) => { watch = callback; pending = callback(initial); },
    },
  };
  runInNewContext(EVENT_FILTER_CONTROLS_SCRIPT + `\nmountEventFilterControls(options);`, {
    document, ht,
    options: { root: document.body, subjectFilter: get("filter-subject"), typeFilter: null, detectionFilter: null,
      addDetectionOptions: () => {}, apply: (condition: FilterCondition) => applied.push(condition), clear: () => { clears++; } },
  });
  return { get, camera, applied, changes, ready: () => pending, navigate: (query: URLSearchParams) => watch(query), clears: () => clears };
}

test("reloading a draft restores its friendly URL, name and time controls; device edits preserve its predicates", async () => {
  const draft = { all: [{ path: "/subject", op: "eq", value: "camera-5" }, ...record.filter.condition.all.slice(1)] } as const;
  const view = harness(new URLSearchParams({ "editing-filter": record.slug, where: JSON.stringify(draft) }));
  await view.ready();
  expect(view.get("filter-name").value).toBe("Morning people");
  expect(view.camera("camera-5").checked).toBe(true);
  expect(view.applied).toEqual([draft]);
  view.camera("camera-6").checked = true;
  view.camera("camera-6").dispatchEvent(new Event("change", { bubbles: true }));
  const changed = view.changes[0]!;
  expect(changed["editing-filter"]).toBe("morning-people");
  expect(changed.filter).toBeNull();
  const multiple = { all: [{ path: "/subject", op: "in", value: ["camera-5", "camera-6"] }, ...draft.all.slice(1)] };
  expect(JSON.parse(changed.where as string)).toEqual(multiple);
  await view.navigate(new URLSearchParams({ where: JSON.stringify(multiple) }));
  expect(view.camera("camera-5").checked && view.camera("camera-6").checked).toBe(true);
  expect(view.get("filter-subject").querySelector(".subject-selection")!.textContent).toBe("camera-5, camera-6");
  view.get("filter-subject").querySelector("button")!.click();
  expect(JSON.parse(view.changes.at(-1)!.where as string)).toEqual({ all: [...draft.all.slice(1)] });
});

test("out-of-order saved Filter reads cannot replace the current selection", async () => {
  let finish!: (value: unknown) => void;
  let calls = 0;
  const view = harness(new URLSearchParams({ filter: "slow" }), async () => ++calls === 1 ? new Promise(resolve => { finish = resolve; }) : { filters: [record] });
  await view.navigate(new URLSearchParams({ filter: record.slug }));
  finish({ filters: [{ ...record, slug: "slow", filter: { ...record.filter, name: "Old selection", condition: { all: [] } } }] });
  await view.ready();
  expect(view.applied).toEqual([record.filter.condition]);
  expect(view.get("filter-name").value).toBe("Morning people");
  expect(view.get("saved-filter").querySelectorAll("option").map(option => option.value)).toEqual(["", "morning-people"]);
  expect(view.clears()).toBe(2);
});

test("missing saved Filters display an error without applying an unrestricted predicate", async () => {
  const view = harness(new URLSearchParams({ filter: record.filter.id }));
  await view.ready();
  expect(view.applied).toEqual([]);
  expect(view.get("filter-feedback").textContent).toBe("filters.notFound");
  expect(view.get("filter-update").disabled).toBe(true);
});

const change = (view: ReturnType<typeof harness>, id: string, value: string | boolean) => {
  const input = view.get(id) as FakeElement & { checked: boolean };
  if (typeof value === "boolean") input.checked = value;
  else input.value = value;
  input.dispatchEvent(new Event("change", { bubbles: true }));
};

test("daily controls create an overnight predicate that survives reload and can be cleared", async () => {
  const view = harness(new URLSearchParams());
  await view.ready();
  view.get("filter-time-zone").value = "America/Los_Angeles";
  change(view, "filter-time-enabled", true);
  const draft = JSON.parse(view.changes.at(-1)!.where as string);
  expect(draft).toEqual({ all: [{ timeWindow: { start: "20:00", end: "08:00", timeZone: "America/Los_Angeles" } }] });
  const matches = compileFilterCondition(draft);
  const event = (at: string) => ({ at, type: "motion", level: "info" as const, message: "Motion" });
  expect(matches(event("2026-09-21T19:59:59-07:00"))).toBe(false);
  for (const at of ["2026-09-21T20:00:00-07:00", "2026-09-22T00:00:00-07:00", "2026-09-22T07:59:59-07:00"]) expect(matches(event(at))).toBe(true);
  expect(matches(event("2026-09-22T08:00:00-07:00"))).toBe(false);
  await view.navigate(new URLSearchParams({ where: JSON.stringify(draft) }));
  expect(view.get("filter-time-start").value).toBe("20:00");
  expect(view.get("filter-time-end").value).toBe("08:00");
  expect(view.get("filter-time-zone").value).toBe("America/Los_Angeles");
  change(view, "filter-time-enabled", false);
  expect(JSON.parse(view.changes.at(-1)!.where as string)).toEqual({ all: [] });
  expect(view.get("filter-time-start").disabled).toBe(true);
});

test("invalid times and zones stop results and saving, and correcting the same draft resumes it", async () => {
  const draft = { timeWindow: { start: "20:00", end: "08:00", timeZone: "UTC" } };
  const view = harness(new URLSearchParams({ where: JSON.stringify(draft) }));
  await view.ready();
  for (const [id, value, message] of [
    ["filter-time-end", "20:00", "filters.timeDifferent"],
    ["filter-time-end", "", "filters.timeRequired"],
    ["filter-time-zone", "Made/Up", "filters.timeZoneInvalid"],
  ]) {
    view.get("filter-time-end").value = "08:00";
    view.get("filter-time-zone").value = "UTC";
    change(view, id!, value!);
    expect(view.changes).toHaveLength(0);
    expect(view.get("filter-feedback").textContent).toBe(message!);
    expect(view.get("saved-filter-form").querySelector('button[type="submit"]')!.disabled).toBe(true);
  }
  change(view, "filter-time-zone", "UTC");
  expect(view.applied.at(-1)).toEqual({ all: [draft] });
  expect(view.get("saved-filter-form").querySelector('button[type="submit"]')!.disabled).toBe(false);
});

test("editing a time window preserves a custom observation timestamp and other predicates", async () => {
  const window = { start: "09:00", end: "12:00", timeZone: "UTC", timestamp: { path: "/data/frameTime", format: "unixSeconds" } };
  const other = { path: "/data/confidence", op: "gte", value: 0.8 };
  const view = harness(new URLSearchParams({ where: JSON.stringify({ all: [{ timeWindow: window }, other] }) }));
  await view.ready();
  change(view, "filter-time-start", "20:00");
  expect(JSON.parse(view.changes.at(-1)!.where as string)).toEqual({ all: [{ timeWindow: { ...window, start: "20:00" } }, other] });
});

test("saving and renaming use friendly page URLs while writes retain stable API IDs", async () => {
  const requests: { path: string; options: { method: string; body: string } }[] = [];
  let current = { ...record, slug: "night-visitors", filter: { ...record.filter, name: "Night visitors" } };
  const view = harness(new URLSearchParams(), async (path, options) => {
    if (!options) return { filters: [current] };
    requests.push({ path, options });
    return current;
  });
  await view.ready();
  view.get("filter-name").value = "Night visitors";
  view.get("saved-filter-form").dispatchEvent(new Event("submit", { cancelable: true }));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(requests[0]!.options.method).toBe("POST");
  expect(view.changes.at(-1)!.filter).toBe("night-visitors");
  current = { ...current, slug: "overnight-people", filter: { ...current.filter, name: "Overnight people" } };
  view.get("filter-name").value = current.filter.name;
  view.get("filter-update").click();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(requests[1]!.path).toBe(`/api/filters/${record.filter.id}`);
  expect(requests[1]!.options.method).toBe("PUT");
  expect(JSON.parse(requests[1]!.options.body).revision).toBe(1);
  expect(view.changes.at(-1)!.filter).toBe("overnight-people");
  expect(view.get("saved-filter").value).toBe("overnight-people");
});
