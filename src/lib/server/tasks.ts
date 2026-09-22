import type { D1Database } from '@cloudflare/workers-types';
import { error } from '@sveltejs/kit';
import { z } from 'zod';
import type { MailTask } from '$lib/organizer/tasks';
import { getEmailForUser } from './mail-store';
import { notifyUser, type PushNotificationEnv } from './push-notifications';

const instant = z.string().datetime().nullable().default(null);
const input = z.object({
	id: z.string().uuid().optional(),
	version: z.number().int().positive().optional(),
	kind: z.enum(['task', 'followup']).default('task'),
	title: z.string().trim().min(1).max(200),
	notes: z.string().max(8000).default(''),
	sourceEmailId: z.string().max(200).nullable().default(null),
	dueAt: instant,
	reminderAt: instant,
	completed: z.boolean().default(false)
});
export async function getTask(db: D1Database, userId: string, id: string) {
	return db
		.prepare('SELECT * FROM mail_tasks WHERE user_id = ? AND id = ?')
		.bind(userId, id)
		.first<MailTask>();
}
export async function listTasks(
	db: D1Database,
	userId: string,
	kind = '',
	completed = false,
	offset = 0
) {
	const filter = `user_id = ? AND (? = '' OR kind = ?) AND (completed_at IS NOT NULL) = ?`;
	const args = [userId, kind, kind, +completed];
	const rows = await db
		.prepare(
			`SELECT * FROM mail_tasks WHERE ${filter} ORDER BY due_at IS NULL, due_at, created_at DESC LIMIT 51 OFFSET ?`
		)
		.bind(...args, Math.max(0, Math.min(100000, Math.floor(offset) || 0)))
		.all<MailTask>();
	return { tasks: rows.results.slice(0, 50), hasMore: rows.results.length > 50 };
}
export async function saveTask(db: D1Database, userId: string, raw: unknown, id?: string) {
	const parsed = input.safeParse(raw);
	if (!parsed.success) throw error(400, 'Check the task title, due date, and reminder.');
	const data = parsed.data;
	const previous = id ? await getTask(db, userId, id) : null;
	if (id && !previous) throw error(404, 'Task not found');
	if (previous && previous.version !== data.version)
		throw error(409, 'Task changed. Reload before saving.');
	if (previous && (previous.kind !== data.kind || previous.source_email_id !== data.sourceEmailId))
		throw error(400, 'The task type and source message cannot be changed.');
	const message = data.sourceEmailId ? await getEmailForUser(db, userId, data.sourceEmailId) : null;
	if (data.sourceEmailId && !message) throw error(404, 'Source message not found');
	if (
		data.kind === 'followup' &&
		!(previous && !previous.source_email_id && data.completed) &&
		(!message ||
			message.direction !== 'outbound' ||
			!['sent', 'delivered', 'delayed'].includes(message.status ?? ''))
	)
		throw error(400, 'Choose a sent message to wait for a reply.');
	if (data.kind === 'followup' && !data.reminderAt) throw error(400, 'Choose when to follow up.');
	if (
		data.reminderAt &&
		data.dueAt &&
		data.reminderAt > data.dueAt &&
		data.reminderAt !== previous?.reminder_at
	)
		throw error(400, 'The reminder must be on or before the due date.');
	const now = new Date().toISOString();
	const taskId = id ?? data.id ?? crypto.randomUUID();
	const threadId = message ? message.thread_id || message.id : null;
	let replied = false;
	if (data.kind === 'followup' && message) {
		replied = !!(await db
			.prepare(
				`SELECT 1 FROM emails WHERE user_id = ? AND COALESCE(thread_id,id) = ? AND direction = 'inbound' AND is_live_inbound=1
      AND rowid > (SELECT rowid FROM emails WHERE id = ?) AND lower(from_addr) NOT IN (SELECT lower(address) FROM addresses WHERE user_id = ?) LIMIT 1`
			)
			.bind(userId, threadId, message.id, userId)
			.first());
	}
	const completedAt = data.completed || replied ? (previous?.completed_at ?? now) : null;
	const reason = replied ? 'replied' : data.completed ? 'done' : null;
	try {
		const result = previous
			? await db
					.prepare(
						`UPDATE mail_tasks SET title=?,notes=?,due_at=?,reminder_at=?,completed_at=?,completion_reason=?,
          notified_at=CASE WHEN reminder_at IS ? AND completed_at IS ? THEN notified_at ELSE NULL END,
          dismissed_at=CASE WHEN reminder_at IS ? AND completed_at IS ? THEN dismissed_at ELSE NULL END,
          version=version+1,updated_at=? WHERE id=? AND user_id=? AND version=?`
					)
					.bind(
						data.title,
						data.notes,
						data.dueAt,
						data.reminderAt,
						completedAt,
						reason,
						data.reminderAt,
						completedAt,
						data.reminderAt,
						completedAt,
						now,
						taskId,
						userId,
						previous.version
					)
					.run()
			: await db
					.prepare(
						`INSERT INTO mail_tasks(id,user_id,kind,title,notes,source_email_id,thread_id,due_at,reminder_at,completed_at,completion_reason,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
					)
					.bind(
						taskId,
						userId,
						data.kind,
						data.title,
						data.notes,
						data.sourceEmailId,
						threadId,
						data.dueAt,
						data.reminderAt,
						completedAt,
						reason,
						now,
						now
					)
					.run();
		if (!result.meta.changes) throw error(409, 'Task changed. Reload before saving.');
	} catch (cause) {
		if (String(cause).includes('UNIQUE'))
			throw error(
				409,
				'This task or a follow-up for this conversation already exists. Open Tasks to edit it.'
			);
		throw cause;
	}
	return (await getTask(db, userId, taskId))!;
}
export async function deleteTask(db: D1Database, userId: string, id: string, version: number) {
	const result = await db
		.prepare('DELETE FROM mail_tasks WHERE id=? AND user_id=? AND version=?')
		.bind(id, userId, version)
		.run();
	if (!result.meta.changes) throw error(409, 'Task changed or was removed. Reload the list.');
}
export async function taskReminders(db: D1Database, userId: string) {
	return (
		await db
			.prepare(
				`SELECT * FROM mail_tasks WHERE user_id=? AND completed_at IS NULL AND dismissed_at IS NULL AND reminder_at <= ? ORDER BY reminder_at LIMIT 20`
			)
			.bind(userId, new Date().toISOString())
			.all<MailTask>()
	).results;
}
export async function dismissTaskReminder(
	db: D1Database,
	userId: string,
	id: string,
	version: number,
	snooze = false
) {
	const now = new Date().toISOString();
	const result = await db
		.prepare(
			`UPDATE mail_tasks SET dismissed_at=?, reminder_at=CASE WHEN ? THEN ? ELSE reminder_at END,
    notified_at=CASE WHEN ? THEN NULL ELSE notified_at END,version=version+1,updated_at=? WHERE id=? AND user_id=? AND version=? AND completed_at IS NULL`
		)
		.bind(
			snooze ? null : now,
			+snooze,
			new Date(Date.now() + 600000).toISOString(),
			+snooze,
			now,
			id,
			userId,
			version
		)
		.run();
	if (!result.meta.changes) throw error(409, 'Reminder changed. Reload to see its current state.');
}
export async function sendTaskReminders(env: PushNotificationEnv) {
	const now = new Date().toISOString();
	const rows = await env.DB.prepare(
		`SELECT id,user_id,title,kind FROM mail_tasks WHERE completed_at IS NULL AND dismissed_at IS NULL AND notified_at IS NULL AND reminder_at <= ? ORDER BY reminder_at LIMIT 50`
	)
		.bind(now)
		.all<{ id: string; user_id: string; title: string; kind: string }>();
	for (const task of rows.results) {
		const claimed = await env.DB.prepare(
			`UPDATE mail_tasks SET notified_at=? WHERE id=? AND notified_at IS NULL AND completed_at IS NULL AND dismissed_at IS NULL AND reminder_at <= ?`
		)
			.bind(now, task.id, now)
			.run();
		if (claimed.meta.changes)
			await notifyUser(env, task.user_id, {
				title: task.kind === 'followup' ? 'Time to follow up' : 'Task reminder',
				body: task.title,
				tag: `task-${task.id}`,
				url: `/tasks?task=${task.id}&kind=${task.kind}`
			});
	}
}
