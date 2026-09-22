import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { organizerSession } from '$lib/server/organizer-http';
import { listTasks, getTask } from '$lib/server/tasks';
import { getEmailForUser } from '$lib/server/mail-store';
export const load: PageServerLoad = async (e) => {
	const { env, user } = organizerSession(e),
		emailId = e.url.searchParams.get('email'),
		id = e.url.searchParams.get('task');
	const message = emailId ? await getEmailForUser(env.DB, user.id, emailId) : null;
	if (emailId && !message) throw error(404, 'Message not found');
	const selected = id ? await getTask(env.DB, user.id, id) : null;
	if (id && !selected) throw error(404, 'Task not found');
	const kind =
		selected?.kind ?? (e.url.searchParams.get('kind') === 'followup' ? 'followup' : 'task');
	return {
		kind,
		selected,
		seed: message
			? { id: message.id, title: message.subject, notes: (message.body_text || '').slice(0, 8000) }
			: null,
		...(await listTasks(env.DB, user.id, kind))
	};
};
