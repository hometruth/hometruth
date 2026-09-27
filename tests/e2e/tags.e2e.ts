import { expect, test } from "@playwright/test";
import { elementKey } from "../../src/tags/identity";

const unique = () => 'tag' + crypto.randomUUID().slice(0, 8);

test("tag detail navigation opens distinct Tags and Elements views on desktop and mobile", async ({ page }) => {
  const slug = unique();
  await page.request.post('/api/tags', { data: { slug, color: '#224488', description: '' } });
  const tabs = page.getByRole('navigation', { name: 'Tags', exact: true });
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/tags/' + slug);
    await tabs.getByRole('link', { name: 'Tags', exact: true }).click();
    await expect(page).toHaveURL(/\/tags$/);
    await expect(page.getByRole('heading', { name: 'Tags', exact: true })).toBeVisible();
    await expect(tabs.getByRole('link', { name: 'Tags', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('[data-tag-rows]').getByRole('link', { name: new RegExp(slug) })).toBeVisible();

    await page.goto('/tags/' + slug);
    let release: (() => void) | undefined;
    await page.route('**/api/elements?*', async route => {
      const response = await route.fetch();
      await new Promise<void>(resolve => { release = resolve; });
      await route.fulfill({ response });
    });
    await tabs.getByRole('link', { name: 'Elements', exact: true }).click();
    await expect(page).toHaveURL(/\/tags\?view=elements$/);
    await expect(page).toHaveTitle('Elements · HomeTruth');
    await expect(page.getByRole('heading', { name: 'Elements', exact: true })).toBeVisible();
    await expect(tabs.getByRole('link', { name: 'Elements', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('[data-tag-manager-feedback]')).toHaveText('Loading…');
    await expect(page.locator('[data-tag-rows]')).toHaveAttribute('aria-busy', 'true');
    await expect.poll(() => Boolean(release)).toBe(true);
    release!();
    await expect(page.locator('[data-tag-rows]').getByRole('link', { name: 'E2E relay', exact: true })).toBeVisible();
    await expect(page.locator('[data-tag-rows]')).toHaveAttribute('aria-busy', 'false');
    await page.unroute('**/api/elements?*');
  }
});

test("adds multiple tags with autocomplete, edits metadata, and keeps UUID assignments through rename", async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const slug = unique(); const second = unique();
  await page.request.post('/api/tags', { data: { slug: second, color: '#224488', description: 'Existing tag' } });
  await page.goto('/switches/e2e-relay');
  const editor = page.locator('[data-tag-editor]');
  await expect(editor).toBeVisible();
  const input = editor.getByRole('combobox', { name: 'Add a tag', exact: true });
  await expect(input).toBeEnabled();
  await input.fill('foo-bar');
  await expect(editor.getByRole('option', { name: /foo-bar/ })).toHaveCount(0);
  await input.press('Enter');
  await expect(editor.locator('[data-tag-feedback]')).toContainText('only letters');
  await expect(input).toHaveValue('foo-bar');
  await input.fill(slug);
  await input.press('Enter');
  await expect(editor.locator('[data-tag-chips]').getByRole('link', { name: slug, exact: true })).toBeVisible();
  await input.fill(second.slice(0, -2));
  await expect(editor.getByRole('option', { name: second, exact: true })).toBeVisible();
  await input.press('ArrowDown'); await input.press('Enter');
  await expect(editor.locator('[data-tag-chips]').getByRole('link', { name: second, exact: true })).toBeVisible();
  const key = elementKey('device', 'e2e-relay');
  const before = await (await page.request.get('/api/elements/' + key + '/tags')).json();
  const tag = before.tags.find((tag: { slug: string }) => tag.slug === slug);
  await page.screenshot({ path: info.outputPath('device-tags-desktop.png'), fullPage: true });
  await editor.getByRole('link', { name: slug, exact: true }).click();
  await expect(page.getByRole('heading', { name: slug, exact: true })).toBeVisible();
  await expect(page.locator('[data-tag-editor]')).toHaveCount(0);
  const renamed = slug + 'Renamed2';
  await page.getByLabel('Tag slug', { exact: true }).fill(renamed);
  await page.getByLabel('Color', { exact: true }).fill('#c73d65');
  await page.getByLabel('Description', { exact: true }).fill('Used for kitchen controls.');
  await page.getByRole('button', { name: 'Save tag', exact: true }).click();
  await expect(page.getByRole('heading', { name: renamed, exact: true })).toBeVisible();
  await expect(page.locator('[data-tag-rows]').getByRole('link', { name: 'E2E relay', exact: true })).toBeVisible();
  const after = await (await page.request.get('/api/elements/' + key + '/tags')).json();
  expect(after.tags.find((item: { id: string }) => item.id === tag.id)).toMatchObject({ id: tag.id, slug: renamed, color: '#c73d65', description: 'Used for kitchen controls.' });
  expect((await page.request.get('/tags/' + slug)).status()).toBe(404);
  await page.screenshot({ path: info.outputPath('tag-details-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: info.outputPath('tag-details-mobile.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.goto('/switches/e2e-relay');
  await expect(editor.locator('[data-tag-chips]').getByRole('link', { name: renamed, exact: true })).toBeVisible();
  const chip = editor.locator('.tag-chip').filter({ has: page.getByRole('link', { name: renamed, exact: true }) });
  await expect(chip).toHaveCSS('border-left-color', 'rgb(199, 61, 101)');
  await editor.getByRole('button', { name: 'Remove ' + renamed, exact: true }).click();
  await expect(editor.locator('[data-tag-chips]').getByRole('link', { name: renamed, exact: true })).toHaveCount(0);
  await expect(editor.locator('[data-tag-chips]').getByRole('link', { name: second, exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test("browses all element types from Tags and tags an automatic group and an individual control", async ({ page }, info) => {
  const slug = unique();
  await page.goto('/tags');
  await page.getByRole('link', { name: 'Elements', exact: true }).click();
  await page.getByRole('combobox', { name: 'Element type', exact: true }).selectOption('group');
  await page.getByLabel('Find elements', { exact: true }).fill('All Switches');
  await page.locator('[data-tag-rows]').getByRole('link', { name: 'All Switches', exact: true }).click();
  let editor = page.locator('[data-tag-editor]');
  let input = editor.getByRole('combobox', { name: 'Add a tag', exact: true });
  await expect(input).toBeEnabled(); await input.fill(slug); await input.press('Enter');
  await expect(editor.getByRole('link', { name: slug, exact: true })).toBeVisible();
  await page.goto('/tags?view=elements');
  await page.getByRole('combobox', { name: 'Element type', exact: true }).selectOption('control');
  await page.getByLabel('Find elements', { exact: true }).fill('E2E relay');
  await page.locator('[data-tag-rows]').getByRole('link', { name: 'turnOn', exact: true }).click();
  editor = page.locator('[data-tag-editor]'); input = editor.getByRole('combobox', { name: 'Add a tag', exact: true });
  await expect(input).toBeEnabled(); await input.fill(slug);
  await editor.getByRole('option', { name: slug, exact: true }).click();
  await expect(editor.getByRole('link', { name: slug, exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: info.outputPath('control-tags-mobile.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await editor.getByRole('link', { name: slug, exact: true }).click();
  await expect(page.locator('[data-tag-count]')).toHaveText('2 elements');
});

test("creates alphanumeric tags from Tags and rejects special characters without clearing the draft", async ({ page }) => {
  const slug = unique() + 'Kitchen2';
  await page.goto('/tags');
  await page.locator('summary').filter({ hasText: 'Create tag' }).click();
  for (const invalid of ['has spaces', 'foo-bar', 'foo_bar', 'tag!', 'é', '🚪']) {
    await page.getByLabel('Tag slug', { exact: true }).fill(invalid);
    await page.getByRole('button', { name: 'Create tag', exact: true }).click();
    await expect(page.locator('[data-tag-manager-feedback]')).toContainText('only letters');
    await expect(page.getByLabel('Tag slug', { exact: true })).toHaveValue(invalid);
  }
  await page.getByLabel('Tag slug', { exact: true }).fill(slug);
  await page.getByLabel('Description', { exact: true }).fill('Description with spaces & punctuation!');
  await page.getByRole('button', { name: 'Create tag', exact: true }).click();
  await expect(page.getByRole('heading', { name: slug, exact: true })).toBeVisible();
  await expect(page.getByLabel('Description', { exact: true })).toHaveValue('Description with spaces & punctuation!');
});
