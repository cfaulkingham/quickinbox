import type { D1Database } from '@cloudflare/workers-types';
import { error } from '@sveltejs/kit';
import { z } from 'zod';
import type { Contact } from '$lib/organizer/types';
import { Temporal } from '@js-temporal/polyfill';

const text = (max: number) =>
	z
		.string()
		.trim()
		.max(max)
		.refine((value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value));
export const contactInput = z
	.object({
		name: text(200),
		emails: z
			.array(
				z
					.string()
					.trim()
					.email()
					.max(254)
					.transform((value) => value.toLowerCase())
			)
			.max(10),
		company: text(200).default(''),
		phone: text(100).default(''),
		notes: text(4000).default(''),
		starred: z.boolean().default(false),
		birthday: z
			.string()
			.max(10)
			.default('')
			.refine((value) => {
				if (!value) return true;
				try {
					return Temporal.PlainDate.from(value).toString() === value;
				} catch {
					return false;
				}
			}),
		groups: z
			.array(text(60).refine((value) => value.length > 0))
			.max(20)
			.default([]),
		version: z.number().int().positive().optional()
	})
	.refine((value) => value.emails.length > 0 || value.name.length > 0);
type Row = Omit<Contact, 'emails' | 'starred' | 'groups'> & {
	starred: number;
	emails_json: string;
	groups_json: string;
};
const columns = `c.id, c.name, c.company, c.phone, c.notes, c.starred, c.version, c.birthday, c.groups_json,
  (SELECT json_group_array(email) FROM (SELECT email FROM contact_emails WHERE contact_id = c.id ORDER BY position)) AS emails_json`;
function mapContact(row: Row): Contact {
	const { emails_json, groups_json, starred, ...fields } = row;
	return {
		...fields,
		groups: JSON.parse(groups_json),
		emails: JSON.parse(emails_json),
		starred: Boolean(starred)
	};
}
export async function getContact(
	db: D1Database,
	userId: string,
	id: string
): Promise<Contact | null> {
	const row = await db
		.prepare(`SELECT ${columns} FROM contacts c WHERE c.user_id = ? AND c.id = ?`)
		.bind(userId, id)
		.first<Row>();
	return row ? mapContact(row) : null;
}
export async function contactByEmail(
	db: D1Database,
	userId: string,
	email: string
): Promise<Contact | null> {
	const row = await db
		.prepare('SELECT contact_id FROM contact_emails WHERE user_id = ? AND email = ?')
		.bind(userId, email.trim().toLowerCase())
		.first<{ contact_id: string }>();
	return row ? getContact(db, userId, row.contact_id) : null;
}
export async function listContacts(
	db: D1Database,
	userId: string,
	query = '',
	limit = 100,
	offset = 0,
	group = '',
	favorites = false
) {
	const search = query
		.trim()
		.slice(0, 200)
		.replace(/[\\%_]/g, (value) => `\\${value}`);
	const pattern = `%${search}%`;
	const where = `c.user_id = ? AND (? = '' OR EXISTS (SELECT 1 FROM json_each(c.groups_json) WHERE value = ?))
    AND (? = 0 OR c.starred = 1) AND (c.name LIKE ? ESCAPE '\\' OR c.company LIKE ? ESCAPE '\\' OR c.phone LIKE ? ESCAPE '\\'
    OR EXISTS (SELECT 1 FROM contact_emails e WHERE e.contact_id = c.id AND e.email LIKE ? ESCAPE '\\'))`;
	const args = [userId, group, group, +favorites, pattern, pattern, pattern, pattern];
	const [rows, count] = await Promise.all([
		db
			.prepare(
				`SELECT ${columns} FROM contacts c WHERE ${where} ORDER BY c.starred DESC, c.name COLLATE NOCASE, c.id LIMIT ? OFFSET ?`
			)
			.bind(
				...args,
				Math.max(1, Math.min(5000, Math.trunc(limit))),
				Math.max(0, Math.trunc(offset))
			)
			.all<Row>(),
		db
			.prepare(`SELECT COUNT(*) AS total FROM contacts c WHERE ${where}`)
			.bind(...args)
			.first<{ total: number }>()
	]);
	return { contacts: rows.results.map(mapContact), total: count?.total ?? 0 };
}
export async function saveContact(
	db: D1Database,
	userId: string,
	raw: unknown,
	id: string = crypto.randomUUID()
): Promise<Contact> {
	const parsed = contactInput.safeParse(raw);
	if (!parsed.success)
		throw error(
			400,
			'Enter a name or a valid email address; check the birthday and field lengths.'
		);
	const input = parsed.data;
	const emails = [...new Set(input.emails)];
	const current = await getContact(db, userId, id);
	if (input.version && !current) throw error(404, 'Contact not found');
	if (current && input.version !== current.version)
		throw error(409, 'This contact changed. Reload it before saving.');
	const mutation = crypto.randomUUID();
	const now = new Date().toISOString();
	const statements = current
		? [
				db
					.prepare(
						`UPDATE contacts SET name = ?, company = ?, phone = ?, notes = ?, starred = ?, birthday = ?, groups_json = ?,
    version = version + 1, mutation_id = ?, updated_at = ? WHERE id = ? AND user_id = ? AND version = ?`
					)
					.bind(
						input.name || emails[0],
						input.company,
						input.phone,
						input.notes,
						+input.starred,
						input.birthday,
						JSON.stringify([...new Set(input.groups)]),
						mutation,
						now,
						id,
						userId,
						input.version!
					)
			]
		: [
				db
					.prepare(
						`INSERT INTO contacts (id, user_id, name, company, phone, notes, starred, birthday, groups_json, mutation_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
					)
					.bind(
						id,
						userId,
						input.name || emails[0],
						input.company,
						input.phone,
						input.notes,
						+input.starred,
						input.birthday,
						JSON.stringify([...new Set(input.groups)]),
						mutation,
						now,
						now
					)
			];
	statements.push(
		db
			.prepare(
				`DELETE FROM contact_emails WHERE contact_id = ? AND user_id = ?
    AND EXISTS (SELECT 1 FROM contacts WHERE id = ? AND mutation_id = ?)`
			)
			.bind(id, userId, id, mutation)
	);
	for (const [position, email] of emails.entries())
		statements.push(
			db
				.prepare(
					`INSERT INTO contact_emails (contact_id, user_id, email, position)
    SELECT id, user_id, ?, ? FROM contacts WHERE id = ? AND user_id = ? AND mutation_id = ?`
				)
				.bind(email, position, id, userId, mutation)
		);
	let results;
	try {
		results = await db.batch(statements);
	} catch (cause) {
		if (String(cause).includes('UNIQUE'))
			throw error(409, 'An email address already belongs to another contact.');
		throw cause;
	}
	if (!results[0].meta.changes) throw error(409, 'This contact changed. Reload it before saving.');
	return (await getContact(db, userId, id))!;
}
export async function deleteContact(db: D1Database, userId: string, id: string, version: number) {
	const result = await db
		.prepare('DELETE FROM contacts WHERE id = ? AND user_id = ? AND version = ?')
		.bind(id, userId, version)
		.run();
	if (!result.meta.changes)
		throw error(409, 'Contact not found or changed. Reload before deleting.');
}

export async function contactGroups(db: D1Database, userId: string) {
	const rows = await db
		.prepare(
			`SELECT DISTINCT value AS name FROM contacts, json_each(groups_json)
    WHERE user_id = ? ORDER BY value COLLATE NOCASE`
		)
		.bind(userId)
		.all<{ name: string }>();
	return rows.results.map((row) => row.name);
}

/** Keep the chosen contact's fields and preserve conflicting details in its notes. */
export async function mergeContacts(db: D1Database, userId: string, raw: unknown) {
	const parsed = z
		.array(z.object({ id: z.string().min(1).max(200), version: z.number().int().positive() }))
		.min(2)
		.max(20)
		.safeParse(raw);
	if (!parsed.success || new Set(parsed.data.map((c) => c.id)).size !== parsed.data.length)
		throw error(400, 'Choose between 2 and 20 different contacts to merge.');
	const selected = parsed.data;
	const contacts = await Promise.all(selected.map((c) => getContact(db, userId, c.id)));
	if (contacts.some((c, i) => !c || c.version !== selected[i].version))
		throw error(409, 'A selected contact changed. Reload before merging.');
	const [target, ...sources] = contacts as Contact[];
	const merged = {
		...target,
		emails: [...new Set(contacts.flatMap((c) => c!.emails))],
		groups: [...new Set(contacts.flatMap((c) => c!.groups))],
		starred: contacts.some((c) => c!.starred)
	};
	const notes = [target.notes];
	for (const source of sources) {
		if (source.notes && source.notes !== target.notes)
			notes.push(`${source.name}: ${source.notes}`);
		for (const key of ['company', 'phone', 'birthday'] as const) {
			if (!merged[key]) merged[key] = source[key];
			else if (source[key] && source[key] !== merged[key])
				notes.push(`${source.name} — ${key}: ${source[key]}`);
		}
	}
	merged.notes = [...new Set(notes.filter(Boolean))].join('\n\n');
	if (!contactInput.safeParse(merged).success)
		throw error(
			400,
			'The combined contact exceeds 10 emails, 20 groups, or 4,000 note characters. Merge fewer contacts.'
		);
	const mutation = crypto.randomUUID();
	const guard = `EXISTS (SELECT 1 FROM contacts WHERE id = ? AND user_id = ? AND mutation_id = ?)`;
	const statements = [
		db
			.prepare(
				`UPDATE contacts SET company = ?, phone = ?, birthday = ?, notes = ?,
    groups_json = ?, starred = ?, version = version + 1, mutation_id = ?, updated_at = ?
    WHERE id = ? AND user_id = ? AND (SELECT COUNT(*) FROM contacts c JOIN json_each(?) s
      ON c.id = json_extract(s.value, '$.id') AND c.version = json_extract(s.value, '$.version') WHERE c.user_id = ?) = ?`
			)
			.bind(
				merged.company,
				merged.phone,
				merged.birthday,
				merged.notes,
				JSON.stringify(merged.groups),
				+merged.starred,
				mutation,
				new Date().toISOString(),
				target.id,
				userId,
				JSON.stringify(selected),
				userId,
				selected.length
			),
		db
			.prepare(
				`DELETE FROM contacts WHERE user_id = ? AND id IN (SELECT value FROM json_each(?)) AND ${guard}`
			)
			.bind(userId, JSON.stringify(sources.map((c) => c.id)), target.id, userId, mutation),
		db
			.prepare(`DELETE FROM contact_emails WHERE contact_id = ? AND user_id = ? AND ${guard}`)
			.bind(target.id, userId, target.id, userId, mutation),
		db
			.prepare(
				`INSERT INTO contact_emails (contact_id, user_id, email, position)
      SELECT ?, ?, value, CAST(key AS INTEGER) FROM json_each(?) WHERE ${guard}`
			)
			.bind(target.id, userId, JSON.stringify(merged.emails), target.id, userId, mutation)
	];
	const result = await db.batch(statements);
	if (!result[0].meta.changes)
		throw error(409, 'A selected contact changed. Reload before merging.');
	return (await getContact(db, userId, target.id))!;
}

export async function duplicateContacts(db: D1Database, userId: string) {
	const rows = await db
		.prepare(
			`SELECT ${columns} FROM contacts c WHERE c.user_id = ?
    AND lower(trim(c.name)) IN (SELECT lower(trim(name)) FROM contacts WHERE user_id = ? GROUP BY lower(trim(name)) HAVING COUNT(*) > 1)
    ORDER BY c.name COLLATE NOCASE, c.id LIMIT 200`
		)
		.bind(userId, userId)
		.all<Row>();
	const groups = new Map<string, Contact[]>();
	for (const row of rows.results) {
		const contact = mapContact(row),
			key = contact.name.trim().toLowerCase();
		const members = groups.get(key) ?? [];
		members.push(contact);
		groups.set(key, members);
	}
	return [...groups.values()].filter((group) => group.length > 1);
}
