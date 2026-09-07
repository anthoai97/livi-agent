import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRemoteServiceBinding } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createModels, fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { Client, createClientServiceTransport, type ByteTransportFactory } from '@earendil-works/pi-client';
import { AgentController, SessionDirectory, SessionManagement, Transcript } from '@livi/decorator-agent/contracts';
import { WebSocket } from 'ws';
import { startLiviServer } from '../src/server.ts';

function transport(port: number): ByteTransportFactory {
  return (handlers) => new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    socket.on('open', () => resolve({
      send: (bytes) => new Promise<void>((done, fail) => socket.send(bytes, { binary: true }, (error) => error ? fail(error) : done())),
      close: () => socket.close(),
    }));
    socket.on('message', (data) => handlers.onData(Array.isArray(data) ? Buffer.concat(data) : data instanceof ArrayBuffer ? new Uint8Array(data) : data));
    socket.on('close', handlers.onClose);
    socket.on('error', (error) => { reject(error); handlers.onError(error); });
  });
}

async function eventually(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'Timed out waiting for replicated state');
    await new Promise((done) => setTimeout(done, 10));
  }
}

async function connect(server: { serverId: string; port: number }) {
  const client = await Client.connect({ serverId: server.serverId, transportFactory: transport(server.port) });
  const binding = createRemoteServiceBinding({
    services: [SessionManagement, SessionDirectory],
    transport: createClientServiceTransport(client, () => ({ serverId: client.serverId })),
  });
  const management = binding.use(SessionManagement);
  const directory = binding.use(SessionDirectory);
  await binding.ready(context);
  return { client, management, directory, binding };
}

async function attach(connection: Awaited<ReturnType<typeof connect>>, sessionId: string) {
  await connection.management.attach(sessionId, context);
  const binding = createRemoteServiceBinding({
    services: [AgentController, Transcript],
    transport: createClientServiceTransport(connection.client, () => connection.client.attachment),
  });
  const controller = binding.use(AgentController);
  const transcript = binding.use(Transcript);
  await binding.ready(context);
  return { controller, transcript, binding };
}

function messages(transcript: Transcript): string[] {
  return (transcript.state.value?.snapshot?.transcript ?? []).flatMap((entry) => {
    if (entry.type !== 'message' || (entry.message.role !== 'user' && entry.message.role !== 'assistant')) return [];
    return typeof entry.message.content === 'string' ? [entry.message.content] :
      entry.message.content.flatMap((block) => block.type === 'text' ? [block.text] : []);
  });
}

test('real WebSocket routes isolate conversations, stream, reconnect, and survive SQLite restart', { timeout: 30_000 }, async (t) => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'livi-server-'));
  const faux = fauxProvider({ provider: 'google', models: [{ id: 'gemini-2.5-flash' }], tokensPerSecond: 100, tokenSize: { min: 1, max: 1 } });
  const models = createModels();
  models.setProvider(faux.provider);
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  faux.setResponses([async () => { started.resolve(); await release.promise; return fauxAssistantMessage('A quiet room with warm lighting.'); }]);
  const errors: Error[] = [];
  let server = await startLiviServer({ dataDirectory, port: 0, models, onError: (error) => errors.push(error) });
  const connections: Awaited<ReturnType<typeof connect>>[] = [];
  t.after(async () => {
    release.resolve();
    await Promise.all(connections.map(({ client }) => client.dispose()));
    await server.close();
    await rm(dataDirectory, { recursive: true, force: true });
  });
  const first = await connect(server);
  const second = await connect(server);
  connections.push(first, second);
  const roomA = await first.management.create({}, context);
  const roomB = await second.management.create({}, context);
  assert.notEqual(roomA.sessionId, roomB.sessionId);
  await eventually(() => second.directory.state.value?.sessions.length === 2);
  const a = await attach(first, roomA.sessionId);
  const b = await attach(second, roomB.sessionId);
  const response = await a.controller.prompt({ message: 'Design a quiet room' }, context);
  assert.equal(response.accepted, true);
  await started.promise;
  const busy = await a.controller.prompt({ message: 'Another request' }, context);
  assert.equal(busy.accepted, false);
  if (!busy.accepted) assert.equal(busy.error.code, 'lane_busy');
  await eventually(() => messages(a.transcript).includes('Design a quiet room'));
  assert.deepEqual(messages(b.transcript), []);

  first.client.disconnect();
  await first.binding.rebind(false, context);
  await eventually(() => server.connectionCount === 1);
  const detached = await attach(second, roomA.sessionId);
  let detachedUpdates = 0;
  detached.transcript.state.subscribe(() => { detachedUpdates += 1; });
  await detached.binding.dispose(context);
  const updatesAtDispose = detachedUpdates;
  await second.management.detach(context);
  const observer = await attach(second, roomA.sessionId);
  let sawStreaming = false;
  const stop = observer.transcript.state.subscribe((state) => {
    if (state.snapshot?.operation?.streamingMessage?.content.some((block) => block.type === 'text' && block.text.length > 0)) sawStreaming = true;
  });
  release.resolve();
  await eventually(() => messages(observer.transcript).includes('A quiet room with warm lighting.') && observer.transcript.state.value?.snapshot?.operation === null);
  stop();
  assert.equal(sawStreaming, true);
  assert.equal(detachedUpdates, updatesAtDispose, 'Disposed subscribers must receive no further stream updates');
  assert.equal(faux.state.callCount, 1, 'Disconnect must not cancel or duplicate an accepted operation');

  await first.client.reconnect();
  await first.binding.rebind(true, context);
  const reconnected = await attach(first, roomA.sessionId);
  assert.deepEqual(messages(reconnected.transcript), ['Design a quiet room', 'A quiet room with warm lighting.']);
  await reconnected.binding.dispose(context);
  await first.client.dispose();
  await second.client.dispose();
  await eventually(() => server.connectionCount === 0);
  const serverId = server.serverId;
  await server.close();
  server = await startLiviServer({ dataDirectory, port: 0, models, onError: (error) => errors.push(error) });
  assert.equal(server.serverId, serverId);
  const restored = await connect(server);
  connections.push(restored);
  assert.deepEqual(restored.directory.state.value?.sessions.map((session) => session.sessionId).sort(), [roomA.sessionId, roomB.sessionId].sort());
  const restoredA = await attach(restored, roomA.sessionId);
  assert.deepEqual(messages(restoredA.transcript), ['Design a quiet room', 'A quiet room with warm lighting.']);
  assert.equal(faux.state.callCount, 1, 'Reopening a completed session must not restart generation');
  faux.appendResponses([(request) => {
    assert.deepEqual(request.messages.map((message) => typeof message.content === 'string' ? message.content : message.content.flatMap((block) => block.type === 'text' ? [block.text] : []).join('')), ['Design a quiet room', 'A quiet room with warm lighting.', 'Which lamp fits?']);
    return fauxAssistantMessage('Choose a warm floor lamp.');
  }]);
  assert.equal((await restoredA.controller.prompt({ message: 'Which lamp fits?' }, context)).accepted, true);
  await eventually(() => messages(restoredA.transcript).includes('Choose a warm floor lamp.') && restoredA.transcript.state.value?.snapshot?.operation === null);
  const restoredB = await attach(restored, roomB.sessionId);
  assert.deepEqual(messages(restoredB.transcript), []);
  faux.appendResponses([fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'Invalid API key' })]);
  assert.equal((await restoredB.controller.prompt({ message: 'Show a provider failure' }, context)).accepted, true);
  await eventually(() => restoredB.transcript.state.value?.snapshot?.lastResult?.status === 'failed');
  assert.match(restoredB.transcript.state.value?.snapshot?.lastResult?.error?.message ?? '', /Invalid API key/);
  assert.equal(restoredB.transcript.state.value?.snapshot?.operation, null);
  faux.appendResponses([fauxAssistantMessage('The next request succeeds.')]);
  assert.equal((await restoredB.controller.prompt({ message: 'Try again' }, context)).accepted, true);
  await eventually(() => messages(restoredB.transcript).includes('The next request succeeds.') && restoredB.transcript.state.value?.snapshot?.operation === null);
  await assert.rejects(restored.management.attach('missing-session', context), /Unknown conversation/);
  assert.equal(faux.state.callCount, 4);
  assert.deepEqual(errors, []);
});

test('a killed server resumes the durable accepted operation without duplicating the user message', { timeout: 30_000 }, async (t) => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'livi-recovery-'));
  const child = fork(new URL('./interrupted-server.ts', import.meta.url), [dataDirectory], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  let restarted: Awaited<ReturnType<typeof startLiviServer>> | undefined;
  const connections: Awaited<ReturnType<typeof connect>>[] = [];
  t.after(async () => {
    child.kill('SIGKILL');
    await Promise.all(connections.map(({ client }) => client.dispose()));
    await restarted?.close();
    await rm(dataDirectory, { recursive: true, force: true });
  });
  const [ready] = await once(child, 'message') as [{ type: string; serverId: string; port: number }];
  assert.equal(ready.type, 'ready');
  const first = await connect(ready);
  connections.push(first);
  const room = await first.management.create({}, context);
  const attached = await attach(first, room.sessionId);
  const generating = once(child, 'message');
  const accepted = await attached.controller.prompt({ message: 'Keep my room design' }, context);
  assert.equal(accepted.accepted, true);
  assert.deepEqual((await generating)[0], { type: 'generating' });
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  await first.client.dispose();

  const faux = fauxProvider({ provider: 'google', models: [{ id: 'gemini-2.5-flash' }] });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage('Recovered room design')]);
  restarted = await startLiviServer({ dataDirectory, port: 0, models });
  assert.equal(restarted.serverId, ready.serverId);
  const recovered = await connect(restarted);
  connections.push(recovered);
  const session = await attach(recovered, room.sessionId);
  await eventually(() => messages(session.transcript).includes('Recovered room design') && session.transcript.state.value?.snapshot?.operation === null);
  assert.deepEqual(messages(session.transcript), ['Keep my room design', 'Recovered room design']);
  assert.equal(faux.state.callCount, 1);
});
