import { createRemoteServiceBinding, type RemoteServiceBinding } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Client, createClientServiceTransport } from "@earendil-works/pi-client";
import {
	AgentController,
	SessionDirectory,
	SessionManagement,
	type SessionSummary,
	StudioDirectory,
	StudioSession,
	type StudioSessionState,
	type StudioSummary,
	Transcript,
	type TranscriptState,
} from "@livi/decorator-agent/contracts";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import Markdown from "react-markdown";
import { createWebSocketTransport } from "./transport";
import "./style.css";

const selectionKey = "livi.selectedSessionId";
interface Connection {
	client: Client;
	management: SessionManagement;
}

function App() {
	const [connection, setConnection] = useState<Connection>();
	const [status, setStatus] = useState("Connecting");
	const [attempt, setAttempt] = useState(0);
	const [sessions, setSessions] = useState<SessionSummary[]>([]);
	const [selected, setSelected] = useState<string | null>(() => {
		try {
			return localStorage.getItem(selectionKey);
		} catch {
			return null;
		}
	});
	const [transcript, setTranscript] = useState<TranscriptState>();
	const [controller, setController] = useState<AgentController>();
	const [studios, setStudios] = useState<StudioSummary[]>([]);
	const [studio, setStudio] = useState<StudioSession>();
	const [studioState, setStudioState] = useState<StudioSessionState>();
	const [studioChoice, setStudioChoice] = useState("");
	const [studioChanging, setStudioChanging] = useState(false);
	const [draft, setDraft] = useState("");
	const [busy, setBusy] = useState(false);
	const [attaching, setAttaching] = useState(false);
	const [error, setError] = useState("");
	const bottom = useRef<HTMLDivElement>(null);
	const attachmentQueue = useRef(Promise.resolve());

	useEffect(() => {
		try {
			if (selected) localStorage.setItem(selectionKey, selected);
			else localStorage.removeItem(selectionKey);
		} catch {
			/* Chat remains usable when browser storage is disabled. */
		}
	}, [selected]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: The retry counter deliberately restarts this connection.
	useEffect(() => {
		let disposed = false;
		let client: Client | undefined;
		let binding: RemoteServiceBinding | undefined;
		let timer: number | undefined;
		const abort = new AbortController();
		const retry = (reason: string) => {
			if (disposed || timer !== undefined) return;
			setConnection(undefined);
			setStatus("Disconnected · retrying");
			setError(reason);
			timer = window.setTimeout(() => setAttempt((value) => value + 1), 2000);
		};
		void (async () => {
			setStatus("Connecting");
			const response = await fetch("/api/bootstrap", { signal: abort.signal });
			if (!response.ok) throw new Error(`Server bootstrap failed (${response.status})`);
			const bootstrap: unknown = await response.json();
			if (
				typeof bootstrap !== "object" ||
				bootstrap === null ||
				!("serverId" in bootstrap) ||
				typeof bootstrap.serverId !== "string" ||
				!("wsPath" in bootstrap) ||
				typeof bootstrap.wsPath !== "string"
			) {
				throw new Error("Invalid server bootstrap configuration");
			}
			if (disposed) return;
			const url = new URL(bootstrap.wsPath, window.location.href);
			url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
			client = new Client({ serverId: bootstrap.serverId, transportFactory: createWebSocketTransport(url.href) });
			client.onConnectionStateChange((change) => {
				if (change.state === "disconnected")
					retry(change.error?.message ?? "Connection lost. Sent messages will not be resent.");
			});
			await client.connect();
			if (disposed) return;
			binding = createRemoteServiceBinding({
				services: [SessionDirectory, SessionManagement, StudioDirectory],
				transport: createClientServiceTransport(client, () => ({ serverId: client!.serverId })),
				onError: (failure) => retry(failure.message),
			});
			const directory = binding.use(SessionDirectory);
			const management = binding.use(SessionManagement);
			const studioDirectory = binding.use(StudioDirectory);
			studioDirectory.state.subscribe((value) => {
				if (!disposed) setStudios(value.studios);
			});
			directory.state.subscribe((value) => {
				if (!disposed) setSessions(value.sessions);
			});
			await binding.ready(context);
			if (disposed) return;
			const available = directory.state.value?.sessions ?? [];
			setSessions(available);
			setStudios(studioDirectory.state.value?.studios ?? []);
			setSelected((previous) => (available.some((session) => session.sessionId === previous) ? previous : null));
			setConnection({ client, management });
			setStatus("Connected");
			setError("");
		})().catch((failure: unknown) => retry(failure instanceof Error ? failure.message : String(failure)));
		return () => {
			disposed = true;
			abort.abort();
			window.clearTimeout(timer);
			void client?.dispose();
			void binding?.dispose(context).catch(() => {});
		};
	}, [attempt]);

	useEffect(() => {
		let disposed = false;
		let binding: RemoteServiceBinding | undefined;
		setController(undefined);
		setTranscript(undefined);
		setStudio(undefined);
		setStudioState(undefined);
		setStudioChoice("");
		setAttaching(Boolean(connection && selected));
		if (!connection || !selected) return;
		void (async () => {
			attachmentQueue.current = attachmentQueue.current
				.catch(() => {})
				.then(async () => {
					if (!disposed) await connection.management.attach(selected, context);
				});
			await attachmentQueue.current;
			if (disposed) return;
			// Capture this attachment generation, so delayed requests cannot target another chat.
			const target = connection.client.attachment;
			if (!target || target.sessionId !== selected) throw new Error("Session attachment was replaced");
			binding = createRemoteServiceBinding({
				services: [AgentController, Transcript, StudioSession],
				transport: createClientServiceTransport(connection.client, () => target),
				onError: (failure) => {
					if (!disposed) setError(failure.message);
				},
			});
			const agent = binding.use(AgentController);
			const source = binding.use(Transcript);
			const studioService = binding.use(StudioSession);
			studioService.state.subscribe((value) => {
				if (!disposed) setStudioState(value);
			});
			source.state.subscribe((value) => {
				if (!disposed) setTranscript(value);
			});
			await binding.ready(context);
			if (disposed) return;
			setTranscript(source.state.value);
			setController(agent);
			setStudio(studioService);
			setStudioState(studioService.state.value);
			setAttaching(false);
		})().catch((failure: unknown) => {
			if (!disposed) {
				setAttaching(false);
				setError(failure instanceof Error ? failure.message : String(failure));
			}
		});
		return () => {
			disposed = true;
			void binding?.dispose(context).catch(() => {});
		};
	}, [connection, selected]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: Scroll when the transcript changes.
	useEffect(() => {
		bottom.current?.scrollIntoView({ block: "end" });
	}, [transcript]);

	const snapshot = transcript?.snapshot;
	const operation = snapshot?.operation;
	const messages =
		snapshot?.transcript.flatMap((entry) =>
			entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant")
				? [{ id: entry.id, message: entry.message }]
				: [],
		) ?? [];
	if (operation?.streamingMessage)
		messages.push({ id: `stream-${operation.id}`, message: operation.streamingMessage });

	async function newChat() {
		if (!connection || busy) return;
		setBusy(true);
		setError("");
		try {
			const session = await connection.management.create({}, context);
			setSelected(session.sessionId);
			setDraft("");
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : String(failure));
		} finally {
			setBusy(false);
		}
	}

	async function send() {
		if (!controller || !draft.trim() || operation || busy || studioChanging) return;
		setBusy(true);
		setError("");
		const message = draft.trim();
		try {
			const result = await controller.prompt({ message }, context);
			if (result.accepted) setDraft("");
			else setError(result.error.message);
		} catch (failure) {
			setError(
				`${failure instanceof Error ? failure.message : String(failure)}. Delivery is uncertain; this message will not be resent automatically.`,
			);
		} finally {
			setBusy(false);
		}
	}

	async function stop() {
		if (!controller || !operation || busy) return;
		setBusy(true);
		try {
			await controller.requestAbort(operation.id, context);
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : String(failure));
		} finally {
			setBusy(false);
		}
	}

	async function changeStudio(detach = false) {
		if (!studio || studioChanging || studioState?.busy || operation) return;
		const target = studios.find((item) => JSON.stringify([item.designId, item.tabId]) === studioChoice);
		if (!detach && (!target || target.phase !== "ready")) return;
		setStudioChanging(true);
		setError("");
		try {
			await studio.bind(detach ? null : { designId: target!.designId, tabId: target!.tabId }, context);
			setStudioChoice("");
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : String(failure));
		} finally {
			setStudioChanging(false);
		}
	}

	const bindingLocked = !studio || studioChanging || Boolean(studioState?.busy || operation);
	const attachedStudio = studios.find(
		(item) => item.designId === studioState?.binding?.designId && item.tabId === studioState.binding.tabId,
	);
	const selectedObjects =
		studioState?.snapshot?.objects.filter((object) => studioState.snapshot?.selectedObjectIds.includes(object.id)) ??
		[];

	return (
		<div className="app">
			<aside>
				<a className="brand" href="/">
					livi<span>Room decoration assistant</span>
				</a>
				<button
					type="button"
					className="new-chat"
					disabled={!connection || busy || attaching}
					onClick={() => void newChat()}
				>
					+ New chat
				</button>
				<h2>Your conversations</h2>
				<nav aria-label="Conversations">
					{sessions.map((session, index) => (
						<button
							type="button"
							key={session.sessionId}
							className={session.sessionId === selected ? "session selected" : "session"}
							aria-current={session.sessionId === selected ? "page" : undefined}
							disabled={!connection || busy || attaching}
							onClick={() => {
								setSelected(session.sessionId);
								setDraft("");
								setError("");
							}}
						>
							<span>Chat {index + 1}</span>
							<small>{new Date(session.createdAt).toLocaleString()}</small>
						</button>
					))}
					{!sessions.length && <p className="muted">Your chats will appear here.</p>}
				</nav>
				<output className="connection">
					<i className={connection ? "online" : ""} />
					{status}
				</output>
			</aside>
			<main>
				<header>
					<span>Make room for something new</span>
					<span className="muted">Livi</span>
				</header>
				<section className="studio-panel" aria-label="Studio attachment">
					<div className="studio-heading">
						<strong>
							{studioState?.binding
								? (attachedStudio?.label ?? studioState.binding.designId)
								: "No design attached"}
						</strong>
						<output className="studio-phase" aria-live="polite">
							{!connection
								? "Offline"
								: !studioState
									? "Select a conversation"
									: studioState.phase === "ready"
										? "Ready"
										: studioState.phase === "reconciling"
											? "Reconciling"
											: "Offline"}
						</output>
					</div>
					{studioState?.binding && <p className="muted">Design {studioState.binding.designId}</p>}
					<div className="studio-controls">
						<label htmlFor="studio-choice">Connected Studios</label>
						<select
							id="studio-choice"
							value={studioChoice}
							disabled={bindingLocked}
							onChange={(event) => setStudioChoice(event.target.value)}
						>
							<option value="">Choose a Studio…</option>
							{studios.map((item) => (
								<option
									key={JSON.stringify([item.designId, item.tabId])}
									value={JSON.stringify([item.designId, item.tabId])}
									disabled={item.phase !== "ready"}
								>
									{item.label} · {item.designId} · {item.phase}
								</option>
							))}
						</select>
						<button type="button" disabled={bindingLocked || !studioChoice} onClick={() => void changeStudio()}>
							{studioState?.binding ? "Change design" : "Attach design"}
						</button>
						{studioState?.binding && (
							<button type="button" disabled={bindingLocked} onClick={() => void changeStudio(true)}>
								Disconnect design
							</button>
						)}
					</div>
					<p className="studio-hint">
						{studioState?.busy
							? "Waiting for a room action result. Chat is available."
							: !studioState?.binding
								? "General chat is available. Attach a ready Studio for room actions."
								: !connection || studioState.phase === "offline"
									? "Studio is offline. Chat remains available; room actions need a connection."
									: studioState.phase === "reconciling"
										? "Reading the saved room and checking previous results…"
										: selectedObjects.length
											? `Selected: ${selectedObjects.map((object) => `${object.name} (${object.id})`).join(", ")}`
											: "Name an object in your message, like ‘move the sofa 0.5 metres right’. Selection is optional."}
					</p>
				</section>
				<section className="transcript" aria-label="Chat transcript" aria-busy={Boolean(operation)}>
					{!messages.length && (
						<div className="welcome">
							<span className="eyebrow">A space that feels like you</span>
							<h1>Let’s rethink your room.</h1>
							<p>Tell me about your space, your style, and what you’d like to change.</p>
							{!selected && (
								<button type="button" disabled={!connection || busy} onClick={() => void newChat()}>
									Start a conversation
								</button>
							)}
						</div>
					)}
					{messages.map(({ id, message }) => {
						const content = "content" in message ? message.content : undefined;
						const text =
							typeof content === "string"
								? content
								: Array.isArray(content)
									? content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
									: "";
						if (!text) return null;
						return (
							<article key={id} className={`message ${message.role}`}>
								<h2>{message.role === "user" ? "You" : "Livi"}</h2>
								<Markdown skipHtml>{text}</Markdown>
							</article>
						);
					})}
					{operation && (
						<output className="activity">
							{operation.status === "aborting" ? "Stopping…" : "Livi is thinking…"}
						</output>
					)}
					{Boolean(studioState?.actions.length) && (
						<section className="studio-actions" aria-label="Room actions" aria-live="polite">
							<h2>Room actions</h2>
							{studioState?.actions.map((action) => {
								const status =
									action.state === "committed"
										? "Saved"
										: action.state === "rejected"
											? "Rejected"
											: action.state === "cancelled_before_send"
												? "Cancelled before sending"
												: action.state === "prepared"
													? "Saving…"
													: "Unconfirmed";
								return (
									<article className={`studio-action ${action.state}`} key={action.commandId}>
										<strong>
											{action.action === "move" ? "Move" : action.action === "rotate" ? "Rotate" : "Remove"}{" "}
											· {action.objectId}
										</strong>
										<span>{status}</span>
										{action.message && action.message !== status && <p>{action.message}</p>}
									</article>
								);
							})}
						</section>
					)}
					{snapshot?.lastResult?.status === "failed" && (
						<p className="error" role="alert">
							{snapshot.lastResult.error?.message ?? "The response failed. Please try again."}
						</p>
					)}
					<div ref={bottom} />
				</section>
				<footer>
					{error && (
						<p className="error" role="alert">
							{error}
						</p>
					)}
					<form
						onSubmit={(event) => {
							event.preventDefault();
							void send();
						}}
					>
						<textarea
							aria-label="Message"
							placeholder={
								selected ? "Describe your room or ask a question…" : "Start a conversation to send a message"
							}
							rows={3}
							value={draft}
							disabled={!controller || busy}
							onChange={(event) => setDraft(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
									event.preventDefault();
									void send();
								}
							}}
						/>
						<div className="composer-actions">
							<small>Enter to send · Shift + Enter for a new line</small>
							{operation ? (
								<button type="button" disabled={!controller || busy} onClick={() => void stop()}>
									Stop
								</button>
							) : (
								<button type="submit" disabled={!controller || !draft.trim() || busy || studioChanging}>
									Send
								</button>
							)}
						</div>
					</form>
				</footer>
			</main>
		</div>
	);
}

createRoot(document.getElementById("root")!).render(<App />);
