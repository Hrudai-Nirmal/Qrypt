import { useState } from "react";

function Login({ onLogin, onRegister, loading, errorMessage }) {
  const [mode, setMode] = useState("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");

  const isRegister = mode === "register";

  async function handleSubmit(event) {
    event.preventDefault();

    if (!username.trim() || !password.trim()) {
      return;
    }

    if (isRegister) {
      await onRegister({
        username: username.trim().toLowerCase(),
        password,
        displayName: displayName.trim(),
      });
      return;
    }

    await onLogin({
      username: username.trim().toLowerCase(),
      password,
    });
  }

  return (
    <section className="auth-shell">
      <div className="auth-panel">
        <p className="eyebrow">Qrypt</p>
        <h1>Quantum-secure messaging for real conversations</h1>
        <p className="subtitle">
          Register or sign in to open per-user sessions backed by BB84 key exchange.
        </p>

        <div className="auth-toggle" role="tablist" aria-label="Auth mode">
          <button
            type="button"
            className={mode === "login" ? "active" : ""}
            onClick={() => setMode("login")}
          >
            Login
          </button>
          <button
            type="button"
            className={mode === "register" ? "active" : ""}
            onClick={() => setMode("register")}
          >
            Register
          </button>
        </div>

        <form className="auth-form" onSubmit={handleSubmit}>
          {isRegister && (
            <label>
              Display name
              <input
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder="Ex: Ada Lovelace"
                maxLength={36}
              />
            </label>
          )}

          <label>
            Username
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="3-24 chars, letters/numbers/_"
              autoComplete="username"
              required
            />
          </label>

          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="At least 8 characters"
              autoComplete={isRegister ? "new-password" : "current-password"}
              required
            />
          </label>

          {errorMessage && <p className="error-text">{errorMessage}</p>}

          <button type="submit" className="primary" disabled={loading}>
            {loading ? "Working..." : isRegister ? "Create account" : "Sign in"}
          </button>
        </form>
      </div>
    </section>
  );
}

export default Login;
