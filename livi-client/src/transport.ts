import type { ByteTransportFactory } from "@earendil-works/pi-client";

export function createWebSocketTransport(url: string): ByteTransportFactory {
	return (handlers) =>
		new Promise((resolve, reject) => {
			const socket = new WebSocket(url);
			socket.binaryType = "arraybuffer";
			let terminated = false;
			const timeout = window.setTimeout(() => fail(new Error("WebSocket connection timed out")), 10_000);
			const fail = (error: Error) => {
				if (terminated) return;
				terminated = true;
				window.clearTimeout(timeout);
				reject(error);
				handlers.onError(error);
				socket.close();
			};
			socket.onopen = () => {
				window.clearTimeout(timeout);
				resolve({
					async send(bytes) {
						if (socket.readyState !== WebSocket.OPEN) throw new Error("WebSocket disconnected");
						socket.send(new Uint8Array(bytes));
						while (socket.bufferedAmount > 1_048_576) {
							await new Promise((done) => window.setTimeout(done, 10));
							if (socket.readyState !== WebSocket.OPEN) throw new Error("WebSocket disconnected");
						}
					},
					close: () => socket.close(),
				});
			};
			socket.onmessage = (event: MessageEvent<unknown>) => {
				if (!(event.data instanceof ArrayBuffer)) {
					fail(new Error("Expected binary PI protocol frame"));
					return;
				}
				handlers.onData(new Uint8Array(event.data));
			};
			socket.onerror = () => fail(new Error("Unable to connect to the chat server"));
			socket.onclose = () => {
				if (terminated) return;
				terminated = true;
				window.clearTimeout(timeout);
				reject(new Error("WebSocket closed before connecting"));
				handlers.onClose();
			};
		});
}
