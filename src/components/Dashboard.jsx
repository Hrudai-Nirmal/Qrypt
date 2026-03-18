function Dashboard({
  user,
  chats,
  activeChatId,
  searchQuery,
  onSearchQueryChange,
  onSearch,
  onSearchFriends,
  searchResults,
  friendRequests,
  onSendFriendRequest,
  onAcceptFriendRequest,
  onOpenChat,
  onLogout,
}) {
  function renderPresence(person) {
    const online = Boolean(person?.presence?.online);
    const lastSeen = person?.presence?.lastSeen;
    if (online) {
      return <span className="presence-text online">Online</span>;
    }

    if (lastSeen) {
      return (
        <span className="presence-text offline">
          Last seen {new Date(lastSeen).toLocaleTimeString()}
        </span>
      );
    }

    return <span className="presence-text offline">Offline</span>;
  }

  return (
    <aside className="dashboard">
      <div className="user-card">
        <div>
          <p className="eyebrow">Signed in as</p>
          <h2>{user.displayName}</h2>
          <p className="muted">@{user.username}</p>
        </div>
        <button type="button" className="ghost" onClick={onLogout}>
          Logout
        </button>
      </div>

      <section className="panel">
        <div className="panel-header">
          <h3>Find people</h3>
        </div>

        <div className="search-row">
          <input
            value={searchQuery}
            onChange={(event) => onSearchQueryChange(event.target.value)}
            placeholder="Search by username"
          />
          <div className="search-actions">
            <button type="button" onClick={onSearch}>
              People
            </button>
            <button type="button" className="ghost" onClick={onSearchFriends}>
              Friends
            </button>
          </div>
        </div>

        <div className="search-results">
          {searchResults.length === 0 ? (
            <p className="empty-hint">Search to add friends and open a chat.</p>
          ) : (
            searchResults.map((person) => (
              <div className="person-row" key={person.username}>
                <div>
                  <p className="person-name">{person.displayName}</p>
                  <p className="muted">@{person.username}</p>
                  {renderPresence(person)}
                </div>
                <div className="person-actions">
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => onOpenChat(person.username)}
                  >
                    Chat
                  </button>
                  {person.relationship === "friend" ? (
                    <button type="button" disabled>
                      Friends
                    </button>
                  ) : person.relationship === "incoming_pending" ? (
                    <button
                      type="button"
                      onClick={() => onAcceptFriendRequest(person.username)}
                    >
                      Accept
                    </button>
                  ) : person.relationship === "outgoing_pending" ? (
                    <button type="button" disabled>
                      Requested
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => onSendFriendRequest(person.username)}
                    >
                      Request
                    </button>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h3>Friend requests</h3>
        </div>

        <div className="search-results">
          {(friendRequests?.incoming || []).length === 0 ? (
            <p className="empty-hint">No pending requests.</p>
          ) : (
            friendRequests.incoming.map((person) => (
              <div className="person-row" key={person.username}>
                <div>
                  <p className="person-name">{person.displayName}</p>
                  <p className="muted">@{person.username}</p>
                  {renderPresence(person)}
                </div>
                <div className="person-actions">
                  <button
                    type="button"
                    onClick={() => onAcceptFriendRequest(person.username)}
                  >
                    Accept
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h3>Recent chats</h3>
        </div>

        <div className="chat-list">
          {chats.length === 0 ? (
            <p className="empty-hint">No chats yet. Start one from search.</p>
          ) : (
            chats.map((chat) => (
              <button
                type="button"
                key={chat.chatId}
                onClick={() => onOpenChat(chat.peer.username)}
                className={`chat-list-item ${activeChatId === chat.chatId ? "active" : ""}`}
              >
                <div className="chat-title-row">
                  <p className="person-name">{chat.peer.displayName}</p>
                  {renderPresence(chat.peer)}
                </div>
                <p className="muted">
                  {chat.lastMessage
                    ? `${chat.lastMessage.sender}: ${chat.lastMessage.body}`
                    : "No messages yet"}
                </p>
              </button>
            ))
          )}
        </div>
      </section>
    </aside>
  );
}

export default Dashboard;
