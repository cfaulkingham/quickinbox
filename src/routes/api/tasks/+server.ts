import type { RequestHandler } from './$types';
import { organizerSession, organizerBody, organizerJson } from '$lib/server/organizer-http';
import { listTasks, saveTask } from '$lib/server/tasks';
export const GET: RequestHandler = async (e) => {
	const { env, user } = organizerSession(e);
	return organizerJson(
		await listTasks(
			env.DB,
			user.id,
			e.url.searchParams.get('kind') || '',
			e.url.searchParams.get('completed') === '1',
			Number(e.url.searchParams.get('offset'))
		)
	);
};
export const POST: RequestHandler = async (e) => {
	const { env, user } = organizerSession(e);
	return organizerJson(
		{ task: await saveTask(env.DB, user.id, await organizerBody(e.request)) },
		201
	);
};
