import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startLiviServer } from '../packages/server/src/server.js';
import { createModels, fauxProvider, fauxAssistantMessage } from '../vendor/pi/packages/ai/dist/index.js';

const directory = await mkdtemp(join(tmpdir(), 'livi-browser-'));
const faux = fauxProvider({ provider: 'google', models: [{ id: 'gemini-3.5-flash-lite' }], tokensPerSecond: 20, tokenSize: { min: 1, max: 1 } });
const models = createModels();
models.setProvider(faux.provider);
faux.setResponses([
  fauxAssistantMessage('Warm lighting and a soft rug make a cozy room.'),
  fauxAssistantMessage('A blue accent wall suits the second room.'),
  fauxAssistantMessage('This long response can be stopped. '.repeat(40)),
  fauxAssistantMessage('An interrupted answer that will be regenerated. '.repeat(40)),
  fauxAssistantMessage('Recovered answer after server restart.'),
]);
let server = await startLiviServer({ dataDirectory: directory, port: 0, models });
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
page.setDefaultTimeout(15_000);
try {
  await page.goto(`http://127.0.0.1:${server.port}`);
  await page.getByRole('button', { name: '+ New chat', exact: true }).click();
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('How can I make room one cozy?');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByText('Warm lighting and a soft rug make a cozy room.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Stop', exact: true }).waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '+ New chat', exact: true }).click();
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Suggest a color for room two.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByText('A blue accent wall suits the second room.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Stop', exact: true }).waitFor({ state: 'hidden' });
  assert.equal(await page.getByText('Warm lighting and a soft rug make a cozy room.', { exact: true }).count(), 0);
  await page.getByRole('navigation', { name: 'Conversations' }).getByRole('button').nth(1).click();
  await page.getByText('Warm lighting and a soft rug make a cozy room.', { exact: true }).waitFor();
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Give me a long answer.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await page.getByRole('button', { name: 'Stop', exact: true }).waitFor({ state: 'hidden' });
  await page.reload();
  await page.getByText('Warm lighting and a soft rug make a cozy room.', { exact: true }).waitFor();
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Recover this browser question.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByRole('button', { name: 'Stop', exact: true }).waitFor();
  // Wait for actual provider streaming before interrupting the runtime.
  await page.locator('.message.assistant').filter({ hasText: 'An interrupted' }).waitFor();
  const port = server.port;
  const identity = server.serverId;
  await server.close();
  server = await startLiviServer({ dataDirectory: directory, port, models });
  assert.equal(server.serverId, identity);
  await page.getByText('Recovered answer after server restart.', { exact: true }).waitFor();
  assert.equal(await page.getByText('Recover this browser question.', { exact: true }).count(), 1);
  assert.equal(await page.getByRole('navigation', { name: 'Conversations' }).getByRole('button').count(), 2);
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/chat-browser.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log('Browser verification passed: two chats, streaming, switching, Stop, reload, restart recovery.');
} finally {
  await browser.close();
  await server.close();
  await rm(directory, { recursive: true, force: true });
}
