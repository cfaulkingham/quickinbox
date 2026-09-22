import type { RequestHandler } from './$types';
import { chatSession, publishChat } from '$lib/server/chat';
import { organizerBody, organizerJson } from '$lib/server/organizer-http';
import { createMeeting, listMeetings } from '$lib/server/meetings';
export const GET: RequestHandler = async (e) => {
	const { env, user } = chatSession(e);
	return organizerJson({ meetings: await listMeetings(env, user.id) });
};
export const POST: RequestHandler = async (e) => {
	const { env, user } = chatSession(e);
	const meeting = await createMeeting(
		env,
		user.id,
		await organizerBody(e.request, 4096)
	);
	if (meeting.conversation_id)
		e.platform!.ctx.waitUntil(
			publishChat(
				env,
				meeting.conversation_id,
				{
					type: 'call',
					conversationId: meeting.conversation_id,
					meetingId: meeting.id,
					name: user.name,
					audioOnly: !!meeting.audio_only
				},
				user.id,
				{
					title: `${user.name} started a call`,
					body: meeting.title,
					url: `/meet/${meeting.id}`
				}
			)
		);
	return organizerJson({ meeting }, 201);
};
