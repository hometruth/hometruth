import { expect, test } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import { HealthAdvisor, advisorSettings, type AdvisorCase, type AdvisorClient } from "./advisor";
import { HealthStore } from "./store";

const NOW = Date.parse("2026-10-15T12:00:00Z");
const answer = { summary: "The hub is offline", likelyCause: "The parent hub stopped responding first.", confidence: "medium",
  proposals: [{ title: "Power-cycle the hub", rationale: "It is the shared dependency.", steps: ["Unplug the hub for ten seconds."], changesDevice: true }] };

function message(content: Anthropic.ContentBlock[], stop: Anthropic.Message["stop_reason"], input = 2000, output = 500): Anthropic.Message {
  return { id: "msg", type: "message", role: "assistant", model: "claude-opus-5-5", content, stop_reason: stop, stop_sequence: null,
    usage: { input_tokens: input, output_tokens: output, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } as unknown as Anthropic.Message;
}
const text = (value: unknown) => ({ type: "text", text: JSON.stringify(value), citations: null }) as Anthropic.ContentBlock;

function fake(responses: (Anthropic.Message | Error)[], inputTokens = 2000) {
  const sent: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const client: AdvisorClient = {
    countTokens: async () => ({ input_tokens: inputTokens }),
    create: async params => { sent.push(structuredClone(params)); const next = responses.shift()!; if (next instanceof Error) throw next; return next; },
  };
  return { client, sent };
}

const failure: AdvisorCase = {
  investigationId: "inv-1", entity: { key: "device:lights", name: "Kitchen Lights" }, evidence: { trigger: "failed" },
  events: key => key === "device:lights" ? [{ at: "2026-10-15T11:59:00Z", level: "error", type: "command_failed", message: "Timed out" }] : undefined,
  overview: () => ({ elements: [{ key: "device:hub" }] }),
};
const settings = { apiKey: "test", model: "claude-opus-5-5", monthlyBudgetUsd: 5 };

test("settings come from vendors.anthropic and default to a $5 monthly cap", () => {
  expect(advisorSettings({ schemaVersion: 1 })).toBeUndefined();
  expect(advisorSettings({ schemaVersion: 1, vendors: { anthropic: { apiKey: "k" } } })).toEqual({ apiKey: "k", model: "claude-opus-5-5", monthlyBudgetUsd: 5 });
});

test("a review may use read-only tools, then records billed usage against the month", async () => {
  const store = new HealthStore();
  const { client, sent } = fake([
    message([{ type: "tool_use", id: "t1", name: "health_overview", input: {} } as Anthropic.ContentBlock], "tool_use"),
    message([text(answer)], "end_turn"),
  ]);
  const advice = await new HealthAdvisor(settings, store, client, () => NOW).advise(failure);
  expect(advice).toMatchObject({ status: "complete", summary: "The hub is offline", confidence: "medium" });
  // 2 requests × (2000 in × $4/M + 500 out × $20/M) = $0.036
  expect(advice.costUsd).toBeCloseTo(0.036, 6);
  expect(store.advisorSpend("2026-10")).toBeCloseTo(0.036, 6);
  expect(JSON.stringify(sent[1]!.messages)).toContain("device:hub");
  expect(sent[0]!.output_config?.effort).toBe("low");
});

test("the last allowed request must answer without tools", async () => {
  const call = (id: string) => message([{ type: "tool_use", id, name: "element_events", input: { key: "device:lights" } } as Anthropic.ContentBlock], "tool_use");
  const { client, sent } = fake([call("a"), call("b"), message([text(answer)], "end_turn")]);
  expect(await new HealthAdvisor(settings, new HealthStore(), client, () => NOW).advise(failure)).toMatchObject({ status: "complete" });
  expect(sent.map(params => params.tool_choice?.type)).toEqual([undefined, undefined, "none"]);
});

test("a request whose worst case does not fit the remaining budget is never sent", async () => {
  const store = new HealthStore();
  store.recordAdvisorSpend("2026-10", "earlier", "claude-opus-5-5", 4.95);
  const { client, sent } = fake([message([text(answer)], "end_turn")]);
  const advice = await new HealthAdvisor(settings, store, client, () => NOW).advise(failure);
  expect(advice).toMatchObject({ status: "skipped", costUsd: 0 });
  expect(advice.note).toContain("budget is used up");
  expect(sent).toHaveLength(0);
  // A new month starts fresh.
  expect(await new HealthAdvisor(settings, store, client, () => Date.parse("2026-11-01T00:00:00Z")).advise(failure)).toMatchObject({ status: "complete" });
});

test("an unpriced model is refused and an investigation is never charged twice", async () => {
  const store = new HealthStore();
  const { client, sent } = fake([message([text(answer)], "end_turn")]);
  expect(await new HealthAdvisor({ ...settings, model: "claude-unknown" }, store, client, () => NOW).advise(failure)).toMatchObject({ status: "skipped" });
  expect(sent).toHaveLength(0);
  await new HealthAdvisor(settings, store, client, () => NOW).advise(failure);
  expect(await new HealthAdvisor(settings, store, client, () => NOW).advise(failure)).toMatchObject({ status: "skipped", costUsd: 0 });
  expect(sent).toHaveLength(1);
});

test("a request with an unknown outcome is charged its full reservation; a rejected one is not", async () => {
  const store = new HealthStore();
  const lost = await new HealthAdvisor(settings, store, fake([new Anthropic.APIConnectionError({ message: "reset" })]).client, () => NOW).advise(failure);
  // 2000 in × $4/M + 4000 out × $20/M
  expect(lost).toMatchObject({ status: "failed", costUsd: 0.088 });
  const rejected = await new HealthAdvisor(settings, store, fake([new Anthropic.APIError(400, undefined, "bad", new Headers())]).client, () => NOW).advise({ ...failure, investigationId: "inv-2" });
  expect(rejected).toMatchObject({ status: "failed", costUsd: 0 });
  expect(store.advisorSpend("2026-10")).toBeCloseTo(0.088, 6);
});
