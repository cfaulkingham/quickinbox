export interface ChatPerson {
	id: string;
	name: string;
	email: string;
}
export interface ChatMessage {
	seq: number;
	id: string;
	conversation_id: string;
	sender_id: string | null;
	sender_name: string;
	body: string;
	created_at: string;
}
export interface Conversation {
	id: string;
	title: string;
	direct_key: string | null;
	members: ChatPerson[];
	unread: number;
	latest_body: string | null;
	updated_at: string;
}
export interface Meeting {
	id: string;
	owner_id: string | null;
	conversation_id: string | null;
	title: string;
	guests_allowed: number;
	audio_only: number;
	expires_at: string;
	ended_at: string | null;
	created_at: string;
}
export type ChatEvent =
	| { type: 'changed'; conversationId: string }
	| { type: 'typing'; conversationId: string; userId: string; name: string }
	| {
			type: 'call';
			conversationId: string;
			meetingId: string;
			name: string;
			audioOnly: boolean;
	  };
export function conversationTitle(chat: Conversation, userId: string): string {
	return (
		chat.title ||
		chat.members
			.filter((p) => p.id !== userId)
			.map((p) => p.name || p.email)
			.join(', ') ||
		'Conversation'
	);
}
