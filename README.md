# Qrypt

Qrypt is a quantum-encryption-based messenger that combines:

- React frontend (left dashboard + right chat workspace)
- Flask REST APIs + Flask-SocketIO for real-time sessions
- MongoDB for user, chat, session, and message persistence
- Qiskit BB84 simulation for chat key generation/rotation

## Architecture

- `src/` contains the React app
- `backend/app.py` exposes REST + WebSocket APIs
- `backend/requirements.txt` contains Python dependencies

### Key Features Implemented (Phase 1)

- Account registration/login with session tokens
- Search users and add friends
- Open per-user chat sessions
- Real-time messaging with Socket.IO rooms
- Persistent chat history in MongoDB
- BB84 key exchange simulation per chat (`/api/quantum/session`)
- Quantum key status shown in chat header
- Redis-backed online presence (with in-memory fallback)
- Built-in API + socket rate limiting

## Run Locally

## 1) Backend

```bash
cd backend
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
copy .env.example .env
python app.py
```

Backend runs on `http://localhost:5000`.

## 2) Frontend

```bash
npm install
copy .env.example .env
npm run dev
```

Frontend runs on `http://localhost:5173`.

## REST API Summary

- `POST /api/auth/register`
- `POST /api/auth/login`
- `GET /api/auth/me`
- `POST /api/auth/logout`
- `GET /api/presence?usernames=user1,user2`
- `GET /api/users/search?query=...`
- `POST /api/friends/add`
- `GET /api/chats`
- `POST /api/chats/session`
- `GET /api/chats/:chatId/messages`
- `POST /api/chats/:chatId/messages`
- `POST /api/quantum/session`

## Socket Events

- Client to server: `join_chat`, `leave_chat`, `send_message`, `presence_ping`
- Server to client: `connected`, `new_message`, `chat_updated`, `quantum_key_updated`, `presence_updated`, `presence_pong`, `socket_error`

## Deploy Notes

- Frontend is Vercel-ready (`vite build` output in `dist/`)
- Set `VITE_API_BASE_URL` and `VITE_SOCKET_URL` to your deployed backend URL
- Backend can be deployed separately (Render/Railway/Fly/VM) with MongoDB Atlas
- For horizontal scaling, set `REDIS_URL` and `SOCKETIO_MESSAGE_QUEUE` in backend env

## Important Security Note

This is a development foundation. Before production, add:

- HTTPS-only secure cookies or JWT hardening
- Proper E2E encryption using keys (instead of plaintext chat payloads)
- Strong key lifecycle management and audit logging
- Rate limiting + abuse protection
- Comprehensive testing
