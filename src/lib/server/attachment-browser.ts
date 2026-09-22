import type { D1Database } from '@cloudflare/workers-types';
import type { EmailAttachmentMeta } from '$lib/types';
export type AttachmentSearchResult = EmailAttachmentMeta & {
	subject: string;
	from_addr: string;
	email_date: string;
};
export async function searchAttachments(
	db: D1Database,
	userId: string,
	query = '',
	offset = 0,
	kind = ''
) {
	const text = query.trim().slice(0, 200).toLowerCase();
	const rows = await db
		.prepare(
			`SELECT a.id,a.email_id,a.filename,a.content_type,a.size_bytes,a.content_disposition,a.content_id,a.created_at,
   e.subject,e.from_addr,e.created_at AS email_date FROM email_attachments a JOIN emails e ON e.id=a.email_id
   WHERE e.user_id=? AND e.deleted_at IS NULL AND e.spam_at IS NULL AND COALESCE(e.status,'')<>'draft'
   AND (?='' OR instr(lower(a.filename),?)>0 OR instr(lower(e.from_addr),?)>0 OR instr(lower(e.subject),?)>0)
   AND (?='' OR (?='image' AND a.content_type LIKE 'image/%') OR (?='pdf' AND a.content_type='application/pdf'))
   ORDER BY e.created_at DESC,a.id LIMIT 51 OFFSET ?`
		)
		.bind(
			userId,
			text,
			text,
			text,
			text,
			kind,
			kind,
			kind,
			Math.max(0, Math.min(100000, Math.floor(offset) || 0))
		)
		.all<AttachmentSearchResult>();
	return { files: rows.results.slice(0, 50), hasMore: rows.results.length > 50 };
}
