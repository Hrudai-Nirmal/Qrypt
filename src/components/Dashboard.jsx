function initials(name, username) {
  const source = String(name || username || "?").trim();
  if (!source) {
    return "?";
  }
  const words = source.split(/\s+/).slice(0, 2);
  return words.map((part) => part[0]?.toUpperCase() || "").join("") || "?";
}

function Avatar({ person, className = "" }) {
  const avatarClass = ["avatar", className].filter(Boolean).join(" ");
  if (person?.profilePicture) {
    return <img className={avatarClass} src={person.profilePicture} alt={`${person.displayName} profile`} />;
  }

  return <span className={avatarClass}>{initials(person?.displayName, person?.username)}</span>;
}

function SearchActions({ person, onOpenChat, onSendFriendRequest, onAcceptFriendRequest }) {
  if (person.relationship === "friend") {
    return (
      <button type="button" className="ghost compact-action" onClick={() => onOpenChat(person.username)}>
        Chat
      </button>
    );
  }

  if (person.relationship === "incoming_pending") {
    return (
      <button type="button" className="compact-action" onClick={() => onAcceptFriendRequest(person.username)}>
        Accept
      </button>
    );
  }

  if (person.relationship === "outgoing_pending") {
    return (
      <button type="button" className="compact-action" disabled>
        Requested
      </button>
    );
  }

  return (
    <button type="button" className="compact-action" onClick={() => onSendFriendRequest(person.username)}>
      Request
    </button>
  );
}

function Dashboard({
  chats,
  activeChatId,
  isSearchMode,
  searchQuery,
  searchResults,
  onExitSearchMode,
  onSendFriendRequest,
  onAcceptFriendRequest,
  onOpenChat,
}) {
  return (
    <aside className="dashboard">
      <section className="panel dashboard-panel">
        {isSearchMode ? (
          <>
            <div className="panel-header search-mode-header">
              <button type="button" className="ghost compact-action" onClick={onExitSearchMode}>
                Back
              </button>
              <h3>Search results</h3>
            </div>
            <div className="search-results">
              {searchQuery.trim().length === 0 ? (
                <p className="empty-hint">Type a username in the header search bar.</p>
              ) : searchResults.length === 0 ? (
                <p className="empty-hint">No matching users found.</p>
              ) : (
                searchResults.map((person) => (
                  <div className="person-row compact" key={person.username}>
                    <div className="person-main">
                      <Avatar person={person} />
                      <div>
                        <p className="person-name">{person.displayName}</p>
                        <p className="muted">@{person.username}</p>
                      </div>
                    </div>
                    <SearchActions
                      person={person}
                      onOpenChat={onOpenChat}
                      onSendFriendRequest={onSendFriendRequest}
                      onAcceptFriendRequest={onAcceptFriendRequest}
                    />
                  </div>
                ))
              )}
            </div>
          </>
        ) : (
          <>
            <div className="panel-header">
              <h3>Recent chats</h3>
            </div>
            <div className="chat-list compact-list">
              {chats.length === 0 ? (
                <p className="empty-hint">No chats yet. Use search to find users.</p>
              ) : (
                chats.map((chat) => (
                  <button
                    type="button"
                    key={chat.chatId}
                    onClick={() => onOpenChat(chat.peer.username)}
                    className={`chat-list-item compact ${activeChatId === chat.chatId ? "active" : ""}`}
                  >
                    <Avatar person={chat.peer} />
                    <p className="person-name">{chat.peer.displayName}</p>
                  </button>
                ))
              )}
            </div>
          </>
        )}
      </section>
    </aside>
  );
}

export default Dashboard;
