# Mail, contacts, and calendar

The built-in organizer works without a Google account. This increment completes
much of the personal scheduling and address-book workflow; it does not claim full
Google Workspace equivalence.

## Included

| Workflow | Behavior |
| --- | --- |
| Address book | Create, edit, delete, name/email/company/phone search, favorites, multiple emails, birthday, company, phone, notes; contacts may have a name without an email |
| Groups | Assign multiple groups, filter the address book, export one group, and expand groups of up to 30 contacts into recipient fields |
| Merge | Find contacts with matching names or select contacts manually; review the primary contact; atomically combine emails/groups/notes and preserve conflicting phone/company/birthday details in notes |
| Contact portability | Preview UTF-8 vCard or Google Contacts CSV; report invalid entries; batch import with duplicate skipping; vCard and CSV export |
| Mail integration | Contact and group suggestions in To/Cc/Bcc/forwarding/guests; keyboard selection; save sender, compose, schedule with a contact, create an event from a message |
| Calendar | Month, timed week, agenda; click hour to create; drag then review/save to reschedule; overlap layout, timed/all-day events, named personal calendars, saved display zone, search in the visible period |
| Recurrence | Finite daily/weekly/monthly/yearly series, daily/weekly weekday choices, COUNT or UNTIL; edit/cancel this, following, or all occurrences; local wall-clock times across DST; moved and cancelled exceptions |
| Invitations | Stable UID/sequence, full supported series plus exceptions, guest additions/updates/cancellations; Accept/Maybe/Decline in mail or calendar details |
| Delivery | Atomic event/notices/reminders, immutable invitation payloads, idempotent durable Outbox handoff, delivery status and retry |
| Reminders | Up to five per event, up to a week before; reminders for every occurrence; ten-minute snooze, dismissal, in-app and optional browser push |
| Calendar portability | Individual or calendar ICS export; preview/batch import of supported individual events and complete series into a selected personal calendar |
| Interfaces | Shared organizer screens in Classic and Zero, light/dark styles, phone navigation and agenda |

Incoming messages are not acted on just by opening them. Invitation changes still
require a matching sender/organizer or invited guest, an owned source message,
matching UID/revision, and explicit user action. This does not replace provider
sender authentication. Calendar-detail RSVP uses the previously validated stored
invitation and checks the current invited sending identity and event version.
Mail API tokens gain no organizer privileges. All imports and mutations are scoped
to the signed-in account; imported calendar files create personal copies without
guests, reminders, invitation mail, or external attachment fetching.

## Explicit limits and behavior

- Series contain 1–366 occurrences at intervals of 1–30 days/weeks/months/years,
  ending by 2100. Invalid month dates and DST gaps do not count as occurrences;
  recurring ambiguous times use the first occurrence. Individual edits reject
  ambiguous/nonexistent local times. All-day ends remain exclusive.
- Guests, calendar assignment, time zone, repeat pattern, colors and reminder
  choices apply to the series. Occurrence edits change title, description,
  location and times. Changing a series schedule requires an explicit reset
  choice if it would discard existing occurrence exceptions.
- Supported ICS recurrence is finite FREQ/INTERVAL with COUNT or UNTIL, daily/weekly
  BYDAY and WKST, plus matching EXDATE and RECURRENCE-ID exceptions. Monthly/yearly
  BYDAY, RDATE, EXRULE, RANGE and standalone recurrence updates remain unsupported
  and are reported. ICS files with custom
  time zones can be read for single events; recurring custom zones must use an
  IANA zone. External alarms and URLs are never executed or fetched.
- Calendar queries cover at most 370 days, consider at most 200 series/events,
  and return at most 1,000 expanded occurrences. Stored data and response payloads
  are each limited to 4 MB per query. Truncation is surfaced; choose
  a shorter period or one calendar. Search applies to that same period.
- Up to 20 named personal calendars, 30 guests/event, five reminders/event,
  and 20 selected contacts/merge. A merged contact must fit ten emails, 20 groups
  and 4,000 note characters; oversized merges fail without deleting anything.
- File previews accept 2 MB. Contact imports allow 2,000 rows with batches of 25;
  calendar imports allow 500 events/series with batches of ten (2,000 VEVENT
  components total, 256 KB per series). Keep the import panel open. Retrying skips
  existing email addresses/event UIDs; unsupported rows are reported. Name-only
  contacts are skipped only when all supported stored details match.
- Contact transfer supports name, emails, one phone, company, full-date birthday,
  notes, groups and favorites. Other fields are not imported. Legacy encoded
  vCards require UTF-8 conversion. CSV exports neutralize formula-prefixed cells;
  Quickinbox removes its escape prefix on reimport.
- Exports refuse oversized selections instead of silently truncating: 5,000
  contacts or 500 events/series, with 4 MB of stored event data per calendar export.
  Exports are not an atomic snapshot of ongoing edits.
- Reminders retain delivery/dismissal/snooze state through unrelated changes;
  moved/cancelled occurrences invalidate their old reminders. Snooze cannot extend
  beyond an occurrence's end. In-app reminders are durable; push is best effort.

## Remaining milestones

1. Broader recurrence interoperability (ordinal BYDAY/unbounded series, detached
   invitation updates), free/busy beyond the visible range, calendar management,
   and per-occurrence guest/reminder choices.
2. Additional contact fields, richer duplicate matching, group management,
   automatic birthday calendar, and organizer translations in all app languages.
3. Proposed new times, more granular delegated-organizer permissions,
   rooms/resources, and appointment booking.
4. Mail parity audit: scheduled send, richer filters/rules, saved searches,
   keyboard shortcuts, and offline behavior as separately tested increments.
5. Optional Google Contacts/Calendar OAuth, consent, incremental sync, conflict
   handling, revocation and token storage.

## Validation and rollout

Run `bun run check`, `bun run test`, and `bun run build`. Organizer tests use real
SQLite migrations and mock mail storage; no test sends real email. Coverage
includes account isolation, stale/concurrent edits and merges, rollback, DST and
month boundaries, recurrence exceptions, ICS roundtrips and rejection of unsupported
rules, file preview/retry, imported-event isolation, reminder migration, snooze,
and existing invitation/outbox recovery paths.

Validated locally with 413 passing tests, zero type-check errors (four existing
UI warnings), a successful production build, and migration application in local
D1. Browser checks covered Classic and Zero, mobile editing, timed-week drag and
save, occurrence editing, multiple reminders, contact merge/group selection,
contact and calendar imports, calendar creation, and saved display time zones.
All browser fixtures used isolated local storage and synthetic addresses.

Apply migrations through `0030_organizer_parity.sql` before serving the new build.
It adds contact fields, personal calendars, organizer preferences and a series range
index. It rebuilds the reminder table while preserving delivery and dismissal state
for existing reminders. Normal `bun run deploy` applies migrations first.

The existing minute cron hands off at most 20 notices and processes at most 50 due
reminders per run. No new binding or scheduled trigger is required.

## Product and implementation references

- [Google: invite people to events](https://support.google.com/calendar/answer/37161?hl=en-GB)
- [Google: respond to event invitations](https://support.google.com/calendar/answer/37135?hl=en-GB)
- [Google: use calendar time zones](https://support.google.com/calendar/answer/37064?hl=en-GB)
- [Google: recurring events](https://support.google.com/calendar/answer/37115?hl=en-uk)
- [Google: add, move, or import contacts](https://support.google.com/contacts/answer/1069522?hl=en)
- [IETF: iCalendar](https://www.rfc-editor.org/rfc/rfc5545.html)
- [IETF: iCalendar scheduling interoperability](https://www.rfc-editor.org/info/rfc5546/)
- [Cloudflare: D1 database and transactional batches](https://developers.cloudflare.com/d1/worker-api/d1-database/)

## Productivity increment (0031)

Tasks, no-reply follow-ups, per-address vacation responses, attachment previews and
search, BYDAY/UNTIL/WKST recurrence, shared named calendars with view/edit access,
revocable secret ICS feeds, and external read-only ICS subscriptions are included.
See the README productivity section for behavior, limits and rollout requirements.
The minute worker also processes task reminders, vacation replies, and up to three
due calendar subscriptions per run. Subscription fetches are limited to public HTTPS
URLs, bounded bodies, validated redirects, and a ten-second timeout per fetch.

Additional tests use real SQLite migrations and mock providers to cover account
isolation, stale edits, permission revocation during saves, automatic-reply
throttling/idempotency, live-versus-imported replies, UTC UNTIL across time zones,
subscription URL rejection, feed rotation, and atomic subscription refresh failure.

Validation: 430 tests pass, including 17 productivity regression tests. Type checking
reports no errors (four existing warnings), and the production build succeeds. All
migrations through 0031 apply to a fresh local D1 database. Browser checks cover
email-to-task and follow-up creation, vacation settings, image/PDF previews, shared
calendars, weekday/end-date recurrence, and mobile navigation in both themes.
