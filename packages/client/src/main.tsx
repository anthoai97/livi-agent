import { createRemoteServiceBinding, type RemoteServiceBinding } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Client, createClientServiceTransport } from "@earendil-works/pi-client";
import {
  AgentController, SessionDirectory, SessionManagement, Transcript,
  type SessionSummary, type TranscriptState,
} from "@livi/decorator-agent/contracts";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import Markdown from "react-markdown";
import { createWebSocketTransport } from "./transport";
import "./style.css";

const selectionKey = "livi.selectedSessionId";
interface Connection { client: Client; management: SessionManagement }

function App() {
  const [connection, setConnection] = useState<Connection>();
  const [status, setStatus] = useState("Connecting");
  const [attempt, setAttempt] = useState(0);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(() => {
    try { return localStorage.getItem(selectionKey); } catch { return null; }
  });
  const [transcript, setTranscript] = useState<TranscriptState>();
  const [controller, setController] = useState<AgentController>();
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
    } catch { /* Chat remains usable when browser storage is disabled. */ }
  }, [selected]);

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
      if (typeof bootstrap !== "object" || bootstrap === null ||
        !("serverId" in bootstrap) || typeof bootstrap.serverId !== "string" ||
        !("wsPath" in bootstrap) || typeof bootstrap.wsPath !== "string") {
        throw new Error("Invalid server bootstrap configuration");
      }
      if (disposed) return;
      const url = new URL(bootstrap.wsPath, window.location.href);
      url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      client = new Client({ serverId: bootstrap.serverId, transportFactory: createWebSocketTransport(url.href) });
      client.onConnectionStateChange((change) => {
        if (change.state === "disconnected") retry(change.error?.message ?? "Connection lost. Sent messages will not be resent.");
      });
      await client.connect();
      if (disposed) return;
      binding = createRemoteServiceBinding({
        services: [SessionDirectory, SessionManagement],
        transport: createClientServiceTransport(client, () => ({ serverId: client!.serverId })),
        onError: (failure) => retry(failure.message),
      });
      const directory = binding.use(SessionDirectory);
      const management = binding.use(SessionManagement);
      directory.state.subscribe((value) => {
        if (!disposed) setSessions(value.sessions);
      });
      await binding.ready(context);
      if (disposed) return;
      const available = directory.state.value?.sessions ?? [];
      setSessions(available);
      setSelected((previous) => available.some((session) => session.sessionId === previous) ? previous : null);
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
    setAttaching(Boolean(connection && selected));
    if (!connection || !selected) return;
    void (async () => {
      attachmentQueue.current = attachmentQueue.current.catch(() => {}).then(async () => {
        if (!disposed) await connection.management.attach(selected, context);
      });
      await attachmentQueue.current;
      if (disposed) return;
      // Capture this attachment generation, so delayed requests cannot target another chat.
      const target = connection.client.attachment;
      if (!target || target.sessionId !== selected) throw new Error("Session attachment was replaced");
      binding = createRemoteServiceBinding({
        services: [AgentController, Transcript],
        transport: createClientServiceTransport(connection.client, () => target),
        onError: (failure) => { if (!disposed) setError(failure.message); },
      });
      const agent = binding.use(AgentController);
      const source = binding.use(Transcript);
      source.state.subscribe((value) => { if (!disposed) setTranscript(value); });
      await binding.ready(context);
      if (disposed) return;
      setTranscript(source.state.value);
      setController(agent);
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

  useEffect(() => { bottom.current?.scrollIntoView({ block: "end" }); }, [transcript]);

  const snapshot = transcript?.snapshot;
  const operation = snapshot?.operation;
  const messages = snapshot?.transcript.flatMap((entry) => entry.type === "message" ? [{ id: entry.id, message: entry.message }] : []) ?? [];
  if (operation?.streamingMessage) messages.push({ id: `stream-${operation.id}`, message: operation.streamingMessage });

  async function newChat() {
    if (!connection || busy) return;
    setBusy(true);
    setError("");
    try {
      const session = await connection.management.create({}, context);
      setSelected(session.sessionId);
      setDraft("");
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  }

  async function send() {
    if (!controller || !draft.trim() || operation || busy) return;
    setBusy(true);
    setError("");
    const message = draft.trim();
    try {
      const result = await controller.prompt({ message }, context);
      if (result.accepted) setDraft("");
      else setError(result.error.message);
    } catch (failure) {
      setError(`${failure instanceof Error ? failure.message : String(failure)}. Delivery is uncertain; this message will not be resent automatically.`);
    } finally { setBusy(false); }
  }

  async function stop() {
    if (!controller || !operation || busy) return;
    setBusy(true);
    try { await controller.requestAbort(operation.id, context); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  }

  return <div className="app">
    <aside>
      <a className="brand" href="/">livi<span>Room decoration assistant</span></a>
      <button className="new-chat" disabled={!connection || busy || attaching} onClick={() => void newChat()}>+ New chat</button>
      <h2>Your conversations</h2>
      <nav aria-label="Conversations">
        {sessions.map((session, index) => <button key={session.sessionId}
          className={session.sessionId === selected ? "session selected" : "session"}
          aria-current={session.sessionId === selected ? "page" : undefined}
          disabled={!connection || busy || attaching}
          onClick={() => { setSelected(session.sessionId); setDraft(""); setError(""); }}>
          <span>Chat {index + 1}</span><small>{new Date(session.createdAt).toLocaleString()}</small>
        </button>)}
        {!sessions.length && <p className="muted">Your chats will appear here.</p>}
      </nav>
      <p className="connection" role="status"><i className={connection ? "online" : ""} />{status}</p>
    </aside>
    <main>
      <header><span>Make room for something new</span><span className="muted">Livi</span></header>
      <section className="transcript" aria-label="Chat transcript" aria-busy={Boolean(operation)}>
        {!messages.length && <div className="welcome"><span className="eyebrow">A space that feels like you</span>
          <h1>Let’s rethink your room.</h1><p>Tell me about your space, your style, and what you’d like to change.</p>
          {!selected && <button disabled={!connection || busy} onClick={() => void newChat()}>Start a conversation</button>}
        </div>}
        {messages.map(({ id, message }) => {
          const content = "content" in message ? message.content : undefined;
          const text = typeof content === "string" ? content : Array.isArray(content)
            ? content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n") : "";
          if (!text) return null;
          return <article key={id} className={`message ${message.role}`}><h2>{message.role === "user" ? "You" : message.role === "assistant" ? "Livi" : "Tool"}</h2>
            <Markdown skipHtml>{text}</Markdown>
          </article>;
        })}
        {operation && <p className="activity" role="status">{operation.status === "aborting" ? "Stopping…" : "Livi is thinking…"}</p>}
        {snapshot?.lastResult?.status === "failed" && <p className="error" role="alert">{snapshot.lastResult.error?.message ?? "The response failed. Please try again."}</p>}
        <div ref={bottom} />
      </section>
      <footer>
        {error && <p className="error" role="alert">{error}</p>}
        <form onSubmit={(event) => { event.preventDefault(); void send(); }}>
          <textarea aria-label="Message" placeholder={selected ? "Describe your room or ask a question…" : "Start a conversation to send a message"}
            rows={3} value={draft} disabled={!controller || busy}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} />
          <div className="composer-actions"><small>Enter to send · Shift + Enter for a new line</small>
            {operation ? <button type="button" disabled={!controller || busy} onClick={() => void stop()}>Stop</button>
              : <button type="submit" disabled={!controller || !draft.trim() || busy}>Send</button>}
          </div>
        </form>
      </footer>
    </main>
  </div>;
}

createRoot(document.getElementById("root")!).render(<App />);
