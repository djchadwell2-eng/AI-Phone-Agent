// Row shapes we actually use. Kept by hand (no codegen) — small schema, boring wins.

export type DayHours = { open: string; close: string } | null;
export type HoursConfig = Partial<Record<"mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun", DayHours>>;

export interface ClientRow {
  id: string;
  slug: string;
  business_name: string;
  trade: string;
  timezone: string;
  hours: HoursConfig;
  greeting_day: string;
  greeting_night: string;
  persona_notes: string;
  services: string[];
  service_area: string;
  price_ranges: Record<string, string>;
  booking_method: string;
  calcom_event_type_id: number | null;
  calcom_api_key: string | null;
  emergency_keywords: string[];
  on_call_number: string | null;
  owner_cell: string | null;
  twilio_number: string | null;
  twilio_number_sid: string | null;
  retell_agent_id: string | null;
  retell_llm_id: string | null;
  features: {
    layer1?: boolean;
    layer2?: boolean;
    layer3?: boolean;
    layer4?: boolean;
    sms_agent?: boolean;
    follow_ups?: boolean;
  };
  avg_ticket_cents: number;
  recording_enabled: boolean;
  monthly_minute_cap: number | null;
  fake_now: string | null;
  status: "active" | "paused";
}

export interface CallExtraction {
  caller_name: string | null;
  callback_number: string | null;
  address: string | null;
  intent: string;
  urgency: "emergency" | "urgent" | "routine" | "unknown";
  wants_booking: boolean;
  booked: boolean;
  sentiment: "positive" | "neutral" | "negative";
  summary: string;
}

export interface SmsThreadRow {
  id: string;
  client_id: string;
  customer_number: string;
  status: "active" | "escalated" | "closed" | "opted_out";
  context: {
    name?: string;
    address?: string;
    issue?: string;
    origin?: string;
    booking_id?: string;
  };
  origin_call_id: string | null;
  last_message_at: string;
}
