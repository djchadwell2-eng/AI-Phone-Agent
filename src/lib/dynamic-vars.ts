import { hoursText, isClientOpen, localTimeText } from "./hours.js";
import type { ClientRow } from "./types.js";

/**
 * The per-call config injection for Layer 2. Returned by the inbound-call
 * webhook; every {{variable}} referenced in prompts/voice-agent.md must exist
 * here (Retell substitutes them at call start). All values must be strings.
 */
export function buildDynamicVariables(client: ClientRow): Record<string, string> {
  const open = isClientOpen(client);
  const emergencyList = client.emergency_keywords.join("; ");
  const priceLines = Object.entries(client.price_ranges)
    .map(([svc, range]) => `${svc}: ${range}`)
    .join("; ");

  return {
    business_name: client.business_name,
    agent_name: "Sunny", // persona name; change here + prompt template together if desired
    trade: client.trade,
    mode: open ? "open" : "closed",
    greeting: open ? client.greeting_day : client.greeting_night,
    hours_text: hoursText(client.hours, client.timezone),
    current_time_local: localTimeText(client),
    services_text: client.services.join(", "),
    service_area: client.service_area,
    persona_notes: client.persona_notes,
    price_ranges_text: priceLines || "none — never quote any price",
    emergency_list: emergencyList || "none configured",
    // Warm-transfer target; the transfer tool number field references {{transfer_number}}
    transfer_number: client.on_call_number ?? "",
    transfer_available: client.features.layer4 !== false && client.on_call_number ? "yes" : "no",
    booking_available: client.calcom_event_type_id ? "yes" : "no",
  };
}
