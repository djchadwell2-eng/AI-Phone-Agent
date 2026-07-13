import { Hono } from "hono";

/**
 * Publicly-hosted Privacy Policy + SMS Terms, required by Twilio's A2P 10DLC
 * campaign registration (they must resolve at a real public URL, not just be
 * text pasted into the form). Served from the same always-on Railway service
 * since that's already public — no separate site needed. Content is generic
 * enough to cover every client onboarded onto this platform, not just one.
 */
export const legalRoutes = new Hono();

const page = (title: string, bodyHtml: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>
  body { font-family: -apple-system, Segoe UI, Roboto, sans-serif; max-width: 720px; margin: 40px auto; padding: 0 20px; line-height: 1.6; color: #222; }
  h1 { font-size: 1.6rem; } h2 { font-size: 1.2rem; margin-top: 2em; }
  a { color: #1a5fb4; }
</style>
</head>
<body>${bodyHtml}</body>
</html>`;

legalRoutes.get("/privacy", (c) =>
  c.html(
    page(
      "SMS Privacy Policy",
      `
<h1>SMS Privacy Policy</h1>
<p>Effective date: ${new Date().toISOString().slice(0, 10)}</p>
<p>This Privacy Policy describes how mobile phone numbers and message data are handled by the AI-powered call answering and text-messaging service ("the Service") operating on behalf of the business you contacted.</p>

<h2>No Sharing of Mobile Information</h2>
<p><strong>We do not share, sell, or rent your mobile phone number or SMS opt-in data with third parties or affiliates for marketing or promotional purposes.</strong> Your number is used solely to communicate with you about the service you requested (appointment scheduling, follow-up on an inquiry, or a request you made by phone or text).</p>

<h2>Message Frequency</h2>
<p>Message frequency varies based on your interaction with the Service — typically a handful of messages per conversation (for example: an initial follow-up text, your replies, and a booking confirmation). You will not be enrolled in any recurring marketing message program.</p>

<h2>Message and Data Rates</h2>
<p>Message and data rates may apply, depending on your mobile carrier and plan.</p>

<h2>Opt-Out</h2>
<p>Reply <strong>STOP</strong> at any time to a message from the Service to be opted out immediately and permanently from all future text messages. Reply <strong>HELP</strong> for assistance.</p>

<h2>What Information We Collect</h2>
<p>We collect the phone number you contact us from or text us from, and the content of your messages, in order to respond to your inquiry, schedule appointments, and maintain a record of the conversation for the business you contacted.</p>

<h2>Contact</h2>
<p>Questions about this policy can be sent to <a href="mailto:djchadwell2@gmail.com">djchadwell2@gmail.com</a>.</p>
`
    )
  )
);

legalRoutes.get("/terms", (c) =>
  c.html(
    page(
      "SMS Terms and Conditions",
      `
<h1>SMS Terms and Conditions</h1>
<p>Effective date: ${new Date().toISOString().slice(0, 10)}</p>

<h2>Program Description</h2>
<p>By texting or calling the phone number associated with this Service, or by providing your mobile number during a call, you consent to receive text messages related to your inquiry, including: missed-call follow-ups, appointment scheduling and confirmations, and responses to questions you ask via text.</p>

<h2>Message Frequency &amp; Cost</h2>
<p>Message frequency varies by conversation. Message and data rates may apply.</p>

<h2>Opt-In</h2>
<p>You opt in by calling or texting the Service's phone number, or by providing your mobile number during a phone call with the Service.</p>

<h2>Opt-Out</h2>
<p>Text <strong>STOP</strong> at any time to cancel. You will receive one final confirmation message. After that, you will no longer receive messages from this number. You may resume messaging at any time by texting <strong>START</strong>.</p>

<h2>Help</h2>
<p>Text <strong>HELP</strong> at any time for assistance, or contact <a href="mailto:djchadwell2@gmail.com">djchadwell2@gmail.com</a>.</p>

<h2>Carrier Liability</h2>
<p>Carriers are not liable for delayed or undelivered messages.</p>

<h2>Changes</h2>
<p>These terms may be updated from time to time; the current version will always be available at this URL.</p>
`
    )
  )
);
