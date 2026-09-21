import ICAL from 'ical.js';
import { error, isHttpError } from '@sveltejs/kit';
import type { D1Database } from '@cloudflare/workers-types';
import type { Contact } from '$lib/organizer/types';
import { contactByEmail, contactInput, saveContact } from './contacts';
import { z } from 'zod';

export type ContactImport = z.infer<typeof contactInput>;
export type ImportIssue = { row: number; message: string };
const LIMIT = 2000;
const unescape = (value: string) =>
	value.replace(/\\([nN,;\\])/g, (_, char) => (/n/i.test(char) ? '\n' : char));
const escape = (value: string) =>
	value.replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/[,;]/g, '\\$&');

/** RFC 4180 quoting, including newlines and doubled quotes. */
export function csvRows(source: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [],
		value = '',
		quoted = false;
	for (let i = 0; i < source.length; i++) {
		const char = source[i];
		if (char === '"') {
			if (quoted && source[i + 1] === '"') {
				value += '"';
				i++;
			} else if (quoted || !value) quoted = !quoted;
			else throw new Error('Unexpected quote in CSV.');
		} else if (!quoted && (char === ',' || char === '\n' || char === '\r')) {
			row.push(value);
			value = '';
			if (char !== ',') {
				if (char === '\r' && source[i + 1] === '\n') i++;
				if (row.some(Boolean)) rows.push(row);
				row = [];
				if (rows.length > LIMIT + 1) throw new Error('Import at most 2,000 contacts at a time.');
			}
		} else value += char;
	}
	if (quoted) throw new Error('Unclosed quoted CSV field.');
	row.push(value);
	if (row.some(Boolean)) rows.push(row);
	return rows;
}

export function previewContacts(source: string, format: 'csv' | 'vcf') {
	if (new TextEncoder().encode(source).length > 2 * 1024 * 1024)
		throw error(413, 'Import files up to 2 MB.');
	const contacts: ContactImport[] = [],
		issues: ImportIssue[] = [];
	function add(raw: unknown, row: number) {
		const parsed = contactInput.safeParse(raw);
		if (parsed.success) contacts.push(parsed.data);
		else
			issues.push({
				row,
				message:
					'Invalid or oversized contact fields. Check email addresses and birthday (YYYY-MM-DD).'
			});
	}
	try {
		if (format === 'csv') {
			const [header, ...rows] = csvRows(source.replace(/^\uFEFF/, ''));
			if (!header) throw new Error('The CSV file is empty.');
			if (rows.length > LIMIT) throw new Error('Import at most 2,000 contacts at a time.');
			const names = header.map((s) => s.trim().toLowerCase());
			if (
				!names.some((h) =>
					/^(name|first name|given name|e-mail 1 - value|email 1 - value|email)$/.test(h)
				)
			)
				throw new Error('Use a Google Contacts CSV with a header row.');
			for (const [i, row] of rows.entries()) {
				const get = (...keys: string[]) =>
					keys
						.map((key) => (row[names.indexOf(key)] || '').replace(/^'(?=[=+\-@\t\r])/, ''))
						.find(Boolean) || '';
				const emails = names.flatMap((h, j) =>
					/^(e-?mail( \d+ - value)?)$/.test(h) && row[j] ? row[j].split(/\s*::: ?\s*/) : []
				);
				add(
					{
						name:
							get('name') ||
							[
								get('first name', 'given name'),
								get('middle name', 'additional name'),
								get('last name', 'family name')
							]
								.filter(Boolean)
								.join(' '),
						emails,
						company: get('organization 1 - name', 'organization name', 'company'),
						phone: get('phone 1 - value', 'phone'),
						birthday: get('birthday'),
						notes: get('notes'),
						groups: get('group membership', 'labels')
							.split(/\s*:::\s*/)
							.filter((g) => g && g !== '* myContacts'),
						starred: get('starred') === 'true'
					},
					i + 2
				);
			}
		} else {
			const lines = source
				.replace(/^\uFEFF/, '')
				.replace(/\r?\n[ \t]/g, '')
				.split(/\r?\n/);
			let card: Record<string, string[]> | null = null,
				number = 0,
				unsupported = false;
			for (const line of lines) {
				if (/^BEGIN:VCARD$/i.test(line)) {
					if (card) throw new Error('Nested vCards are invalid.');
					card = {};
					unsupported = false;
					if (++number > LIMIT) throw new Error('Import at most 2,000 contacts at a time.');
				} else if (/^END:VCARD$/i.test(line)) {
					if (!card) throw new Error('Invalid vCard boundary.');
					const get = (key: string) => unescape(card![key]?.[0] || '');
					if (unsupported)
						issues.push({
							row: number,
							message: 'Legacy encoded vCard; export UTF-8 vCard 3.0 or 4.0.'
						});
					else
						add(
							{
								name: get('FN') || get('N').split(';').filter(Boolean).reverse().join(' '),
								emails: (card.EMAIL || []).map(unescape),
								company: get('ORG').replace(/;/g, ' · '),
								phone: get('TEL').replace(/^tel:/i, ''),
								notes: get('NOTE'),
								birthday: get('BDAY').replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3'),
								starred: get('X-QUICKINBOX-STARRED') === 'true',
								groups: (card.CATEGORIES || []).flatMap((v) => v.split(/(?<!\\),/).map(unescape))
							},
							number
						);
					card = null;
				} else if (card && line.includes(':')) {
					const colon = line.indexOf(':'),
						header = line.slice(0, colon);
					const key = header.split(';')[0].split('.').at(-1)!.toUpperCase();
					if (
						['FN', 'N', 'EMAIL', 'ORG', 'TEL', 'NOTE', 'BDAY', 'CATEGORIES'].includes(key) &&
						/ENCODING=|CHARSET=(?!UTF-8)/i.test(header)
					)
						unsupported = true;
					(card[key] ??= []).push(line.slice(colon + 1));
				}
			}
			if (card) throw new Error('Unclosed vCard.');
			if (!number) throw new Error('No vCards found.');
		}
	} catch (cause) {
		throw error(400, cause instanceof Error ? cause.message : 'Invalid contact file.');
	}
	return { contacts, issues };
}

export async function importContacts(db: D1Database, userId: string, raw: unknown) {
	const parsed = z.array(contactInput).min(1).max(25).safeParse(raw);
	if (!parsed.success) throw error(400, 'Import up to 25 validated contacts per batch.');
	let imported = 0,
		skipped = 0;
	const issues: ImportIssue[] = [];
	for (const [index, contact] of parsed.data.entries()) {
		try {
			let duplicate = false;
			for (const email of contact.emails)
				if (await contactByEmail(db, userId, email)) {
					duplicate = true;
					break;
				}
			if (!contact.emails.length)
				duplicate = !!(await db
					.prepare(
						'SELECT id FROM contacts WHERE user_id = ? AND name = ? AND phone = ? AND company = ? AND notes = ? AND birthday = ? AND groups_json = ? AND starred = ?'
					)
					.bind(
						userId,
						contact.name,
						contact.phone,
						contact.company,
						contact.notes,
						contact.birthday,
						JSON.stringify([...new Set(contact.groups)]),
						+contact.starred
					)
					.first());
			if (duplicate) {
				skipped++;
				continue;
			}
			await saveContact(db, userId, { ...contact, version: undefined });
			imported++;
		} catch (cause) {
			if (isHttpError(cause) && cause.status === 409) skipped++;
			else if (isHttpError(cause) && cause.status === 400)
				issues.push({ row: index + 1, message: cause.body.message });
			else throw cause;
		}
	}
	return { imported, skipped, issues };
}

export function exportContacts(contacts: Contact[], format: 'csv' | 'vcf') {
	if (format === 'vcf')
		return contacts
			.map((c) => {
				const lines = [
					'BEGIN:VCARD',
					'VERSION:3.0',
					`UID:${c.id}`,
					`FN:${escape(c.name)}`,
					...c.emails.map((email) => `EMAIL:${escape(email)}`),
					`ORG:${escape(c.company)}`,
					`TEL:${escape(c.phone)}`,
					`NOTE:${escape(c.notes)}`,
					...(c.birthday ? [`BDAY:${c.birthday}`] : []),
					`CATEGORIES:${c.groups.map(escape).join(',')}`,
					`X-QUICKINBOX-STARRED:${c.starred}`,
					'END:VCARD'
				];
				return lines.map((line) => ICAL.helpers.foldline(line)).join('\r\n') + '\r\n';
			})
			.join('');
	const header = [
		'Name',
		...Array.from({ length: 10 }, (_, i) => `E-mail ${i + 1} - Value`),
		'Organization 1 - Name',
		'Phone 1 - Value',
		'Birthday',
		'Notes',
		'Group Membership',
		'Starred'
	];
	// Prevent formulas when an exported CSV is opened in spreadsheet applications.
	const cell = (value: string) =>
		`"${(/^[=+\-@\t\r]/.test(value) ? `'${value}` : value).replace(/"/g, '""')}"`;
	return [
		header,
		...contacts.map((c) => [
			c.name,
			...Array.from({ length: 10 }, (_, i) => c.emails[i] || ''),
			c.company,
			c.phone,
			c.birthday,
			c.notes,
			c.groups.join(' ::: '),
			String(c.starred)
		])
	]
		.map((row) => row.map(cell).join(','))
		.join('\r\n');
}
