import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { organizerSession, organizerBody, organizerJson } from '$lib/server/organizer-http';
import { getTask, saveTask, deleteTask } from '$lib/server/tasks';
export const GET: RequestHandler = async (e) => {
	const { env, user } = organizerSession(e);
	const task = await getTask(env.DB, user.id, e.params.id);
	if (!task) throw error(404, 'Task not found');
	return organizerJson({ task });
};
export const PUT: RequestHandler = async (e) => {
	const { env, user } = organizerSession(e);
	return organizerJson({
		task: await saveTask(env.DB, user.id, await organizerBody(e.request), e.params.id)
	});
};
export const DELETE: RequestHandler = async (e) => {
	const { env, user } = organizerSession(e);
	const raw = (await organizerBody(e.request)) as { version?: number };
	if (!Number.isInteger(raw?.version)) throw error(400, 'Version required');
	await deleteTask(env.DB, user.id, e.params.id, raw.version!);
	return organizerJson({ ok: true });
};
