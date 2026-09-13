import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
	BACKGROUND_CONTEXT,
	type Context,
	type SessionMetadata,
	type SessionRepo,
} from "@earendil-works/pi-agent-core";
import type { Models } from "@earendil-works/pi-ai";
import { Server, type ServerHost, SessionNotFoundError } from "@earendil-works/pi-server";
import { PostgresSessionRepo } from "@earendil-works/pi-session-backend-postgres-node";
import { createNodeSqliteFactory, SqliteSessionRepo } from "@earendil-works/pi-session-backend-sqlite-node";
import {
	type CatalogAccess,
	createServerServices,
	DecoratorSession,
	StudioBroker,
	unavailableCatalogAccess,
} from "@livi/decorator-agent";
import type { Pool } from "pg";
import { WebSocket, WebSocketServer } from "ws";
import { createCatalogModels } from "./catalog-models.js";
import { createCatalogPool, createPostgresCatalogAccess, parseCatalogDatabaseUrl } from "./catalog-postgres.js";
import { createDebugLogger } from "./debug.js";

export interface LiviServerOptions {
	dataDirectory?: string;
	clientDirectory?: string;
	host?: string;
	port?: number;
	models?: Models;
	modelId?: string;
	apiKey?: string;
	onError?: (error: Error) => void;
	studioAllowedOrigins?: string[];
	debug?: boolean;
	catalogDatabaseUrl?: string;
	sessionDatabaseUrl?: string;
	catalog?: CatalogAccess;
}

// Keep backend-specific metadata inside the adapter. The host routes by session ID.
function sessionBackend<T extends SessionMetadata>(repo: SessionRepo<T> & { close(context: Context): Promise<void> }) {
	return {
		list: () => repo.list(undefined, BACKGROUND_CONTEXT),
		create: () => repo.create({}, BACKGROUND_CONTEXT),
		async open(id: string) {
			const metadata = (await repo.list(undefined, BACKGROUND_CONTEXT)).find((item) => item.id === id);
			if (!metadata) throw new SessionNotFoundError(`Unknown conversation: ${id}`);
			return repo.open(metadata, BACKGROUND_CONTEXT);
		},
		close: () => repo.close(BACKGROUND_CONTEXT),
	};
}

function debugOrigin(origin: string | undefined) {
	if (!origin) return null;
	try {
		const parsed = new URL(origin);
		return ["http:", "https:"].includes(parsed.protocol) ? parsed.origin : "invalid";
	} catch {
		return "invalid";
	}
}

export async function startLiviServer(options: LiviServerOptions = {}) {
	const onDebug = createDebugLogger(options.debug === true);
	const studioOrigins = new Set(
		(options.studioAllowedOrigins ?? []).map((origin) => {
			const parsed = new URL(origin);
			if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== origin)
				throw new Error(`Expected an exact HTTP(S) Studio origin: ${origin}`);
			return origin;
		}),
	);
	const catalogUrl = options.catalogDatabaseUrl?.trim()
		? parseCatalogDatabaseUrl(options.catalogDatabaseUrl.trim())
		: undefined;
	const context = BACKGROUND_CONTEXT;
	const dataDirectory = resolve(options.dataDirectory ?? fileURLToPath(new URL("../../.data", import.meta.url)));
	const clientDirectory = resolve(
		options.clientDirectory ?? fileURLToPath(new URL("../../livi-client/dist", import.meta.url)),
	);
	await mkdir(dataDirectory, { recursive: true });
	const identityPath = resolve(dataDirectory, "server-id");
	let serverId: string;
	try {
		serverId = (await readFile(identityPath, "utf8")).trim();
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
		serverId = randomUUID();
		await writeFile(identityPath, `${serverId}\n`, { flag: "wx", mode: 0o600 });
	}
	const earlyCleanups: (() => void | Promise<void>)[] = [];
	let shutdown: (() => Promise<void>) | undefined;
	try {
		const repo =
			options.sessionDatabaseUrl === undefined
				? sessionBackend(
						new SqliteSessionRepo({
							directory: resolve(dataDirectory, "sessions"),
							databaseFactory: createNodeSqliteFactory(),
						}),
					)
				: sessionBackend(await PostgresSessionRepo.connect({ connectionString: options.sessionDatabaseUrl }));
		earlyCleanups.push(() => repo.close());
		const reportError = options.onError ?? ((error: Error) => console.error(error));
		let catalogPool: Pool | undefined;
		let catalog = options.catalog ?? unavailableCatalogAccess();
		if (!options.catalog && catalogUrl) {
			catalogPool = createCatalogPool(catalogUrl);
			const allocatedPool = catalogPool;
			earlyCleanups.push(() => allocatedPool.end());
			catalog = createPostgresCatalogAccess(catalogPool, {
				models: createCatalogModels({ apiKey: options.apiKey }),
				onDebug,
			});
		}
		const studio = new StudioBroker();
		earlyCleanups.push(() => studio.close());
		const services = await createServerServices({
			studio,
			list: async () => (await repo.list()).map(({ id, createdAt }) => ({ serverId, sessionId: id, createdAt })),
			create: async () => {
				const session = await repo.create();
				try {
					return { serverId, sessionId: session.metadata.id, createdAt: session.metadata.createdAt };
				} finally {
					await session.close(context);
				}
			},
		});
		earlyCleanups.push(() => services.dispose());
		const host: ServerHost = {
			serverServices: services.host,
			async resolveSession(sessionId) {
				const metadata = (await repo.list()).find((item) => item.id === sessionId);
				if (!metadata) throw new SessionNotFoundError(`Unknown conversation: ${sessionId}`);
				return metadata;
			},
			async openSession(metadata) {
				const session = await repo.open(metadata.id);
				try {
					return await DecoratorSession.create({
						session,
						models: options.models,
						modelId: options.modelId,
						apiKey: options.apiKey,
						onError: reportError,
						onDebug,
						studio,
						catalog,
					});
				} catch (error) {
					await session.close(context);
					throw error;
				}
			},
		};
		let connectionCount = 0;
		const protocol = new Server(host, {
			serverId,
			listeners: [],
			onError: reportError,
			onConnectionCountChanged: (count) => {
				connectionCount = count;
			},
		});
		earlyCleanups.push(() => protocol.close());
		const sockets = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
		const http = createServer((request, response) => {
			void (async () => {
				const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
				if (pathname === "/api/bootstrap" && request.headers.origin) {
					const origin = request.headers.origin;
					if (
						!studioOrigins.has(origin) &&
						origin !== `http://${request.headers.host}` &&
						origin !== `https://${request.headers.host}`
					) {
						onDebug?.("bootstrap.rejected", { origin: debugOrigin(origin), reason: "origin_not_allowed" });
						response.writeHead(403).end();
						return;
					}
					response.setHeader("access-control-allow-origin", origin);
					response.setHeader("vary", "Origin");
				}
				if (request.method !== "GET" && request.method !== "HEAD") {
					response.writeHead(405).end();
					return;
				}
				if (pathname === "/health" || pathname === "/api/bootstrap") {
					response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
					response.end(JSON.stringify(pathname === "/health" ? { status: "ok" } : { serverId, wsPath: "/ws" }));
					return;
				}
				if (pathname.startsWith("/api/") || pathname === "/ws") {
					response.writeHead(404).end();
					return;
				}
				const requested = resolve(clientDirectory, `.${decodeURIComponent(pathname)}`);
				if (requested !== clientDirectory && !requested.startsWith(clientDirectory + sep)) {
					response.writeHead(403).end();
					return;
				}
				let file = requested;
				try {
					if (!(await stat(file)).isFile()) file = resolve(clientDirectory, "index.html");
				} catch {
					file = resolve(clientDirectory, "index.html");
				}
				try {
					const metadata = await stat(file);
					const mime: Record<string, string> = {
						".html": "text/html; charset=utf-8",
						".js": "text/javascript; charset=utf-8",
						".css": "text/css; charset=utf-8",
						".svg": "image/svg+xml",
						".json": "application/json",
					};
					response.writeHead(200, {
						"content-type": mime[extname(file)] ?? "application/octet-stream",
						"content-length": metadata.size,
					});
					if (request.method === "HEAD") response.end();
					else
						createReadStream(file)
							.on("error", () => response.destroy())
							.pipe(response);
				} catch {
					response
						.writeHead(404, { "content-type": "text/plain" })
						.end("Frontend unavailable. Run pnpm build or pnpm dev.");
				}
			})().catch((error: unknown) => {
				reportError(error instanceof Error ? error : new Error(String(error)));
				if (!response.headersSent) response.writeHead(500);
				response.end();
			});
		});
		http.on("upgrade", (request, socket, head) => {
			const connectionId = randomUUID();
			const connectionFields = { connectionId, origin: debugOrigin(request.headers.origin) };
			if (request.url !== "/ws") {
				onDebug?.("connection.rejected", { ...connectionFields, reason: "invalid_path" });
				socket.destroy();
				return;
			}
			// Same-origin chat and explicitly configured Studio origins only.
			const origin = request.headers.origin;
			if (origin) {
				try {
					if (new URL(origin).host !== request.headers.host && !studioOrigins.has(origin)) {
						onDebug?.("connection.rejected", { ...connectionFields, reason: "origin_not_allowed" });
						socket.destroy();
						return;
					}
				} catch {
					onDebug?.("connection.rejected", { ...connectionFields, reason: "invalid_origin" });
					socket.destroy();
					return;
				}
			}
			sockets.handleUpgrade(request, socket, head, (websocket) => {
				onDebug?.("connection.accepted", connectionFields);
				const handler = protocol.accept({
					get closed() {
						return websocket.readyState !== WebSocket.OPEN;
					},
					send(chunk) {
						return new Promise<void>((resolveSend, reject) =>
							websocket.send(chunk, { binary: true }, (error) => (error ? reject(error) : resolveSend())),
						);
					},
					async close(finalChunk) {
						if (finalChunk && websocket.readyState === WebSocket.OPEN) {
							await new Promise<void>((done) => websocket.send(finalChunk, { binary: true }, () => done()));
						}
						websocket.terminate();
					},
				});
				websocket.on("message", (data, binary) => {
					if (!binary) {
						websocket.close(1003, "Binary PI frames required");
						return;
					}
					handler.onData(
						Array.isArray(data) ? Buffer.concat(data) : data instanceof ArrayBuffer ? new Uint8Array(data) : data,
					);
				});
				websocket.on("close", () => handler.onClose());
				websocket.on("error", (error) => handler.onError(error));
			});
		});
		let closing: Promise<void> | undefined;
		const close = () => {
			closing ??= (async () => {
				const errors: unknown[] = [];
				for (const cleanup of [
					() => studio.close(),
					() => protocol.close(),
					() => services.dispose(),
					() => repo.close(),
					() => (catalogPool ? catalogPool.end() : Promise.resolve()),
					() => new Promise<void>((done, reject) => sockets.close((error) => (error ? reject(error) : done()))),
					() =>
						new Promise<void>((done, reject) =>
							http.close((error) =>
								error && !("code" in error && error.code === "ERR_SERVER_NOT_RUNNING") ? reject(error) : done(),
							),
						),
				]) {
					try {
						await cleanup();
					} catch (error) {
						errors.push(error);
					}
				}
				if (errors.length) throw new AggregateError(errors, "Server shutdown failed");
			})();
			return closing;
		};
		shutdown = close;
		await protocol.start();
		await new Promise<void>((done, reject) => {
			http.once("error", reject);
			http.listen(options.port ?? 3001, options.host ?? "127.0.0.1", () => {
				http.off("error", reject);
				done();
			});
		});
		const address = http.address();
		if (!address || typeof address === "string") throw new Error("Missing HTTP address");
		return {
			serverId,
			port: address.port,
			close,
			get connectionCount() {
				return connectionCount;
			},
		};
	} catch (error) {
		const errors: unknown[] = [error];
		if (shutdown) {
			try {
				await shutdown();
			} catch (cleanupError) {
				errors.push(cleanupError);
			}
		} else
			for (const cleanup of earlyCleanups.reverse()) {
				try {
					await cleanup();
				} catch (cleanupError) {
					errors.push(cleanupError);
				}
			}
		if (errors.length > 1) throw new AggregateError(errors, "Server startup and cleanup failed");
		throw error;
	}
}
