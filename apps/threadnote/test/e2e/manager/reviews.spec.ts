import {modelOrigin, modelReply} from './fixtures/model.js';
import {createTopicReview} from './fixtures/topics.js';
import {compactAutomaticTopicDraftFixture} from '../../helpers/topic-draft-wire.js';
import {writeFile} from '@threadnote/testing/node-fs-promises';
import {join} from '@threadnote/testing/node-path';
import {test, expect} from './fixtures/test.js';
import {createAutomaticReview, fixtureTool, prepareAutomaticReview, proposeMemory} from './fixtures/reviews.js';
import {isJsonObject} from '@threadnote/platform/json';
import {Array as EffectArray} from 'effect';

test('S11 proposed memories require an explicit decision and survive defer/reopen/apply @compat', async ({
  page,
  manager,
}) => {
  const identity = await proposeMemory(manager, 'browser-review');
  await page.getByRole('button', {name: 'Refresh manager', exact: true}).click();
  await page
    .getByRole('navigation', {name: 'Manager sections'})
    .getByRole('button', {name: 'Reviews', exact: true})
    .click();
  const card = page.locator('.attention-card').filter({hasText: 'Review browser-review'});
  await expect(card).toBeVisible();
  await card.getByRole('button', {name: 'Review and decide →', exact: true}).first().click();
  const dialog = page.getByRole('dialog', {name: 'Review proposed memory', exact: true});
  await expect(dialog).toContainText('Keep the fixture approval explicit.');
  await dialog.getByText('Source evidence', {exact: true}).click();
  await expect(dialog).toContainText('manager-e2e-browser-review');
  await dialog.getByRole('button', {name: 'Close details', exact: true}).click();
  expect(JSON.stringify(await manager.api('/api/reviews?project=manager-e2e&view=pending'))).toContain('pending');
  await card.getByRole('button', {name: 'Review and decide →', exact: true}).first().click();
  await dialog.getByRole('button', {name: 'Defer', exact: true}).click();
  await page.getByRole('tab', {name: 'Deferred', exact: true}).click();
  await page.getByRole('button', {name: 'Review and decide →', exact: true}).first().click();
  await dialog.getByRole('button', {name: 'Approve and apply', exact: true}).click();
  await expect(dialog).not.toBeVisible();
  const history = await manager.api('/api/reviews?project=manager-e2e&view=history');
  expect(JSON.stringify(history)).toContain('applied');
  const preview = await manager.api('/api/reviews/preview', {project: 'manager-e2e', reviewId: identity.reviewId});
  if (!isJsonObject(preview.review) || !EffectArray.isArray(preview.review.auditEvents))
    throw new Error('Review audit is unavailable.');
  let appliedUri: string | undefined;
  for (const event of preview.review.auditEvents) {
    if (
      isJsonObject(event) &&
      event.action === 'apply' &&
      event.candidateId === identity.candidateId &&
      typeof event.memoryUri === 'string'
    )
      appliedUri = event.memoryUri;
  }
  if (!appliedUri) throw new Error('The exact candidate has no applied-memory receipt.');
  const applied = await manager.cli(['read', appliedUri]);
  expect(applied).toContain('Keep the fixture approval explicit.');
  expect(applied).toContain('Preserve a reviewable approval boundary.');
  expect(applied).toContain('memory_id: tn_');
  await page.reload();
  await page
    .getByRole('navigation', {name: 'Manager sections'})
    .getByRole('button', {name: 'Reviews', exact: true})
    .click();
  await page.getByRole('tab', {name: 'History', exact: true}).click();
  await expect(page.locator('.attention-card').filter({hasText: 'Review browser-review'})).toContainText('applied');
  expect(await manager.cli(['read', appliedUri])).toBe(applied);
});

test('S11 an open review refuses a changed revision and rejection writes no memory', async ({page, manager}) => {
  const sentinel = await manager.remember('Preserve this independent memory.', 'sentinel');
  const identity = await proposeMemory(manager, 'stale-browser-review');
  await page.getByRole('button', {name: 'Refresh manager', exact: true}).click();
  await page
    .getByRole('navigation', {name: 'Manager sections'})
    .getByRole('button', {name: 'Reviews', exact: true})
    .click();
  await page.getByRole('button', {name: 'Review and decide →', exact: true}).first().click();
  const dialog = page.getByRole('dialog', {name: 'Review proposed memory', exact: true});
  await expect(dialog.getByRole('button', {name: 'Approve and apply', exact: true})).toBeEnabled();
  await fixtureTool(manager, 'apply_memory_candidates', {...identity, action: 'defer'});
  const error = 'The review changed. Close and reopen it before deciding.';
  manager.expectedErrors.push({path: '/api/reviews/decide', status: 409, error});
  await dialog.getByRole('button', {name: 'Approve and apply', exact: true}).click();
  await expect(dialog.getByRole('alert')).toHaveText(error);
  await dialog.getByRole('button', {name: 'Close details', exact: true}).click();
  await page.getByRole('tab', {name: 'Deferred', exact: true}).click();
  await page.getByRole('button', {name: 'Review and decide →', exact: true}).first().click();
  await dialog.getByRole('button', {name: 'Reject', exact: true}).click();
  await expect(dialog).toHaveCount(0);
  expect(JSON.stringify(await manager.api('/api/reviews?project=manager-e2e&view=history'))).toContain('rejected');
  expect(await manager.cli(['list', 'threadnote://user/playwright/memories'])).not.toContain('stale-browser-review');
  expect(await manager.cli(['read', sentinel])).toContain('Preserve this independent memory.');
});

test('S11 an automatic review defers, resumes, applies and verifies the exact source-bound body', async ({
  page,
  manager,
}) => {
  test.setTimeout(90_000);
  const review = await createAutomaticReview(manager);
  await page.getByRole('button', {name: 'Refresh manager', exact: true}).click();
  await page
    .getByRole('navigation', {name: 'Manager sections'})
    .getByRole('button', {name: 'Reviews', exact: true})
    .click();
  const card = page.locator('.attention-card').filter({has: page.locator(`[data-review-id="${review.reviewId}"]`)});
  await card.getByRole('button', {name: 'Review update →', exact: true}).click();
  const dialog = page.getByRole('dialog', {name: 'Review memory update', exact: true});
  await expect(dialog).toContainText('The timeout is 30 seconds.');
  await expect(dialog).toContainText('The timeout is 60 seconds.');
  await expect(dialog).toContainText('Exact document & metadata preview');
  await dialog.getByRole('button', {name: 'Defer', exact: true}).click();
  await expect(dialog.getByRole('button', {name: 'Resume review', exact: true})).toBeVisible();
  expect((await manager.api(`/api/memory?uri=${encodeURIComponent(review.uri)}`)).content).toBe(review.before);
  await dialog.getByRole('button', {name: 'Resume review', exact: true}).click();
  await dialog.getByRole('button', {name: 'Apply update', exact: true}).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText('Memory update saved and verified.', {exact: true})).toBeVisible();
  const applied = await manager.cli(['read', review.uri]);
  expect(applied).toContain('The timeout is 60 seconds.');
  expect(applied).not.toContain('The timeout is 30 seconds.');
  expect(applied).toContain('reviewed_support:');
  await page.reload();
  expect(await manager.cli(['read', review.uri])).toBe(applied);
  await page
    .getByRole('navigation', {name: 'Manager sections'})
    .getByRole('button', {name: 'Library', exact: true})
    .click();
  const search = page.getByRole('searchbox', {name: 'Search Library'});
  await search.fill(review.uri);
  await search.press('Enter');
  await search.fill('');
  await page.getByRole('button', {name: 'Edit', exact: true}).click();
  await page.getByRole('textbox', {name: 'editable markdown', exact: true}).fill('The timeout is 90 seconds.');
  await page.getByRole('button', {name: 'Save', exact: true}).click();
  const edit = page.getByRole('dialog', {name: 'Review your memory edit', exact: true});
  await expect(edit).toContainText('Affected support will be invalidated');
  await expect(edit).toContainText('The timeout is 90 seconds.');
  await edit.getByRole('button', {name: 'Close details', exact: true}).click();
  expect(await manager.cli(['read', review.uri])).toBe(applied);
  await page.getByRole('button', {name: 'Save', exact: true}).click();
  await edit.getByRole('button', {name: 'Apply update', exact: true}).click();
  await expect(edit).toHaveCount(0);
  const authored = await manager.cli(['read', review.uri]);
  expect(authored).toContain('The timeout is 90 seconds.');
  expect(authored).toContain('"support":"unresolved"');
  expect(/memory_id: (tn_\S+)/u.exec(authored)?.[1]).toBe(/memory_id: (tn_\S+)/u.exec(applied)?.[1]);
});

test('S11 an automatic approval refuses source changes and preserves the accepted target', async ({page, manager}) => {
  test.setTimeout(60_000);
  const review = await createAutomaticReview(manager);
  await page.getByRole('button', {name: 'Refresh manager', exact: true}).click();
  await page
    .getByRole('navigation', {name: 'Manager sections'})
    .getByRole('button', {name: 'Reviews', exact: true})
    .click();
  await page
    .locator('.attention-card')
    .filter({has: page.locator(`[data-review-id="${review.reviewId}"]`)})
    .getByRole('button', {name: 'Review update →', exact: true})
    .click();
  const dialog = page.getByRole('dialog', {name: 'Review memory update', exact: true});
  await expect(dialog.getByRole('button', {name: 'Apply update', exact: true})).toBeEnabled();
  await fixtureTool(manager, 'remember_context', {
    kind: 'durable',
    project: 'alpha',
    topic: 'z-source',
    replaceUri: review.source,
    text: 'The timeout is 90 seconds.',
    callerCwd: review.repository.root,
  });
  const error = 'The target or source access changed. Reload the memory and its exact review before continuing.';
  manager.expectedErrors.push({path: '/api/attention/automatic-review', status: 409, error});
  await dialog.getByRole('button', {name: 'Apply update', exact: true}).click();
  await expect(dialog.getByRole('alert')).toContainText(error);
  await dialog.getByRole('button', {name: 'Reload exact review', exact: true}).click();
  await expect(dialog).toContainText('Source evidence changed');
  await expect(dialog.getByRole('button', {name: 'Apply update', exact: true})).toHaveCount(0);
  expect((await manager.api(`/api/memory?uri=${encodeURIComponent(review.uri)}`)).content).toBe(review.before);
  expect(await manager.cli(['read', review.source])).toContain('The timeout is 90 seconds.');
});

test.describe('foreground model boundary', () => {
  test.use({managerScenario: 'remote-model'});
  test('S11 enrolled topics expose the proposal editor, cancel safely and verify an explicit update', async ({
    page,
    manager,
  }) => {
    test.setTimeout(90_000);
    const topic = await createTopicReview(manager);
    await page.getByRole('button', {name: 'Refresh manager', exact: true}).click();
    await page
      .getByRole('navigation', {name: 'Manager sections'})
      .getByRole('button', {name: 'Reviews', exact: true})
      .click();
    const card = page.locator('.attention-card').filter({has: page.locator(`[data-review-id="${topic.reviewId}"]`)});
    await card.getByRole('button', {name: 'Review and decide →', exact: true}).click();
    const dialog = page.getByRole('dialog', {name: 'Review topic update', exact: true});
    const editor = dialog.getByRole('textbox', {name: 'Proposed descriptive paragraph 1', exact: true});
    await expect(editor).toHaveValue('The greeting returns a trimmed uppercase name.');
    await editor.fill('The greeting trims the name and converts it to uppercase.');
    await dialog.getByRole('button', {name: 'Save draft', exact: true}).click();
    await expect(dialog.getByRole('region', {name: 'Exact final document', exact: true})).toContainText(
      'The greeting trims the name and converts it to uppercase.',
    );
    await dialog.getByRole('button', {name: 'Close details', exact: true}).click();
    expect((await manager.api(`/api/memory?uri=${encodeURIComponent(topic.uri)}`)).content).toBe(topic.before);
    await card.getByRole('button', {name: 'Review and decide →', exact: true}).click();
    const acceptance = page.waitForResponse(
      response =>
        new URL(response.url()).pathname === '/api/attention/topic-review' &&
        response.request().postDataJSON()?.action === 'apply',
    );
    await dialog.getByRole('button', {name: 'Apply update', exact: true}).click();
    const saved: unknown = await (await acceptance).json();
    if (isJsonObject(saved) && saved.canFinishVerification === true) {
      expect(saved).toMatchObject({state: 'applied', approval: {stage: 'written'}});
      const written = (await manager.api(`/api/memory?uri=${encodeURIComponent(topic.uri)}`)).content;
      await dialog.getByRole('button', {name: 'Finish saved update verification', exact: true}).click();
      expect((await manager.api(`/api/memory?uri=${encodeURIComponent(topic.uri)}`)).content).toBe(written);
    }
    await expect(dialog).toHaveCount(0);
    await manager.api('/api/attention/context-maintenance?view=controls', {action: 'pause'});
    const applied = await manager.cli(['read', topic.uri]);
    expect(applied).toContain('The greeting trims the name and converts it to uppercase.');
    expect(applied).toContain('topic_maintenance:');
    await page.reload();
    expect(await manager.cli(['read', topic.uri])).toBe(applied);
  });
  test('S11 generation exposes pending and malformed-output failure, then retries a source-bound proposal', async ({
    page,
    manager,
  }) => {
    test.setTimeout(90_000);
    const prepared = await prepareAutomaticReview(manager);
    await fixtureTool(manager, 'context_maintain', {
      action: 'background-pause',
      callerCwd: prepared.repository.root,
      project: 'alpha',
    });
    await manager.api('/api/attention/context-maintenance?view=controls', {action: 'resume'});
    const status = await manager.api(
      `/api/attention/automatic-memory?project=alpha&uri=${encodeURIComponent(prepared.uri)}`,
    );
    expect(status.items).toEqual(
      expect.arrayContaining([expect.objectContaining({uri: prepared.uri, canGenerate: true})]),
    );
    await page.getByRole('button', {name: 'Refresh manager', exact: true}).click();
    await page
      .getByRole('navigation', {name: 'Manager sections'})
      .getByRole('button', {name: 'Library', exact: true})
      .click();
    const search = page.getByRole('searchbox', {name: 'Search Library'});
    await search.fill(prepared.uri);
    await search.press('Enter');
    await search.fill('');
    const card = page.locator('.automatic-memory-card');
    await card.getByText('Generate now (optional)', {exact: true}).click();
    await card.getByRole('combobox', {name: 'Provider', exact: true}).selectOption('effect-ai');
    const generate = card.getByRole('button', {name: 'Generate now', exact: true});
    await expect(generate).toBeEnabled();
    const error =
      'Generation could not produce a bounded review. Check model setup and exact source coverage; an existing review must be resolved first.';
    manager.expectedErrors.push({path: '/api/attention/automatic-review', status: 409, error});
    const failed = page.waitForResponse(
      response =>
        new URL(response.url()).pathname === '/api/attention/automatic-review' &&
        response.request().method() === 'POST',
    );
    await generate.click();
    await expect
      .poll(async () => EffectArray.some(await manager.networkJournal(), entry => entry.origin === modelOrigin))
      .toBe(true);
    await expect(card).toContainText('Generating from the exact selected memory and source bounds…');
    expect((await manager.api(`/api/memory?uri=${encodeURIComponent(prepared.uri)}`)).content).toBe(prepared.before);
    await writeFile(join(manager.root, 'model-response-ready'), 'ready');
    expect((await failed).status()).toBe(409);
    await expect(card.getByRole('alert')).toContainText(error);
    expect((await manager.api(`/api/memory?uri=${encodeURIComponent(prepared.uri)}`)).content).toBe(prepared.before);
    await modelReply(manager, JSON.stringify(compactAutomaticTopicDraftFixture(prepared.basis, prepared.draft)));
    await page.reload();
    await page
      .getByRole('navigation', {name: 'Manager sections'})
      .getByRole('button', {name: 'Library', exact: true})
      .click();
    await search.fill(prepared.uri);
    await search.press('Enter');
    await search.fill('');
    await card.getByText('Generate now (optional)', {exact: true}).click();
    await card.getByRole('combobox', {name: 'Provider', exact: true}).selectOption('effect-ai');
    await generate.click();
    const dialog = page.getByRole('dialog', {name: 'Review memory update', exact: true});
    await expect(dialog).toContainText('The timeout is 60 seconds.');
    await dialog.getByRole('button', {name: 'Apply update', exact: true}).click();
    await expect.poll(() => manager.cli(['read', prepared.uri])).toContain('The timeout is 60 seconds.');
  });
});
