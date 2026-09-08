import { type ByteTransportFactory, Client } from "../../packages/client/dist/index.js";

/** Node 24's WebSocket keeps the headless consumer on the real PI transport. */
export async function connectClient(server: { serverId: string; port: number }) {
	const transportFactory: ByteTransportFactory = (handlers) =>
		new Promise((resolve, reject) => {
			const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
			socket.binaryType = "arraybuffer";
			const timeout = setTimeout(() => {
				reject(new Error("Smoke WebSocket connection timed out"));
				socket.close();
			}, 10_000);
			socket.onopen = () => {
				clearTimeout(timeout);
				resolve({
					async send(bytes) {
						if (socket.readyState !== WebSocket.OPEN) throw new Error("Smoke WebSocket disconnected");
						socket.send(new Uint8Array(bytes));
					},
					close: () => socket.close(),
				});
			};
			socket.onmessage = (event: MessageEvent<unknown>) => {
				if (event.data instanceof ArrayBuffer) handlers.onData(new Uint8Array(event.data));
				else handlers.onError(new Error("Expected binary PI frame"));
			};
			socket.onerror = () => {
				clearTimeout(timeout);
				const error = new Error("Smoke WebSocket connection failed");
				reject(error);
				handlers.onError(error);
			};
			socket.onclose = () => {
				clearTimeout(timeout);
				reject(new Error("Smoke WebSocket closed before connecting"));
				handlers.onClose();
			};
		});
	return Client.connect({ serverId: server.serverId, transportFactory });
}

export async function eventually(predicate: () => boolean, description: string, timeout = 20_000): Promise<void> {
	const deadline = Date.now() + timeout;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error(`Timed out: ${description}`);
		await new Promise((done) => setTimeout(done, 20));
	}
}
