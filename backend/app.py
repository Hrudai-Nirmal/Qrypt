import os
import re
import threading
import time
import uuid
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from functools import wraps
from pathlib import Path

import numpy as np
from flask import Flask, jsonify, request
from flask_socketio import SocketIO, emit, join_room, leave_room
from pymongo import ASCENDING, DESCENDING, MongoClient
from werkzeug.security import check_password_hash, generate_password_hash

try:
    from dotenv import load_dotenv
except ImportError:
    load_dotenv = None

if load_dotenv:
    load_dotenv(Path(__file__).with_name(".env"))

try:
    import redis as redis_pkg
except ImportError:
    redis_pkg = None

try:
    from qiskit import QuantumCircuit, transpile
except ImportError as exc:
    raise RuntimeError("Qiskit is required. Install with `pip install qiskit qiskit-aer`.") from exc

try:
    from qiskit_aer import AerSimulator

    AER_SIMULATOR = AerSimulator()
except ImportError:
    from qiskit import Aer, execute

    AER_SIMULATOR = Aer.get_backend("qasm_simulator")

app = Flask(__name__)
app.config["SECRET_KEY"] = os.getenv("FLASK_SECRET_KEY", "qrypt-dev-secret")

cors_origin = os.getenv("CORS_ORIGIN", "*")
allowed_origins = [o.strip() for o in cors_origin.split(",") if o.strip()]
redis_url = os.getenv("REDIS_URL", "").strip()
socketio_message_queue = os.getenv("SOCKETIO_MESSAGE_QUEUE", redis_url).strip()
socketio = SocketIO(
    app,
    cors_allowed_origins=allowed_origins if len(allowed_origins) > 1 else cors_origin,
    message_queue=socketio_message_queue or None,
    async_mode="threading",
)

mongo_uri = os.getenv("MONGO_URI", "mongodb://localhost:27017/")
client = MongoClient(mongo_uri)
db = client[os.getenv("MONGO_DB_NAME", "qrypt")]

users_collection = db["users"]
sessions_collection = db["sessions"]
chats_collection = db["chats"]
messages_collection = db["messages"]

sid_to_username = {}
user_to_sids = defaultdict(set)
presence_lock = threading.Lock()
presence_local = {}
rate_limit_lock = threading.Lock()
memory_rate_counters = {}

RATE_LIMIT_PREFIX = "qrypt:rate"
PRESENCE_PREFIX = "qrypt:presence"
PRESENCE_TTL_SECONDS = int(os.getenv("PRESENCE_TTL_SECONDS", "120"))
PRESENCE_DISCONNECT_GRACE_SECONDS = int(os.getenv("PRESENCE_DISCONNECT_GRACE_SECONDS", "10"))


def create_redis_client():
    if not redis_url or not redis_pkg:
        return None

    try:
        client = redis_pkg.Redis.from_url(redis_url, decode_responses=True)
        client.ping()
        return client
    except Exception:
        return None


redis_client = create_redis_client()


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def to_iso(timestamp: datetime | None) -> str | None:
    if timestamp is None:
        return None

    if timestamp.tzinfo is None:
        timestamp = timestamp.replace(tzinfo=timezone.utc)

    return timestamp.isoformat().replace("+00:00", "Z")


def now_epoch() -> float:
    return time.time()


def ip_from_request() -> str:
    forwarded = request.headers.get("X-Forwarded-For", "")
    if forwarded:
        return forwarded.split(",", 1)[0].strip()
    return request.remote_addr or "unknown"


def rate_limiter_hit(identifier: str, limit: int, window_seconds: int):
    current_time = int(now_epoch())
    window_bucket = current_time // window_seconds
    redis_key = f"{RATE_LIMIT_PREFIX}:{identifier}:{window_seconds}:{window_bucket}"

    if redis_client:
        try:
            pipeline = redis_client.pipeline()
            pipeline.incr(redis_key, 1)
            pipeline.expire(redis_key, window_seconds + 5)
            count, _ = pipeline.execute()
            retry_after = window_seconds - (current_time % window_seconds)
            return int(count) <= limit, max(retry_after, 1), int(count)
        except Exception:
            pass

    memory_key = (identifier, window_seconds, window_bucket)
    with rate_limit_lock:
        count = memory_rate_counters.get(memory_key, 0) + 1
        memory_rate_counters[memory_key] = count

        stale_prefix = (identifier, window_seconds)
        for existing_key in list(memory_rate_counters.keys()):
            if existing_key[:2] == stale_prefix and existing_key[2] != window_bucket:
                memory_rate_counters.pop(existing_key, None)

    retry_after = window_seconds - (current_time % window_seconds)
    return count <= limit, max(retry_after, 1), count


def enforce_rate_limit(identifier: str, limit: int, window_seconds: int):
    allowed, retry_after, _ = rate_limiter_hit(identifier, limit, window_seconds)
    if allowed:
        return None
    return jsonify({"error": "Rate limit exceeded", "retryAfterSeconds": retry_after}), 429


def rate_limit(limit: int, window_seconds: int, scope: str):
    def decorator(func):
        @wraps(func)
        def wrapper(*args, **kwargs):
            user = getattr(request, "current_user", None)
            if user:
                identifier = f"{scope}:user:{user['username']}"
            else:
                identifier = f"{scope}:ip:{ip_from_request()}"

            limited = enforce_rate_limit(identifier, limit, window_seconds)
            if limited:
                return limited
            return func(*args, **kwargs)

        return wrapper

    return decorator


def socket_rate_limit(username: str, scope: str, limit: int, window_seconds: int):
    identifier = f"{scope}:socket:{username}"
    allowed, retry_after, _ = rate_limiter_hit(identifier, limit, window_seconds)
    if allowed:
        return None
    return {
        "message": "Rate limit exceeded",
        "retryAfterSeconds": retry_after,
        "status": 429,
    }


def presence_key(username: str):
    return f"{PRESENCE_PREFIX}:user:{username}"


def touch_presence(username: str):
    timestamp = to_iso(utc_now())

    if redis_client:
        try:
            redis_client.set(presence_key(username), timestamp, ex=PRESENCE_TTL_SECONDS)
            return timestamp
        except Exception:
            pass

    with presence_lock:
        presence_local[username] = {
            "last_seen_epoch": now_epoch(),
            "expires_epoch": now_epoch() + PRESENCE_TTL_SECONDS,
            "last_seen_iso": timestamp,
        }

    return timestamp


def mark_presence_disconnected(username: str):
    timestamp = to_iso(utc_now())

    if redis_client:
        try:
            redis_client.set(
                presence_key(username),
                timestamp,
                ex=PRESENCE_DISCONNECT_GRACE_SECONDS,
            )
            return timestamp
        except Exception:
            pass

    with presence_lock:
        presence_local[username] = {
            "last_seen_epoch": now_epoch(),
            "expires_epoch": now_epoch() + PRESENCE_DISCONNECT_GRACE_SECONDS,
            "last_seen_iso": timestamp,
        }

    return timestamp


def get_presence(username: str):
    if redis_client:
        try:
            value = redis_client.get(presence_key(username))
            return {"online": bool(value), "lastSeen": value}
        except Exception:
            pass

    with presence_lock:
        record = presence_local.get(username)

    if not record:
        return {"online": False, "lastSeen": None}

    return {
        "online": record["expires_epoch"] > now_epoch(),
        "lastSeen": record["last_seen_iso"],
    }


def emit_presence_update(username: str):
    presence = get_presence(username)
    user_doc = users_collection.find_one({"username": username}, {"friends": 1})
    recipients = set([username])
    recipients.update(user_doc.get("friends", []) if user_doc else [])

    for recipient in recipients:
        socketio.emit(
            "presence_updated",
            {
                "username": username,
                "online": presence["online"],
                "lastSeen": presence["lastSeen"],
            },
            room=f"user:{recipient}",
        )


def build_chat_id(user_a: str, user_b: str) -> str:
    left, right = sorted([user_a, user_b])
    return f"{left}::{right}"


def format_user(user_doc, current_user=None):
    current_user = current_user or {}
    friends = set(current_user.get("friends", []))
    presence = get_presence(user_doc["username"])

    return {
        "username": user_doc["username"],
        "displayName": user_doc.get("display_name", user_doc["username"]),
        "isFriend": user_doc["username"] in friends,
        "presence": presence,
    }


def format_chat(chat_doc, me_username: str):
    peer_username = [member for member in chat_doc["members"] if member != me_username][0]
    peer_doc = users_collection.find_one(
        {"username": peer_username},
        {"username": 1, "display_name": 1},
    )
    presence = get_presence(peer_username)

    return {
        "chatId": chat_doc["chat_id"],
        "members": chat_doc["members"],
        "updatedAt": to_iso(chat_doc.get("updated_at")),
        "lastMessage": chat_doc.get("last_message"),
        "peer": {
            "username": peer_username,
            "displayName": (
                peer_doc.get("display_name", peer_username)
                if peer_doc
                else peer_username
            ),
            "presence": presence,
        },
        "quantum": {
            "status": "ready" if chat_doc.get("quantum_key") else "missing",
            "keyLength": len(chat_doc.get("quantum_key", "")),
            "updatedAt": to_iso(chat_doc.get("quantum_created_at")),
            "preview": chat_doc.get("quantum_key", "")[:10],
        },
    }


def format_message(message_doc):
    return {
        "messageId": message_doc["message_id"],
        "chatId": message_doc["chat_id"],
        "sender": message_doc["sender"],
        "body": message_doc["body"],
        "sentAt": to_iso(message_doc["sent_at"]),
    }


def json_error(message: str, status: int = 400):
    return jsonify({"error": message}), status


def create_session(username: str):
    token = str(uuid.uuid4())
    now = utc_now()
    sessions_collection.insert_one(
        {
            "token": token,
            "username": username,
            "created_at": now,
            "expires_at": now + timedelta(days=7),
        }
    )
    return token


def get_session_user(token: str):
    session = sessions_collection.find_one({"token": token})
    if not session:
        return None

    if session["expires_at"] < utc_now():
        sessions_collection.delete_one({"_id": session["_id"]})
        return None

    return users_collection.find_one({"username": session["username"]})


def auth_token_from_request():
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.lower().startswith("bearer "):
        return None
    return auth_header.split(" ", 1)[1].strip()


def require_auth(func):
    @wraps(func)
    def wrapper(*args, **kwargs):
        token = auth_token_from_request()
        if not token:
            return json_error("Missing authentication token", 401)

        user = get_session_user(token)
        if not user:
            return json_error("Invalid or expired session", 401)

        request.current_user = user
        request.session_token = token
        return func(*args, **kwargs)

    return wrapper


def ensure_chat_exists(user_a: str, user_b: str):
    chat_id = build_chat_id(user_a, user_b)
    now = utc_now()
    chats_collection.update_one(
        {"chat_id": chat_id},
        {
            "$setOnInsert": {
                "chat_id": chat_id,
                "members": sorted([user_a, user_b]),
                "created_at": now,
                "last_message": None,
            },
            "$set": {"updated_at": now},
        },
        upsert=True,
    )
    return chats_collection.find_one({"chat_id": chat_id})


def run_circuit_once(circuit: QuantumCircuit):
    if hasattr(AER_SIMULATOR, "run") and hasattr(AER_SIMULATOR, "configuration"):
        compiled = transpile(circuit, AER_SIMULATOR)
        result = AER_SIMULATOR.run(compiled, shots=1, memory=True).result()
        memory = result.get_memory(compiled)[0]
        return [int(bit) for bit in memory[::-1]]

    job = execute(circuit, AER_SIMULATOR, shots=1)
    counts = job.result().get_counts(circuit)
    measured = next(iter(counts.keys()))
    return [int(bit) for bit in measured[::-1]]


def bb84_protocol(num_qubits: int = 20, verification_bits: int = 4, max_attempts: int = 8):
    for _ in range(max_attempts):
        alice_bits = np.random.randint(2, size=num_qubits)
        alice_bases = np.random.randint(2, size=num_qubits)
        bob_bases = np.random.randint(2, size=num_qubits)

        circuit = QuantumCircuit(num_qubits, num_qubits)

        for i in range(num_qubits):
            if alice_bits[i] == 1:
                circuit.x(i)
            if alice_bases[i] == 1:
                circuit.h(i)

        for i in range(num_qubits):
            if bob_bases[i] == 1:
                circuit.h(i)
            circuit.measure(i, i)

        bob_bits = run_circuit_once(circuit)
        sifted = [i for i in range(num_qubits) if alice_bases[i] == bob_bases[i]]

        if len(sifted) <= verification_bits:
            continue

        verification_sample = sifted[:verification_bits]
        if any(alice_bits[i] != bob_bits[i] for i in verification_sample):
            continue

        key_indices = sifted[verification_bits:]
        shared_key = "".join(str(int(alice_bits[i])) for i in key_indices)

        if shared_key:
            return {
                "key": shared_key,
                "siftedBits": len(sifted),
                "verificationBits": verification_bits,
                "qubits": num_qubits,
            }

    return None


def rotate_quantum_key(chat_id: str):
    result = bb84_protocol()
    if not result:
        return None

    now = utc_now()
    chats_collection.update_one(
        {"chat_id": chat_id},
        {
            "$set": {
                "quantum_key": result["key"],
                "quantum_created_at": now,
                "updated_at": now,
            }
        },
    )

    return {
        "status": "ready",
        "sharedKey": result["key"],
        "preview": result["key"][:10],
        "keyLength": len(result["key"]),
        "updatedAt": to_iso(now),
        "siftedBits": result["siftedBits"],
        "verificationBits": result["verificationBits"],
    }


def emit_chat_update(chat_id: str):
    chat = chats_collection.find_one({"chat_id": chat_id})
    if not chat:
        return

    for member in chat["members"]:
        socketio.emit(
            "chat_updated",
            {"chat": format_chat(chat, member)},
            room=f"user:{member}",
        )


def create_message(chat_id: str, sender: str, body: str):
    now = utc_now()
    message_doc = {
        "message_id": str(uuid.uuid4()),
        "chat_id": chat_id,
        "sender": sender,
        "body": body,
        "sent_at": now,
    }
    messages_collection.insert_one(message_doc)

    chats_collection.update_one(
        {"chat_id": chat_id},
        {
            "$set": {
                "updated_at": now,
                "last_message": {
                    "sender": sender,
                    "body": body[:120],
                    "sentAt": to_iso(now),
                },
            }
        },
    )

    serialized = format_message(message_doc)
    socketio.emit("new_message", {"message": serialized}, room=chat_id)
    emit_chat_update(chat_id)

    return serialized


@app.before_request
def handle_preflight():
    if request.method == "OPTIONS":
        return ("", 204)
    return None


@app.after_request
def attach_cors_headers(response):
    request_origin = request.headers.get("Origin", "")
    if cors_origin == "*":
        allow_origin = "*"
    elif request_origin and request_origin in allowed_origins:
        allow_origin = request_origin
    else:
        allow_origin = allowed_origins[0] if allowed_origins else cors_origin

    response.headers["Access-Control-Allow-Origin"] = allow_origin
    response.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS"
    response.headers["Vary"] = "Origin"
    return response


@app.route("/")
def index():
    return "Qrypt backend is running"


@app.get("/api/health")
def healthcheck():
    try:
        client.admin.command("ping")
        db_state = "ok"
    except Exception:
        db_state = "unreachable"

    if redis_client:
        try:
            redis_client.ping()
            redis_state = "ok"
        except Exception:
            redis_state = "unreachable"
    else:
        redis_state = "disabled"

    return jsonify({"status": "ok", "database": db_state, "redis": redis_state})


@app.post("/api/auth/register")
@rate_limit(limit=6, window_seconds=60, scope="auth_register")
def register():
    payload = request.get_json(silent=True) or {}

    username = str(payload.get("username", "")).strip().lower()
    password = str(payload.get("password", ""))
    display_name = str(payload.get("displayName", "")).strip() or username

    if not re.fullmatch(r"[a-z0-9_]{3,24}", username):
        return json_error("Username must be 3-24 chars (letters, numbers, underscore)")

    if len(password) < 8:
        return json_error("Password must be at least 8 characters")

    if users_collection.find_one({"username": username}):
        return json_error("Username already exists", 409)

    users_collection.insert_one(
        {
            "username": username,
            "display_name": display_name,
            "password_hash": generate_password_hash(password),
            "friends": [],
            "created_at": utc_now(),
        }
    )

    token = create_session(username)

    return jsonify(
        {
            "token": token,
            "user": {
                "username": username,
                "displayName": display_name,
                "friends": [],
            },
        }
    )


@app.post("/api/auth/login")
@rate_limit(limit=10, window_seconds=60, scope="auth_login")
def login():
    payload = request.get_json(silent=True) or {}
    username = str(payload.get("username", "")).strip().lower()
    password = str(payload.get("password", ""))

    user = users_collection.find_one({"username": username})
    if not user or not check_password_hash(user["password_hash"], password):
        return json_error("Invalid username or password", 401)

    token = create_session(username)

    return jsonify(
        {
            "token": token,
            "user": {
                "username": user["username"],
                "displayName": user.get("display_name", user["username"]),
                "friends": user.get("friends", []),
            },
        }
    )


@app.get("/api/auth/me")
@require_auth
@rate_limit(limit=60, window_seconds=60, scope="auth_me")
def me():
    current_user = request.current_user
    return jsonify(
        {
            "user": {
                "username": current_user["username"],
                "displayName": current_user.get("display_name", current_user["username"]),
                "friends": current_user.get("friends", []),
            }
        }
    )


@app.post("/api/auth/logout")
@require_auth
@rate_limit(limit=20, window_seconds=60, scope="auth_logout")
def logout():
    sessions_collection.delete_one({"token": request.session_token})
    return jsonify({"ok": True})


@app.get("/api/presence")
@require_auth
@rate_limit(limit=120, window_seconds=60, scope="presence_query")
def presence_query():
    raw = str(request.args.get("usernames", "")).strip()
    requested = [value.strip().lower() for value in raw.split(",") if value.strip()]
    requested = list(dict.fromkeys(requested))[:50]

    current_username = request.current_user["username"]
    allowed = set(request.current_user.get("friends", []))
    allowed.add(current_username)

    result = []
    for username in requested:
        if username in allowed:
            status = get_presence(username)
            result.append(
                {
                    "username": username,
                    "online": status["online"],
                    "lastSeen": status["lastSeen"],
                }
            )

    return jsonify({"presence": result})


@app.get("/api/users/search")
@require_auth
@rate_limit(limit=60, window_seconds=60, scope="users_search")
def search_users():
    query = str(request.args.get("query", "")).strip().lower()
    if not query:
        return jsonify({"users": []})

    regex = re.compile(re.escape(query), re.IGNORECASE)
    docs = users_collection.find(
        {
            "username": {"$ne": request.current_user["username"]},
            "$or": [
                {"username": regex},
                {"display_name": regex},
            ],
        },
        {"username": 1, "display_name": 1, "friends": 1},
    ).limit(12)

    return jsonify(
        {
            "users": [
                format_user(doc, current_user=request.current_user)
                for doc in docs
            ]
        }
    )


@app.post("/api/friends/add")
@require_auth
@rate_limit(limit=30, window_seconds=60, scope="friends_add")
def add_friend():
    payload = request.get_json(silent=True) or {}
    friend_username = str(payload.get("friendUsername", "")).strip().lower()

    current_username = request.current_user["username"]

    if friend_username == current_username:
        return json_error("You cannot add yourself")

    friend = users_collection.find_one({"username": friend_username})
    if not friend:
        return json_error("User not found", 404)

    users_collection.update_one(
        {"username": current_username},
        {"$addToSet": {"friends": friend_username}},
    )
    users_collection.update_one(
        {"username": friend_username},
        {"$addToSet": {"friends": current_username}},
    )

    return jsonify(
        {
            "friend": {
                "username": friend_username,
                "displayName": friend.get("display_name", friend_username),
            }
        }
    )


@app.get("/api/chats")
@require_auth
@rate_limit(limit=90, window_seconds=60, scope="chats_list")
def list_chats():
    username = request.current_user["username"]
    docs = chats_collection.find({"members": username}).sort("updated_at", DESCENDING)
    return jsonify({"chats": [format_chat(chat, username) for chat in docs]})


@app.post("/api/chats/session")
@require_auth
@rate_limit(limit=20, window_seconds=60, scope="chats_session")
def create_or_get_chat():
    payload = request.get_json(silent=True) or {}
    peer_username = str(payload.get("peerUsername", "")).strip().lower()
    me = request.current_user["username"]

    if peer_username == me:
        return json_error("Cannot open a chat with yourself")

    peer = users_collection.find_one({"username": peer_username})
    if not peer:
        return json_error("Peer user not found", 404)

    chat = ensure_chat_exists(me, peer_username)

    if not chat.get("quantum_key"):
        quantum = rotate_quantum_key(chat["chat_id"])
        if quantum:
            socketio.emit(
                "quantum_key_updated",
                {"chatId": chat["chat_id"], "quantum": quantum},
                room=chat["chat_id"],
            )

    latest_chat = chats_collection.find_one({"chat_id": chat["chat_id"]})
    emit_chat_update(chat["chat_id"])

    return jsonify({"chat": format_chat(latest_chat, me)})


@app.get("/api/chats/<chat_id>/messages")
@require_auth
@rate_limit(limit=120, window_seconds=60, scope="messages_list")
def get_messages(chat_id):
    chat = chats_collection.find_one({"chat_id": chat_id})
    if not chat or request.current_user["username"] not in chat["members"]:
        return json_error("Chat not found", 404)

    limit = min(max(int(request.args.get("limit", 100)), 1), 300)
    docs = list(
        messages_collection.find({"chat_id": chat_id})
        .sort("sent_at", DESCENDING)
        .limit(limit)
    )
    docs.reverse()

    return jsonify({"messages": [format_message(message) for message in docs]})


@app.post("/api/chats/<chat_id>/messages")
@require_auth
@rate_limit(limit=40, window_seconds=20, scope="messages_post")
def post_message(chat_id):
    chat = chats_collection.find_one({"chat_id": chat_id})
    if not chat or request.current_user["username"] not in chat["members"]:
        return json_error("Chat not found", 404)

    payload = request.get_json(silent=True) or {}
    body = str(payload.get("body", "")).strip()
    if not body:
        return json_error("Message cannot be empty")

    message = create_message(chat_id, request.current_user["username"], body)
    return jsonify({"message": message})


@app.post("/api/quantum/session")
@require_auth
@rate_limit(limit=6, window_seconds=60, scope="quantum_session")
def create_quantum_session():
    payload = request.get_json(silent=True) or {}
    chat_id = str(payload.get("chatId", "")).strip()
    peer_username = str(payload.get("peerUsername", "")).strip().lower()
    me = request.current_user["username"]

    if not chat_id and not peer_username:
        return json_error("Provide chatId or peerUsername")

    if not chat_id and peer_username:
        if peer_username == me:
            return json_error("Cannot open a chat with yourself")

        peer = users_collection.find_one({"username": peer_username})
        if not peer:
            return json_error("Peer user not found", 404)

        chat = ensure_chat_exists(me, peer_username)
        chat_id = chat["chat_id"]

    chat = chats_collection.find_one({"chat_id": chat_id})
    if not chat or me not in chat["members"]:
        return json_error("Chat not found", 404)

    quantum = rotate_quantum_key(chat_id)
    if not quantum:
        return json_error("BB84 key exchange failed. Please retry.", 503)

    socketio.emit(
        "quantum_key_updated",
        {"chatId": chat_id, "quantum": quantum},
        room=chat_id,
    )
    emit_chat_update(chat_id)

    return jsonify({"chatId": chat_id, "quantum": quantum})


@socketio.on("connect")
def socket_connect(auth):
    auth = auth or {}
    token = auth.get("token")

    if not token:
        return False

    user = get_session_user(token)
    if not user:
        return False

    username = user["username"]
    sid_to_username[request.sid] = username
    user_to_sids[username].add(request.sid)
    join_room(f"user:{username}")
    last_seen = touch_presence(username)
    emit_presence_update(username)

    emit("connected", {"username": username, "presence": {"online": True, "lastSeen": last_seen}})


@socketio.on("disconnect")
def socket_disconnect():
    username = sid_to_username.pop(request.sid, None)
    if not username:
        return

    active_sids = user_to_sids.get(username)
    if active_sids and request.sid in active_sids:
        active_sids.remove(request.sid)

    if active_sids:
        touch_presence(username)
        return

    user_to_sids.pop(username, None)
    mark_presence_disconnected(username)
    emit_presence_update(username)


@socketio.on("join_chat")
def socket_join_chat(payload):
    payload = payload or {}
    chat_id = str(payload.get("chatId", "")).strip()
    username = sid_to_username.get(request.sid)

    if not username or not chat_id:
        emit("socket_error", {"message": "Invalid join request"})
        return

    chat = chats_collection.find_one({"chat_id": chat_id})
    if not chat or username not in chat["members"]:
        emit("socket_error", {"message": "Chat not found"})
        return

    touch_presence(username)
    join_room(chat_id)
    emit("joined_chat", {"chatId": chat_id})


@socketio.on("leave_chat")
def socket_leave_chat(payload):
    payload = payload or {}
    chat_id = str(payload.get("chatId", "")).strip()
    if chat_id:
        leave_room(chat_id)


@socketio.on("send_message")
def socket_send_message(payload):
    payload = payload or {}
    chat_id = str(payload.get("chatId", "")).strip()
    body = str(payload.get("body", "")).strip()
    username = sid_to_username.get(request.sid)

    if not username or not chat_id or not body:
        emit("socket_error", {"message": "Invalid message payload"})
        return

    limited = socket_rate_limit(username, scope="socket_send_message", limit=40, window_seconds=20)
    if limited:
        emit("socket_error", limited)
        return

    chat = chats_collection.find_one({"chat_id": chat_id})
    if not chat or username not in chat["members"]:
        emit("socket_error", {"message": "Chat not found"})
        return

    touch_presence(username)
    create_message(chat_id, username, body)


@socketio.on("presence_ping")
def socket_presence_ping():
    username = sid_to_username.get(request.sid)
    if not username:
        emit("socket_error", {"message": "Unauthorized", "status": 401})
        return

    last_seen = touch_presence(username)
    emit_presence_update(username)
    emit("presence_pong", {"lastSeen": last_seen})


def create_indexes():
    users_collection.create_index([("username", ASCENDING)], unique=True)
    sessions_collection.create_index([("token", ASCENDING)], unique=True)
    sessions_collection.create_index([("expires_at", ASCENDING)], expireAfterSeconds=0)
    chats_collection.create_index([("chat_id", ASCENDING)], unique=True)
    chats_collection.create_index([("members", ASCENDING)])
    messages_collection.create_index([("chat_id", ASCENDING), ("sent_at", ASCENDING)])


create_indexes()


if __name__ == "__main__":
    # Render and other PaaS providers inject PORT; keep BACKEND_PORT for local overrides.
    port = int(os.getenv("PORT", os.getenv("BACKEND_PORT", "5000")))
    socketio.run(
        app,
        host=os.getenv("BACKEND_HOST", "0.0.0.0"),
        port=port,
        debug=os.getenv("FLASK_DEBUG", "false").lower() == "true",
    )
