import { error } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import { listContacts } from '$lib/server/contacts';
import { exportContacts, importContacts, previewContacts } from '$lib/server/contact-transfer';
import { organizerBody, organizerJson, organizerSession } from '$lib/server/organizer-http';
export const GET: RequestHandler = async (event) => {
	const { env, user } = organizerSession(event);
	const format = event.url.searchParams.get('format') === 'csv' ? 'csv' : 'vcf';
	const { contacts, total } = await listContacts(
		env.DB,
		user.id,
		'',
		5000,
		0,
		event.url.searchParams.get('group') || ''
	);
	if (total > contacts.length)
		throw error(400, 'Export at most 5,000 contacts. Select a smaller group.');
	return new Response(exportContacts(contacts, format), {
		headers: {
			'Content-Type': format === 'csv' ? 'text/csv; charset=utf-8' : 'text/vcard; charset=utf-8',
			'Content-Disposition': `attachment; filename="contacts.${format}"`,
			'Cache-Control': 'private, no-store'
		}
	});
};
export const POST: RequestHandler = async (event) => {
	const { env, user } = organizerSession(event);
	const raw = await organizerBody(event.request, 3 * 1024 * 1024);
	const preview = z.object({ source: z.string(), format: z.enum(['csv', 'vcf']) }).safeParse(raw);
	if (preview.success)
		return organizerJson(previewContacts(preview.data.source, preview.data.format));
	return organizerJson(await importContacts(env.DB, user.id, raw));
};
