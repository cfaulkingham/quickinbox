export type Contact = {
	id: string;
	name: string;
	emails: string[];
	company: string;
	phone: string;
	notes: string;
	starred: boolean;
	version: number;
	birthday: string;
	groups: string[];
};
export type PersonalCalendar = { id: string; name: string; color: string };
export type Recurrence = {
	frequency: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
	interval: number;
	count: number;
};
export type EventException = Pick<
	CalendarEvent,
	'title' | 'description' | 'location' | 'startLocal' | 'endLocal' | 'cancelled'
>;
export type Attendance = 'NEEDS-ACTION' | 'ACCEPTED' | 'TENTATIVE' | 'DECLINED';
export type CalendarGuest = { email: string; name: string; status: Attendance };
export type CalendarEvent = {
	id: string;
	uid: string;
	title: string;
	description: string;
	location: string;
	startsAt: string;
	endsAt: string;
	startLocal: string;
	endLocal: string;
	timeZone: string;
	allDay: boolean;
	color: string;
	organizer: { email: string; name: string };
	guests: CalendarGuest[];
	owned: boolean;
	fromAddressId: string | null;
	sourceEmailId: string | null;
	response: Attendance;
	reminderMinutes: number | null;
	version: number;
	sequence: number;
	cancelled: boolean;
	updatedAt: string;
	calendarId?: string | null;
	reminders?: number[];
	recurrence?: Recurrence | null;
	exceptions?: Record<string, EventException>;
	/** Original local start identifies an occurrence even after it is moved. */
	occurrenceKey?: string;
};
export type CalendarReminder = {
	id: string;
	event_id: string;
	title: string;
	starts_at: string;
	occurrence_key?: string;
};
export type CalendarInvitation = {
	attachmentId: string;
	event: CalendarEvent;
	method: string;
	canRespond: boolean;
	warning: string | null;
	existingId: string | null;
	response: Attendance | null;
	existingVersion?: number;
};
