import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import type { Models } from "@earendil-works/pi-ai";
import { Server, type ServerHost, SessionNotFoundError } from "@earendil-works/pi-server";
import { createNodeSqliteFactory, SqliteSessionRepo } from "@earendil-works/pi-session-backend-sqlite-node";
import { createServerServices, DecoratorSession, StudioBroker } from "@livi/decorator-agent";
import { WebSocket, WebSocketServer } from "ws";

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
}

export async function startLiviServer(options: LiviServerOptions = {}) {
	const studioOrigins = new Set(
		(options.studioAllowedOrigins ?? []).map((origin) => {
			const parsed = new URL(origin);
			if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== origin)
				throw new Error(`Expected an exact HTTP(S) Studio origin: ${origin}`);
			return origin;
		}),
	);
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
	const repo = new SqliteSessionRepo({
		directory: resolve(dataDirectory, "sessions"),
		databaseFactory: createNodeSqliteFactory(),
	});
	const reportError = options.onError ?? ((error: Error) => console.error(error));
	const studio = new StudioBroker();
	const services = await createServerServices({
		studio,
		list: async () =>
			(await repo.list(undefined, context)).map(({ id, createdAt }) => ({ serverId, sessionId: id, createdAt })),
		create: async () => {
			const session = await repo.create({}, context);
			try {
				return { serverId, sessionId: session.metadata.id, createdAt: session.metadata.createdAt };
			} finally {
				await session.close(context);
			}
		},
	});
	const host: ServerHost<Awaited<ReturnType<SqliteSessionRepo["list"]>>[number]> = {
		serverServices: services.host,
		async resolveSession(sessionId) {
			const metadata = (await repo.list(undefined, context)).find((item) => item.id === sessionId);
			if (!metadata) throw new SessionNotFoundError(`Unknown conversation: ${sessionId}`);
			return metadata;
		},
		async openSession(metadata) {
			const session = await repo.open(metadata, context);
			try {
				return await DecoratorSession.create({
					session,
					models: options.models,
					modelId: options.modelId,
					apiKey: options.apiKey,
					onError: reportError,
					studio,
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
		if (request.url !== "/ws") {
			socket.destroy();
			return;
		}
		// Same-origin chat and explicitly configured Studio origins only.
		const origin = request.headers.origin;
		if (origin) {
			try {
				if (new URL(origin).host !== request.headers.host && !studioOrigins.has(origin)) {
					socket.destroy();
					return;
				}
			} catch {
				socket.destroy();
				return;
			}
		}
		sockets.handleUpgrade(request, socket, head, (websocket) => {
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
				() => repo.close(context),
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
	await protocol.start();
	try {
		await new Promise<void>((done, reject) => {
			http.once("error", reject);
			http.listen(options.port ?? 3001, options.host ?? "127.0.0.1", () => {
				http.off("error", reject);
				done();
			});
		});
	} catch (error) {
		try {
			await close();
		} catch (cleanupError) {
			throw new AggregateError([error, cleanupError], "Server startup and cleanup failed");
		}
		throw error;
	}
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
}
