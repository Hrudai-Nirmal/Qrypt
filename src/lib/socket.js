import { io } from "socket.io-client";
import { API_BASE_URL } from "./api";

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || API_BASE_URL;

export function createQryptSocket(token) {
  return io(SOCKET_URL, {
    auth: { token },
    transports: ["websocket"],
    autoConnect: true,
  });
}
