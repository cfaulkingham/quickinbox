/**
 * Check credential-creation authority in the INSERT, so session revocation or
 * password reset cannot be bypassed by an already authenticated request.
 * Bind the browser session ID followed by its owner ID.
 */
export const LIVE_CREDENTIAL_SESSION = `SELECT s.user_id FROM sessions s
	JOIN users u ON u.id = s.user_id
	WHERE s.id = ? AND s.user_id = ? AND s.device_platform IS NULL
	  AND datetime(s.expires_at) > datetime('now') AND u.must_change_password = 0
	  AND NOT EXISTS (SELECT 1 FROM user_mfa WHERE user_id = u.id)`;

export class CredentialAuthorizationError extends Error {
	constructor() {
		super('Your session can no longer authorize external credentials. Sign in again.');
	}
}
