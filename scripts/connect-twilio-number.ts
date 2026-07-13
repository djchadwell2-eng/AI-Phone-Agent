import { requireEnv } from "../src/lib/env.js";
import { retellClient } from "../src/lib/retell.js";
import { clientBySlug, db } from "../src/lib/supabase.js";
import { twilioClient } from "../src/lib/twilio.js";

/**
 * Connects an EXISTING Twilio number to Retell via elastic SIP trunking —
 * Retell's recommended method (docs.retellai.com/deploy/twilio) and the one
 * that keeps our code out of the live voice path entirely:
 *
 *   1. per-client SIP trunk with credential auth
 *   2. origination → sip:sip.retellai.com (inbound calls go straight to Retell)
 *   3. Disaster Recovery URL → /webhooks/twilio/voice-dr (voice-path failure
 *      becomes a Layer 3 text-back instead of a dead line)
 *   4. number assigned to trunk; SMS webhook → /webhooks/twilio/sms
 *   5. Retell import-phone-number with the trunk's termination URI + creds,
 *      inbound agent binding, and the inbound (dynamic variables) webhook
 *
 * Idempotent: reuses trunk/credential list by friendly name, upserts the import.
 *
 * Usage: npm run number:connect -- --slug summit-heating-air --number +15551234567
 */

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const slug = arg("slug") ?? "summit-heating-air";
  const number = arg("number");
  if (!number?.startsWith("+")) throw new Error("Pass --number +1XXXXXXXXXX (E.164)");

  const client = await clientBySlug(slug);
  if (!client) throw new Error(`No client with slug '${slug}'`);
  if (!client.retell_agent_id) throw new Error(`Client '${slug}' has no retell_agent_id — run agent:push first`);

  const tw = twilioClient();
  const baseUrl = requireEnv("PUBLIC_BASE_URL");
  const sipUser = requireEnv("TWILIO_SIP_USERNAME");
  const sipPass = requireEnv("TWILIO_SIP_PASSWORD");

  // 0. The number must already exist in this Twilio account (you said you'll buy it yourself).
  const numbers = await tw.incomingPhoneNumbers.list({ phoneNumber: number, limit: 1 });
  const phoneNumber = numbers[0];
  if (!phoneNumber) throw new Error(`${number} not found in this Twilio account — buy it in the console first`);

  // 1. Trunk (one per client, found by friendly name).
  const trunkName = `retell-${slug}`;
  const trunks = await tw.trunking.v1.trunks.list({ limit: 50 });
  let trunk = trunks.find((t) => t.friendlyName === trunkName);
  if (!trunk) {
    trunk = await tw.trunking.v1.trunks.create({
      friendlyName: trunkName,
      domainName: `${trunkName}-${Math.random().toString(36).slice(2, 8)}.pstn.twilio.com`,
      disasterRecoveryUrl: `${baseUrl}/webhooks/twilio/voice-dr`,
      disasterRecoveryMethod: "POST",
    });
    console.log(`Created trunk ${trunk.sid} (${trunk.domainName})`);
  } else {
    // Make sure DR is pointed at the current deployment.
    trunk = await tw.trunking.v1.trunks(trunk.sid).update({
      disasterRecoveryUrl: `${baseUrl}/webhooks/twilio/voice-dr`,
      disasterRecoveryMethod: "POST",
    });
    console.log(`Reusing trunk ${trunk.sid} (${trunk.domainName})`);
  }

  // 2. Origination: inbound calls leave Twilio for Retell's SIP server.
  const origs = await tw.trunking.v1.trunks(trunk.sid).originationUrls.list();
  if (!origs.some((o) => o.sipUrl.includes("sip.retellai.com"))) {
    await tw.trunking.v1.trunks(trunk.sid).originationUrls.create({
      sipUrl: "sip:sip.retellai.com",
      friendlyName: "retell",
      priority: 1,
      weight: 1,
      enabled: true,
    });
    console.log("Added origination URL sip:sip.retellai.com");
  }

  // 3. Credential list for termination auth (Retell dials out through this trunk).
  const credListName = `retell-creds-${slug}`;
  const credLists = await tw.sip.credentialLists.list({ limit: 50 });
  let credList = credLists.find((c) => c.friendlyName === credListName);
  if (!credList) {
    credList = await tw.sip.credentialLists.create({ friendlyName: credListName });
    await tw.sip.credentialLists(credList.sid).credentials.create({ username: sipUser, password: sipPass });
    console.log(`Created credential list ${credList.sid}`);
  }
  const trunkCreds = await tw.trunking.v1.trunks(trunk.sid).credentialsLists.list();
  if (!trunkCreds.some((c) => c.sid === credList!.sid)) {
    await tw.trunking.v1.trunks(trunk.sid).credentialsLists.create({ credentialListSid: credList.sid });
  }

  // 4. Put the number on the trunk + point its SMS webhook at us.
  // NOTE: the documented `trunks(sid).phoneNumbers.create()` sub-resource 404s
  // on this account (confirmed against the raw API, not just the SDK) — the
  // working method is setting `trunkSid` directly on the IncomingPhoneNumber
  // resource, which Twilio treats as equivalent (same trunk_sid ends up set).
  await tw.incomingPhoneNumbers(phoneNumber.sid).update({
    trunkSid: trunk.sid,
    smsUrl: `${baseUrl}/webhooks/twilio/sms`,
    smsMethod: "POST",
  });
  console.log(`Assigned ${number} to trunk ${trunk.sid}`);

  // 5. Import into Retell: bind the agent + the per-call config webhook (Layer 2).
  // NOTE: Retell deprecated the single-agent phone-number fields (inbound_agent_id)
  // 2026-03-31 in favor of a weighted agent list — see DECISIONS.md.
  const retell = retellClient();
  const inboundWebhook = `${baseUrl}/webhooks/retell/inbound?token=${requireEnv("INTERNAL_WEBHOOK_TOKEN")}`;
  const inboundAgents = [{ agent_id: client.retell_agent_id!, weight: 1 }];
  const importPayload = {
    phone_number: number,
    termination_uri: trunk.domainName!,
    sip_trunk_auth_username: sipUser,
    sip_trunk_auth_password: sipPass,
    inbound_agents: inboundAgents,
    inbound_webhook_url: inboundWebhook,
    nickname: `${client.business_name} (${slug})`,
  };
  try {
    await retell.phoneNumber.import(importPayload as any);
    console.log(`Imported ${number} into Retell`);
  } catch (e: any) {
    // Already imported → update the binding instead. Only fall back on an
    // actual "already exists" conflict (409, or a message saying so) — any
    // other error (e.g. a bad field name) must surface, not get masked here.
    const status = e?.status ?? e?.response?.status;
    const msg = String(e?.message ?? e);
    if (status === 409 || /already (exists|imported)/i.test(msg)) {
      await retell.phoneNumber.update(number, {
        inbound_agents: inboundAgents,
        inbound_webhook_url: inboundWebhook,
      } as any);
      console.log(`${number} already in Retell — updated agent binding + inbound webhook`);
    } else {
      throw e;
    }
  }

  const { error } = await db()
    .from("clients")
    .update({ twilio_number: number, twilio_number_sid: phoneNumber.sid })
    .eq("id", client.id);
  if (error) throw new Error(`clients update: ${error.message}`);

  console.log(`✓ ${slug}: ${number} → Retell agent ${client.retell_agent_id}`);
  console.log(`  Voice: Twilio trunk ${trunk.sid} → sip.retellai.com (DR → /webhooks/twilio/voice-dr)`);
  console.log(`  SMS:   → ${baseUrl}/webhooks/twilio/sms`);
  console.log(`  NOTE: US SMS deliverability requires A2P 10DLC registration — see docs/SETUP.md §3b.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
