import { writable } from 'svelte/store';
export const chatUnread = writable(0);
export const chatConnected = writable(false);
let socket: WebSocket | null = null;
export function setChatSocket(value: WebSocket | null) {
	socket = value;
}
export function sendTyping(conversationId: string) {
	if (socket?.readyState === WebSocket.OPEN)
		socket.send(JSON.stringify({ type: 'typing', conversationId }));
}
