export type MailTask = {
	id: string;
	kind: 'task' | 'followup';
	title: string;
	notes: string;
	source_email_id: string | null;
	thread_id: string | null;
	due_at: string | null;
	reminder_at: string | null;
	notified_at: string | null;
	dismissed_at: string | null;
	completed_at: string | null;
	completion_reason: string | null;
	version: number;
	created_at: string;
	updated_at: string;
};
