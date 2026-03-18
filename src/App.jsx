import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Chat from "./components/Chat";
import Dashboard from "./components/Dashboard";
import Login from "./components/Login";
import {
  acceptFriendRequest,
  getChats,
  getMessages,
  login,
  logout,
  me,
  postMessage,
  register,
  searchUsers,
  sendFriendRequest,
  startChatSession,
  updateProfile,
} from "./lib/api";
import { createQryptSocket } from "./lib/socket";
import "./App.css";

const AUTH_STORAGE_KEY = "qrypt_auth";
const THEME_STORAGE_KEY = "qrypt_theme";

function loadThemePreference() {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === "dark" || saved === "light") {
      return saved;
    }
  } catch {
    // Ignore storage errors and fallback to light mode.
  }
  return "light";
}

function loadAuthFromStorage() {
  try {
    const raw = sessionStorage.getItem(AUTH_STORAGE_KEY) || localStorage.getItem(AUTH_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveAuthToStorage(auth) {
  if (!auth) {
    sessionStorage.removeItem(AUTH_STORAGE_KEY);
    localStorage.removeItem(AUTH_STORAGE_KEY);
    return;
  }

  const serialized = JSON.stringify(auth);
  sessionStorage.setItem(AUTH_STORAGE_KEY, serialized);
  localStorage.removeItem(AUTH_STORAGE_KEY);
}

function sortChats(chats) {
  return [...chats].sort((a, b) => {
    const aDate = new Date(a.updatedAt || 0).getTime();
    const bDate = new Date(b.updatedAt || 0).getTime();
    return bDate - aDate;
  });
}

function mergeUniqueMessages(current, incoming) {
  const byId = new Map();

  current.forEach((message) => {
    byId.set(message.messageId, message);
  });

  incoming.forEach((message) => {
    byId.set(message.messageId, message);
  });

  return [...byId.values()].sort(
    (a, b) => new Date(a.sentAt).getTime() - new Date(b.sentAt).getTime(),
  );
}

function initials(name, username) {
  const source = String(name || username || "?").trim();
  if (!source) {
    return "?";
  }
  const parts = source.split(/\s+/).slice(0, 2);
  return parts.map((part) => part[0]?.toUpperCase() || "").join("") || "?";
}

function rankUsersByUsernamePriority(users, query) {
  const value = String(query || "").trim().toLowerCase();
  if (!value) {
    return users;
  }

  function score(user) {
    const username = String(user.username || "").toLowerCase();
    const displayName = String(user.displayName || "").toLowerCase();

    if (username === value) {
      return 0;
    }
    if (username.startsWith(value)) {
      return 1;
    }
    if (username.includes(value)) {
      return 2;
    }
    if (displayName.startsWith(value)) {
      return 3;
    }
    if (displayName.includes(value)) {
      return 4;
    }
    return 5;
  }

  return [...users].sort((a, b) => {
    const diff = score(a) - score(b);
    if (diff !== 0) {
      return diff;
    }
    return String(a.username || "").localeCompare(String(b.username || ""));
  });
}

function App() {
  const [auth, setAuth] = useState(loadAuthFromStorage);
  const [theme, setTheme] = useState(loadThemePreference);
  const [authBusy, setAuthBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [chats, setChats] = useState([]);
  const [activeChatId, setActiveChatId] = useState("");
  const [messagesByChat, setMessagesByChat] = useState({});
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [isSearchMode, setIsSearchMode] = useState(false);
  const [connectionState, setConnectionState] = useState("disconnected");
  const [profileModalOpen, setProfileModalOpen] = useState(false);
  const [profileDraftName, setProfileDraftName] = useState("");
  const [profileDraftImage, setProfileDraftImage] = useState(null);
  const [profileRemoveImage, setProfileRemoveImage] = useState(false);
  const [profileBusy, setProfileBusy] = useState(false);

  const socketRef = useRef(null);
  const messagesRef = useRef({});
  const searchInputRef = useRef(null);

  const applyPresenceUpdate = useCallback((username, online, lastSeen) => {
    if (!username) {
      return;
    }

    const normalized = {
      online: Boolean(online),
      lastSeen: lastSeen || null,
    };

    setChats((current) =>
      current.map((chat) =>
        chat.peer.username === username
          ? {
              ...chat,
              peer: {
                ...chat.peer,
                presence: normalized,
              },
            }
          : chat,
      ),
    );

    setSearchResults((current) =>
      current.map((person) =>
        person.username === username
          ? {
              ...person,
              presence: normalized,
            }
          : person,
      ),
    );
  }, []);

  const upsertChat = useCallback((chat) => {
    setChats((current) => {
      const next = current.filter((item) => item.chatId !== chat.chatId);
      next.push(chat);
      return sortChats(next);
    });
  }, []);

  useEffect(() => {
    if (!auth?.token) {
      setChats([]);
      setActiveChatId("");
      setMessagesByChat({});
      return;
    }

    let cancelled = false;

    async function bootstrap() {
      try {
        const meData = await me(auth.token);
        if (cancelled) {
          return;
        }

        const refreshed = {
          token: auth.token,
          user: meData.user,
        };

        setAuth(refreshed);
        saveAuthToStorage(refreshed);

        const chatsData = await getChats(auth.token);
        if (cancelled) {
          return;
        }

        const chatList = sortChats(chatsData.chats || []);
        setChats(chatList);
        setActiveChatId((current) => current || chatList[0]?.chatId || "");
      } catch (error) {
        if (!cancelled) {
          setErrorMessage(error.message);
          if (error.status === 401) {
            setAuth(null);
            saveAuthToStorage(null);
          }
        }
      }
    }

    bootstrap();

    return () => {
      cancelled = true;
    };
  }, [auth?.token]);

  useEffect(() => {
    if (!auth?.token) {
      return undefined;
    }

    const socket = createQryptSocket(auth.token);
    let presenceInterval = null;
    socketRef.current = socket;
    setConnectionState("connecting");

    socket.on("connect", () => {
      setConnectionState("connected");
      socket.emit("presence_ping");

      if (presenceInterval) {
        clearInterval(presenceInterval);
      }

      presenceInterval = setInterval(() => {
        if (socket.connected) {
          socket.emit("presence_ping");
        }
      }, 25000);
    });

    socket.on("disconnect", () => {
      setConnectionState("disconnected");
      if (presenceInterval) {
        clearInterval(presenceInterval);
        presenceInterval = null;
      }
    });

    socket.on("connect_error", (error) => {
      setConnectionState("error");
      setErrorMessage(error.message || "Socket connection failed");
    });

    socket.on("new_message", ({ message }) => {
      if (!message?.chatId) {
        return;
      }

      setMessagesByChat((current) => ({
        ...current,
        [message.chatId]: mergeUniqueMessages(current[message.chatId] || [], [message]),
      }));
    });

    socket.on("chat_updated", ({ chat }) => {
      if (chat) {
        upsertChat(chat);
      }
    });

    socket.on("quantum_key_updated", ({ chatId, quantum }) => {
      if (!chatId || !quantum) {
        return;
      }

      setChats((current) =>
        current.map((chat) =>
          chat.chatId === chatId
            ? {
                ...chat,
                quantum: {
                  ...chat.quantum,
                  ...quantum,
                  status: "ready",
                },
              }
            : chat,
        ),
      );
    });

    socket.on("presence_updated", ({ username, online, lastSeen }) => {
      applyPresenceUpdate(username, online, lastSeen);
    });

    socket.on("socket_error", (payload) => {
      if (payload?.message) {
        setErrorMessage(payload.message);
      }
    });

    return () => {
      if (presenceInterval) {
        clearInterval(presenceInterval);
      }
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
    };
  }, [auth?.token, upsertChat, applyPresenceUpdate]);

  useEffect(() => {
    if (!auth?.token || !activeChatId) {
      return undefined;
    }

    let cancelled = false;

    async function loadMessages() {
      if (messagesRef.current[activeChatId]) {
        return;
      }

      try {
        const data = await getMessages(auth.token, activeChatId);
        if (cancelled) {
          return;
        }

        setMessagesByChat((current) => ({
          ...current,
          [activeChatId]: mergeUniqueMessages(current[activeChatId] || [], data.messages || []),
        }));
      } catch (error) {
        if (!cancelled) {
          setErrorMessage(error.message);
        }
      }
    }

    loadMessages();

    const socket = socketRef.current;
    if (socket?.connected) {
      socket.emit("join_chat", { chatId: activeChatId });
    }

    return () => {
      cancelled = true;
      if (socket?.connected) {
        socket.emit("leave_chat", { chatId: activeChatId });
      }
    };
  }, [auth?.token, activeChatId, connectionState]);

  useEffect(() => {
    messagesRef.current = messagesByChat;
  }, [messagesByChat]);

  const activeChat = useMemo(
    () => chats.find((chat) => chat.chatId === activeChatId),
    [chats, activeChatId],
  );

  const activeMessages = activeChatId ? messagesByChat[activeChatId] || [] : [];

  useEffect(() => {
    document.body.dataset.theme = theme;
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // Ignore storage write errors.
    }
  }, [theme]);

  useEffect(() => {
    if (!auth?.token || !isSearchMode) {
      return undefined;
    }

    const query = searchQuery.trim();
    if (!query) {
      setSearchResults([]);
      return undefined;
    }

    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const data = await searchUsers(auth.token, query);
        if (!cancelled) {
          setSearchResults(rankUsersByUsernamePriority(data.users || [], query));
        }
      } catch (error) {
        if (!cancelled) {
          setErrorMessage(error.message);
        }
      }
    }, 220);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [auth?.token, isSearchMode, searchQuery]);

  async function handleLogin(payload) {
    setAuthBusy(true);
    setErrorMessage("");

    try {
      const data = await login(payload);
      const nextAuth = { token: data.token, user: data.user };
      setAuth(nextAuth);
      saveAuthToStorage(nextAuth);
    } catch (error) {
      setErrorMessage(error.message);
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleRegister(payload) {
    setAuthBusy(true);
    setErrorMessage("");

    try {
      const data = await register(payload);
      const nextAuth = { token: data.token, user: data.user };
      setAuth(nextAuth);
      saveAuthToStorage(nextAuth);
    } catch (error) {
      setErrorMessage(error.message);
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleLogout() {
    const token = auth?.token;

    try {
      if (token) {
        await logout(token);
      }
    } catch {
      // Ignore logout errors and clear local state anyway.
    }

    setAuth(null);
    saveAuthToStorage(null);
    setChats([]);
    setMessagesByChat({});
    setActiveChatId("");
    setSearchQuery("");
    setSearchResults([]);
    setIsSearchMode(false);
    setErrorMessage("");
    setProfileModalOpen(false);
  }

  async function handleSendFriendRequest(username) {
    if (!auth?.token) {
      return;
    }

    try {
      setErrorMessage("");
      await sendFriendRequest(auth.token, username);
      setSearchResults((current) =>
        current.map((user) =>
          user.username === username
            ? { ...user, isFriend: false, relationship: "outgoing_pending" }
            : user,
        ),
      );
    } catch (error) {
      setErrorMessage(error.message);
    }
  }

  async function handleAcceptFriendRequest(username) {
    if (!auth?.token) {
      return;
    }

    try {
      setErrorMessage("");
      await acceptFriendRequest(auth.token, username);
      setSearchResults((current) =>
        current.map((user) =>
          user.username === username
            ? { ...user, isFriend: true, relationship: "friend" }
            : user,
        ),
      );

      setAuth((current) => {
        if (!current?.user) {
          return current;
        }

        const nextAuth = {
          ...current,
          user: {
            ...current.user,
            friends: Array.from(new Set([...(current.user.friends || []), username])),
          },
        };
        saveAuthToStorage(nextAuth);
        return nextAuth;
      });
    } catch (error) {
      setErrorMessage(error.message);
    }
  }

  async function handleOpenChat(peerUsername) {
    if (!auth?.token) {
      return;
    }

    try {
      setErrorMessage("");
      const data = await startChatSession(auth.token, peerUsername);
      upsertChat(data.chat);
      setActiveChatId(data.chat.chatId);
      setIsSearchMode(false);
      setSearchQuery("");
      setSearchResults([]);
    } catch (error) {
      setErrorMessage(error.message);
    }
  }

  async function handleSendMessage(body) {
    if (!auth?.token || !activeChatId) {
      return;
    }

    const socket = socketRef.current;

    try {
      setErrorMessage("");
      if (socket?.connected) {
        socket.emit("send_message", { chatId: activeChatId, body });
        return;
      }

      const data = await postMessage(auth.token, activeChatId, body);
      setMessagesByChat((current) => ({
        ...current,
        [activeChatId]: mergeUniqueMessages(current[activeChatId] || [], [data.message]),
      }));
    } catch (error) {
      setErrorMessage(error.message);
    }
  }

  function handleToggleTheme() {
    setTheme((current) => (current === "dark" ? "light" : "dark"));
  }

  function handleToggleSearchMode() {
    setIsSearchMode((current) => {
      const next = !current;
      if (next) {
        setTimeout(() => searchInputRef.current?.focus(), 0);
      } else {
        setSearchQuery("");
        setSearchResults([]);
      }
      return next;
    });
  }

  function handleExitSearchMode() {
    setIsSearchMode(false);
    setSearchQuery("");
    setSearchResults([]);
  }

  function handleOpenSettingsPlaceholder() {
    setErrorMessage("Settings page coming soon.");
  }

  function handleOpenProfileModal() {
    if (!auth?.user) {
      return;
    }
    setProfileDraftName(auth.user.displayName || auth.user.username);
    setProfileDraftImage(auth.user.profilePicture || null);
    setProfileRemoveImage(false);
    setProfileModalOpen(true);
    setErrorMessage("");
  }

  function handleCloseProfileModal() {
    if (profileBusy) {
      return;
    }
    setProfileModalOpen(false);
  }

  function handleProfileFileChange(event) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : null;
      if (!result) {
        setErrorMessage("Could not read selected image.");
        return;
      }
      setProfileDraftImage(result);
      setProfileRemoveImage(false);
    };
    reader.onerror = () => {
      setErrorMessage("Could not read selected image.");
    };
    reader.readAsDataURL(file);
  }

  async function handleSaveProfile() {
    if (!auth?.token) {
      return;
    }

    setProfileBusy(true);
    setErrorMessage("");

    try {
      const payload = {
        displayName: profileDraftName.trim(),
      };

      if (profileRemoveImage) {
        payload.removePicture = true;
      } else {
        payload.profilePicture = profileDraftImage || "";
      }

      const data = await updateProfile(auth.token, payload);
      const nextAuth = {
        token: auth.token,
        user: data.user,
      };
      setAuth(nextAuth);
      saveAuthToStorage(nextAuth);
      setChats((current) =>
        current.map((chat) =>
          chat.peer.username === data.user.username
            ? {
                ...chat,
                peer: {
                  ...chat.peer,
                  displayName: data.user.displayName,
                  profilePicture: data.user.profilePicture,
                },
              }
            : chat,
        ),
      );
      setProfileModalOpen(false);
    } catch (error) {
      setErrorMessage(error.message);
    } finally {
      setProfileBusy(false);
    }
  }

  function renderHeaderAvatar() {
    const person = auth?.user;
    if (person?.profilePicture) {
      return (
        <img
          className="header-avatar"
          src={person.profilePicture}
          alt={`${person.displayName} profile`}
        />
      );
    }

    return (
      <span className="header-avatar">{initials(person?.displayName, person?.username)}</span>
    );
  }

  const header = (
    <header className="app-header">
      <div className="header-left">
        <div className={`header-search ${isSearchMode ? "active" : ""}`}>
          <button
            type="button"
            className="icon-button"
            onClick={handleToggleSearchMode}
            aria-label={isSearchMode ? "Close search" : "Open search"}
            title={isSearchMode ? "Close search" : "Search users"}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="2" />
              <line x1="16.5" y1="16.5" x2="21" y2="21" stroke="currentColor" strokeWidth="2" />
            </svg>
          </button>
          <input
            ref={searchInputRef}
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Search usernames"
          />
        </div>

        <button
          type="button"
          className="theme-toggle"
          onClick={handleToggleTheme}
          aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
          title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
        >
          <span className="theme-toggle-track">
            <span className="theme-toggle-thumb" />
          </span>
          <span className="theme-toggle-label">{theme === "dark" ? "Dark" : "Light"}</span>
        </button>
      </div>

      <div className="header-right">
        {auth?.user && (
          <button
            type="button"
            className="profile-button"
            onClick={handleOpenProfileModal}
            title="Profile"
          >
            {renderHeaderAvatar()}
          </button>
        )}

        <button
          type="button"
          className="icon-button"
          onClick={handleOpenSettingsPlaceholder}
          aria-label="Open settings"
          title="Settings"
        >
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" strokeWidth="2" />
            <path
              d="M19.4 14.1a7.8 7.8 0 0 0 0-4.2l2-1.5-1.9-3.2-2.4 1a8 8 0 0 0-3.6-2l-.4-2.5h-3.8l-.4 2.5a8 8 0 0 0-3.6 2l-2.4-1L.6 8.4l2 1.5a7.8 7.8 0 0 0 0 4.2l-2 1.5 1.9 3.2 2.4-1a8 8 0 0 0 3.6 2l.4 2.5h3.8l.4-2.5a8 8 0 0 0 3.6-2l2.4 1 1.9-3.2-2-1.5z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
    </header>
  );

  if (!auth?.token || !auth?.user) {
    return (
      <>
        {header}
        <Login
          onLogin={handleLogin}
          onRegister={handleRegister}
          loading={authBusy}
          errorMessage={errorMessage}
        />
      </>
    );
  }

  return (
    <>
      {header}

      <main className="app-shell">
        <Dashboard
          chats={chats}
          activeChatId={activeChatId}
          isSearchMode={isSearchMode}
          searchQuery={searchQuery}
          searchResults={searchResults}
          onExitSearchMode={handleExitSearchMode}
          onSendFriendRequest={handleSendFriendRequest}
          onAcceptFriendRequest={handleAcceptFriendRequest}
          onOpenChat={handleOpenChat}
        />

        <section className="chat-column">
          {errorMessage && <p className="error-banner">{errorMessage}</p>}

          <Chat
            activeChat={activeChat}
            currentUser={auth.user}
            messages={activeMessages}
            connectionState={connectionState}
            onSendMessage={handleSendMessage}
          />
        </section>
      </main>

      {profileModalOpen && (
        <div className="modal-backdrop" onClick={handleCloseProfileModal}>
          <section className="profile-modal" onClick={(event) => event.stopPropagation()}>
            <h3>Edit profile</h3>

            <div className="profile-preview-row">
              {profileDraftImage ? (
                <img className="profile-preview" src={profileDraftImage} alt="Profile preview" />
              ) : (
                <span className="profile-preview">
                  {initials(profileDraftName, auth.user.username)}
                </span>
              )}

              <div className="profile-actions">
                <label className="ghost file-picker" htmlFor="profile-image-upload">
                  Upload image
                </label>
                <input
                  id="profile-image-upload"
                  type="file"
                  accept="image/*"
                  onChange={handleProfileFileChange}
                />
                <button
                  type="button"
                  className="ghost"
                  onClick={() => {
                    setProfileDraftImage(null);
                    setProfileRemoveImage(true);
                  }}
                >
                  Remove photo
                </button>
              </div>
            </div>

            <label className="profile-label" htmlFor="profile-name-input">
              Display name
            </label>
            <input
              id="profile-name-input"
              value={profileDraftName}
              onChange={(event) => setProfileDraftName(event.target.value)}
              maxLength={36}
              placeholder="Your display name"
            />

            <div className="modal-footer">
              <button type="button" className="ghost" onClick={handleLogout}>
                Logout
              </button>
              <div className="modal-footer-right">
                <button type="button" className="ghost" onClick={handleCloseProfileModal}>
                  Cancel
                </button>
                <button type="button" className="primary" onClick={handleSaveProfile} disabled={profileBusy}>
                  {profileBusy ? "Saving..." : "Save"}
                </button>
              </div>
            </div>
          </section>
        </div>
      )}
    </>
  );
}

export default App;
