import { useState } from "react";

function Chat({
  activeChat,
  currentUser,
  messages,
  connectionState,
  onSendMessage,
  onRotateKey,
}) {
  const [draft, setDraft] = useState("");

  if (!activeChat) {
    return (
      <section className="chat-shell empty">
        <h2>Select a chat</h2>
        <p>Open or create a conversation from the dashboard.</p>
      </section>
    );
  }

  const quantumReady = activeChat.quantum?.status === "ready";
  const peerOnline = Boolean(activeChat.peer?.presence?.online);
  const peerLastSeen = activeChat.peer?.presence?.lastSeen;
  const presenceLabel = peerOnline
    ? "Online"
    : peerLastSeen
      ? `Last seen ${new Date(peerLastSeen).toLocaleTimeString()}`
      : "Offline";

  async function handleSubmit(event) {
    event.preventDefault();
    const value = draft.trim();
    if (!value) {
      return;
    }

    await onSendMessage(value);
    setDraft("");
  }

  return (
    <section className="chat-shell">
      <header className="chat-header">
        <div>
          <h2>{activeChat.peer.displayName}</h2>
          <p className="muted">
            @{activeChat.peer.username} ·{" "}
            <span className={`presence-text ${peerOnline ? "online" : "offline"}`}>
              {presenceLabel}
            </span>
          </p>
        </div>

        <div className="chat-header-right">
          <span className={`quantum-pill ${quantumReady ? "ready" : "missing"}`}>
            {quantumReady
              ? `BB84 key: ${activeChat.quantum.preview}...`
              : "No quantum key"}
          </span>
          <button type="button" onClick={() => onRotateKey(activeChat.chatId)}>
            Regenerate key
          </button>
        </div>
      </header>

      <div className="message-list">
        {messages.length === 0 ? (
          <p className="empty-hint">No messages yet. Say hello.</p>
        ) : (
          messages.map((message) => (
            <article
              key={message.messageId}
              className={`message-bubble ${
                message.sender === currentUser.username ? "mine" : "theirs"
              }`}
            >
              <p>{message.body}</p>
              <time>{new Date(message.sentAt).toLocaleTimeString()}</time>
            </article>
          ))
        )}
      </div>

      <footer className="chat-footer">
        <form onSubmit={handleSubmit} className="message-form">
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Type a message"
          />
          <button type="submit" className="primary">
            Send
          </button>
        </form>
        <p className="muted">Socket: {connectionState}</p>
      </footer>
    </section>
  );
}

export default Chat;
