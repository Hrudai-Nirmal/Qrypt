import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Chat from "./components/Chat";
import Dashboard from "./components/Dashboard";
import Login from "./components/Login";
import {
  acceptFriendRequest,
  getFriendRequests,
  getChats,
  getMessages,
  login,
  logout,
  me,
  postMessage,
  register,
  rotateQuantumKey,
  searchFriends,
  searchUsers,
  sendFriendRequest,
  startChatSession,
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
    // Ignore storage errors and fallback to light.
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
  // Clear legacy shared storage to avoid cross-tab account collisions.
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
  const [friendRequests, setFriendRequests] = useState({ incoming: [], outgoing: [] });
  const [connectionState, setConnectionState] = useState("disconnected");

  const socketRef = useRef(null);
  const messagesRef = useRef({});

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
      setFriendRequests({ incoming: [], outgoing: [] });
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

        const [chatsData, requestsData] = await Promise.all([
          getChats(auth.token),
          getFriendRequests(auth.token),
        ]);
        if (cancelled) {
          return;
        }

        const chatList = sortChats(chatsData.chats || []);
        setChats(chatList);
        setFriendRequests({
          incoming: requestsData.incoming || [],
          outgoing: requestsData.outgoing || [],
        });
        setActiveChatId((current) => current || chatList[0]?.chatId || "");
      } catch (error) {
        if (!cancelled) {
          setErrorMessage(error.message);
          // Only clear local auth when the backend confirms session is invalid.
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
      // Ignore logout request errors and clear local session anyway.
    }

    setAuth(null);
    saveAuthToStorage(null);
    setChats([]);
    setMessagesByChat({});
    setActiveChatId("");
    setSearchQuery("");
    setSearchResults([]);
    setFriendRequests({ incoming: [], outgoing: [] });
    setErrorMessage("");
  }

  async function handleSearchUsers() {
    if (!auth?.token) {
      return;
    }

    const query = searchQuery.trim();
    if (!query) {
      setSearchResults([]);
      return;
    }

    try {
      setErrorMessage("");
      const data = await searchUsers(auth.token, query);
      setSearchResults(data.users || []);
    } catch (error) {
      setErrorMessage(error.message);
    }
  }

  async function handleSearchFriends() {
    if (!auth?.token) {
      return;
    }

    const query = searchQuery.trim();
    try {
      setErrorMessage("");
      const data = await searchFriends(auth.token, query);
      setSearchResults(data.users || []);
    } catch (error) {
      setErrorMessage(error.message);
    }
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

      const requestsData = await getFriendRequests(auth.token);
      setFriendRequests({
        incoming: requestsData.incoming || [],
        outgoing: requestsData.outgoing || [],
      });
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

      const requestsData = await getFriendRequests(auth.token);
      setFriendRequests({
        incoming: requestsData.incoming || [],
        outgoing: requestsData.outgoing || [],
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

  async function handleRotateKey(chatId) {
    if (!auth?.token || !chatId) {
      return;
    }

    try {
      setErrorMessage("");
      const data = await rotateQuantumKey(auth.token, chatId);
      setChats((current) =>
        current.map((chat) =>
          chat.chatId === chatId
            ? {
                ...chat,
                quantum: {
                  ...chat.quantum,
                  ...data.quantum,
                  status: "ready",
                },
              }
            : chat,
        ),
      );
    } catch (error) {
      setErrorMessage(error.message);
    }
  }

  function handleToggleTheme() {
    setTheme((current) => (current === "dark" ? "light" : "dark"));
  }

  function handleOpenSettingsPlaceholder() {
    setErrorMessage("Settings page coming soon.");
  }

  const appTools = (
    <div className="app-tools">
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
      <button type="button" className="ghost settings-button" onClick={handleOpenSettingsPlaceholder}>
        Settings
      </button>
    </div>
  );

  if (!auth?.token || !auth?.user) {
    return (
      <>
        {appTools}
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
      {appTools}
      <main className="app-shell">
        <Dashboard
          user={auth.user}
          chats={chats}
          activeChatId={activeChatId}
          searchQuery={searchQuery}
          onSearchQueryChange={setSearchQuery}
          onSearch={handleSearchUsers}
          onSearchFriends={handleSearchFriends}
          searchResults={searchResults}
          friendRequests={friendRequests}
          onSendFriendRequest={handleSendFriendRequest}
          onAcceptFriendRequest={handleAcceptFriendRequest}
          onOpenChat={handleOpenChat}
          onLogout={handleLogout}
        />

        <section className="chat-column">
          {errorMessage && <p className="error-banner">{errorMessage}</p>}

          <Chat
            activeChat={activeChat}
            currentUser={auth.user}
            messages={activeMessages}
            connectionState={connectionState}
            onSendMessage={handleSendMessage}
            onRotateKey={handleRotateKey}
          />
        </section>
      </main>
    </>
  );
}

export default App;
