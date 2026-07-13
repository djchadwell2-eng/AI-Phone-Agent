import { sendInternalSms } from "./twilio.js";
import type { ClientRow } from "./types.js";

/**
 * SMS the business owner from their own Twilio number. Used for real-time
 * after-hours/emergency summaries, SMS-agent escalations, and digests.
 */
export async function alertOwner(input: {
  client: ClientRow;
  body: string;
  eventType: string;
  callId?: string | null;
  threadId?: string | null;
}): Promise<void> {
  const { client } = input;
  if (!client.owner_cell || !client.twilio_number) {
    console.warn(`alertOwner skipped for ${client.slug}: owner_cell/twilio_number not set`);
    return;
  }
  await sendInternalSms({
    clientId: client.id,
    from: client.twilio_number,
    to: client.owner_cell,
    body: input.body.slice(0, 1500), // long SMS segments fine; hard cap for sanity
    eventType: input.eventType,
    callId: input.callId,
    threadId: input.threadId,
  });
}
