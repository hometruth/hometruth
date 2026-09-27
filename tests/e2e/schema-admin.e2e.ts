import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import type { SchemaCatalogResponse } from "../../src/schemas";
import { testValidators } from "./validation";

async function getCatalog(request: APIRequestContext, baseURL: string): Promise<SchemaCatalogResponse> {
  const response = await request.get(`${baseURL}/api/admin/schemas`);
  const body: unknown = await response.json();

  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toBe("no-store");
  expect(testValidators.schemaCatalogResponse(body)).toBe(true);

  const catalog = body as SchemaCatalogResponse;
  const actualCounts = { business: 0, api: 0, system: 0 };
  for (const entry of catalog.schemas) {
    actualCounts[entry.category] += 1;
    expect(entry.schemaId).toBe(entry.schema.$id);
  }
  expect(catalog.counts).toEqual(actualCounts);
  expect(catalog.counts.business).toBeGreaterThan(0);
  expect(new Set(catalog.schemas.map((entry) => entry.key)).size).toBe(catalog.schemas.length);
  expect(new Set(catalog.schemas.map((entry) => entry.schemaId)).size).toBe(catalog.schemas.length);

  const categories = catalog.schemas.map((entry) => entry.category);
  expect(categories.slice(0, catalog.counts.business).every((category) => category === "business"))
    .toBe(true);
  return catalog;
}

async function exerciseCatalogUI(
  page: Page,
  baseURL: string,
  catalog: SchemaCatalogResponse,
  searchTerm: string,
) {
  const searchMatches = catalog.schemas.filter((entry) => [
    entry.title,
    entry.typeName,
    entry.description,
    entry.schemaId,
    ...Object.keys(entry.schema.properties ?? {}),
  ].join(" ").toLowerCase().includes(searchTerm.toLowerCase()));
  const businessEntries = catalog.schemas.filter((entry) => entry.category === "business");

  await page.goto(`${baseURL}/admin/schemas`);
  await expect(page.getByRole("heading", { name: "Schemas", exact: true })).toBeVisible();
  await expect(page.locator("#summary")).toHaveText(
    `${catalog.schemas.length} of ${catalog.schemas.length}`,
  );

  const cards = page.locator("#schemas article");
  await expect(cards).toHaveCount(catalog.schemas.length);
  const initialCategories = await cards.evaluateAll((articles) =>
    articles.map((article) => (article as HTMLElement).dataset.category),
  );
  expect(initialCategories.slice(0, businessEntries.length).every((category) => category === "business"))
    .toBe(true);

  await page.locator("#search").fill(searchTerm);
  await expect(page.locator("#summary")).toHaveText(
    `${searchMatches.length} of ${catalog.schemas.length}`,
  );
  await expect(cards).toHaveCount(searchMatches.length);
  for (const entry of searchMatches) {
    await expect(page.getByRole("heading", { name: entry.title, exact: true })).toBeVisible();
  }

  await page.locator("#search").clear();
  await page.locator("#category").selectOption("business");
  await expect(page.locator("#summary")).toHaveText(
    `${businessEntries.length} of ${catalog.schemas.length}`,
  );
  await expect(cards).toHaveCount(businessEntries.length);
  for (const entry of businessEntries) {
    await expect(page.getByRole("heading", { name: entry.title, exact: true })).toBeVisible();
  }
  expect(await cards.evaluateAll((articles) =>
    articles.every((article) => (article as HTMLElement).dataset.category === "business"),
  )).toBe(true);
}

test("returns the app schema catalog contract", async ({ request, baseURL }) => {
  if (!baseURL) throw new Error("Playwright base URL is required");
  await getCatalog(request, baseURL.replace(/\/$/, ""));
});

test("searches and filters the app schema inventory with business models first", async ({ page, request, baseURL }) => {
  if (!baseURL) throw new Error("Playwright base URL is required");
  const projectURL = baseURL.replace(/\/$/, "");
  const catalog = await getCatalog(request, projectURL);
  await exerciseCatalogUI(page, projectURL, catalog, "camera");
});
