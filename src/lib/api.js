const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "http://localhost:5000";

async function request(path, options = {}) {
  let response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });
  } catch {
    const networkError = new Error("Network error. Check API URL/CORS/HTTPS.");
    networkError.status = 0;
    throw networkError;
  }

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(data.error || "Request failed");
    error.status = response.status;
    throw error;
  }

  return data;
}

function withAuth(token) {
  return {
    Authorization: `Bearer ${token}`,
  };
}

export async function register(payload) {
  return request("/api/auth/register", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function login(payload) {
  return request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function me(token) {
  return request("/api/auth/me", {
    headers: withAuth(token),
  });
}

export async function logout(token) {
  return request("/api/auth/logout", {
    method: "POST",
    headers: withAuth(token),
  });
}

export async function searchUsers(token, query) {
  const params = new URLSearchParams({ query });
  return request(`/api/users/search?${params.toString()}`, {
    headers: withAuth(token),
  });
}

export async function addFriend(token, friendUsername) {
  return request("/api/friends/add", {
    method: "POST",
    headers: withAuth(token),
    body: JSON.stringify({ friendUsername }),
  });
}

export async function getChats(token) {
  return request("/api/chats", {
    headers: withAuth(token),
  });
}

export async function startChatSession(token, peerUsername) {
  return request("/api/chats/session", {
    method: "POST",
    headers: withAuth(token),
    body: JSON.stringify({ peerUsername }),
  });
}

export async function getMessages(token, chatId) {
  return request(`/api/chats/${chatId}/messages`, {
    headers: withAuth(token),
  });
}

export async function postMessage(token, chatId, body) {
  return request(`/api/chats/${chatId}/messages`, {
    method: "POST",
    headers: withAuth(token),
    body: JSON.stringify({ body }),
  });
}

export async function rotateQuantumKey(token, chatId) {
  return request("/api/quantum/session", {
    method: "POST",
    headers: withAuth(token),
    body: JSON.stringify({ chatId }),
  });
}

export { API_BASE_URL };
