// agentHandler.js — RAG + Terminbuchung + Conversion-Logik (OpenAI)

import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import { createClient as createRedisClient } from "redis";
import { google } from "googleapis";
import { sendBookingConfirmation } from "./emailService.js";

const openai   = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const redis    = createRedisClient({ url: process.env.REDIS_URL });
await redis.connect();

// ─── Google Calendar Auth ────────────────────────────────────────────────────
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);
oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
const calendar = google.calendar({ version: "v3", auth: oauth2Client });

// ─── Embedding ────────────────────────────────────────────────────────────────
async function embedText(text) {
  const res = await openai.embeddings.create({
    input: text,
    model: "text-embedding-3-small",
  });
  return res.data[0].embedding;
}

// ─── RAG ──────────────────────────────────────────────────────────────────────
async function retrieveContext(query, topK = 4) {
  const embedding = await embedText(query);
  const { data, error } = await supabase.rpc("match_chunks", {
    query_embedding: embedding,
    match_threshold: 0.55,
    match_count: topK,
  });
  if (error) throw new Error(`Supabase: ${error.message}`);
  if (!data?.length) return null;
  return data.map((c) => c.content).join("\n\n---\n\n");
}

// ─── Google Calendar: Freie Slots ────────────────────────────────────────────
// time_of_day: "morning" (9-12) | "afternoon" (14-18)
// week:        "this" | "next"
// week_part:   "start" (Mo+Di) | "end" (Mi+Do) — Freitag nie
async function getAvailableSlots({ time_of_day, week, week_part }) {
  const hourStart  = time_of_day === "afternoon" ? 14 : 9;
  const hourEnd    = time_of_day === "afternoon" ? 18 : 12;
  const dayOffsets = week_part === "end" ? [2, 3] : [0, 1]; // Tage ab Montag: 0=Mo,1=Di,2=Mi,3=Do

  const now = new Date();

  // Heutiges Datum in Berlin als YYYY-MM-DD (en-CA liefert dieses Format zuverlässig)
  const todayStr = now.toLocaleDateString("en-CA", { timeZone: "Europe/Berlin" });

  // Wochentag in Berlin: noon UTC des Berlin-Datums vermeidet DST-Randprobleme
  const todayNoon = new Date(todayStr + "T12:00:00Z");
  const berlinDow = todayNoon.getUTCDay(); // 0=So, 1=Mo … 6=Sa

  // Montag der Zielwoche als UTC-noon Date
  const daysToMonday = berlinDow === 0 ? -6 : 1 - berlinDow;
  const mondayNoon = new Date(todayNoon);
  mondayNoon.setUTCDate(todayNoon.getUTCDate() + daysToMonday + (week === "next" ? 7 : 0));

  // Berlin-UTC-Offset (in Stunden, z.B. 2 für CEST) — zuverlässig via Differenz
  const berlinOffsetHours = Math.round(
    (new Date(now.toLocaleString("en-US", { timeZone: "Europe/Berlin" })).getTime() -
     new Date(now.toLocaleString("en-US", { timeZone: "UTC" })).getTime()) / 3600000
  );
  const offsetStr = `+${String(berlinOffsetHours).padStart(2, "0")}:00`;

  // Kandidaten-Slots als korrekte Berlin-ISO-Strings aufbauen
  const candidates = [];
  for (const dayOff of dayOffsets) {
    const dayNoon = new Date(mondayNoon.getTime() + dayOff * 86400000);
    const dayStr  = dayNoon.toISOString().slice(0, 10); // YYYY-MM-DD
    for (let h = hourStart; h < hourEnd; h++) {
      const iso       = `${dayStr}T${String(h).padStart(2, "0")}:00:00${offsetStr}`;
      const slotStart = new Date(iso);
      if (slotStart > now) candidates.push(slotStart);
    }
  }

  if (!candidates.length) return [];

  // freebusy abfragen
  const timeMin = candidates[0].toISOString();
  const timeMax = new Date(candidates.at(-1).getTime() + 3600000).toISOString();

  const freebusy = await calendar.freebusy.query({
    requestBody: {
      timeMin,
      timeMax,
      timeZone: "Europe/Berlin",
      items: [{ id: process.env.GOOGLE_CALENDAR_ID || "primary" }],
    },
  });

  const busySlots =
    freebusy.data.calendars[process.env.GOOGLE_CALENDAR_ID || "primary"]?.busy || [];

  const slots = [];
  for (const slotStart of candidates) {
    if (slots.length >= 5) break;
    const slotEnd = new Date(slotStart.getTime() + 45 * 60000);
    const busy = busySlots.some(
      (b) => slotStart < new Date(b.end) && slotEnd > new Date(b.start)
    );
    if (!busy) {
      slots.push({
        start: slotStart.toISOString(),
        end:   slotEnd.toISOString(),
        label: slotStart.toLocaleString("de-DE", {
          weekday: "long", day: "2-digit", month: "2-digit", year: "numeric",
          hour: "2-digit", minute: "2-digit",
          timeZone: "Europe/Berlin",
        }),
      });
    }
  }

  return slots;
}

// ─── Google Calendar: Termin anlegen ─────────────────────────────────────────
async function createCalendarEvent({ name, email, phone, startIso, endIso, notes }) {
  const event = await calendar.events.insert({
    calendarId: process.env.GOOGLE_CALENDAR_ID || "primary",
    sendUpdates: "all",
    requestBody: {
      summary: `Beratungsgespräch – ${name}`,
      description: `Kontakt: ${email}${phone ? ` | ${phone}` : ""}\n${notes ? `Thema: ${notes}` : ""}`,
      start: { dateTime: startIso, timeZone: "Europe/Berlin" },
      end:   { dateTime: endIso,   timeZone: "Europe/Berlin" },
      attendees: [{ email, displayName: name }],
      reminders: {
        useDefault: false,
        overrides: [
          { method: "email",  minutes: 1440 },
          { method: "popup",  minutes: 30 },
        ],
      },
    },
  });
  return event.data;
}

// ─── Session ──────────────────────────────────────────────────────────────────
async function getSession(sessionId) {
  const raw = await redis.get(`session:${sessionId}`);
  return raw ? JSON.parse(raw) : { messages: [], bookingState: null };
}

async function saveSession(sessionId, session) {
  const trimmed = { ...session, messages: session.messages.slice(-24) };
  await redis.setEx(`session:${sessionId}`, 86400, JSON.stringify(trimmed));
}

// ─── Tools für GPT (nur RAG + Booking starten + Eskalation) ──────────────────
const TOOLS = [
  {
    type: "function",
    function: {
      name: "search_knowledge_base",
      description:
        "Durchsucht die Wissensdatenbank nach Informationen zu TalkingHEADS: Services, Programme, Preise, Coaching, Sales-Training, Methoden, Team, Erfolgsgeschichten. IMMER zuerst aufrufen bevor du eine inhaltliche Frage beantwortest.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Suchanfrage auf Deutsch" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "start_booking_flow",
      description:
        "Startet den Terminbuchungs-Assistenten. NUR aufrufen wenn der User auf die Frage 'Soll ich dir freie Termine zeigen?' mit JA geantwortet hat (z.B. 'ja', 'gerne', 'zeig mal', 'klar', 'bitte'). NIEMALS bei Problemschilderungen oder ersten Kontakten aufrufen.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "escalate_to_human",
      description:
        "Leitet das Gespräch an einen menschlichen Mitarbeiter weiter. Bei: komplexen Vertragsthemen, Beschwerden, oder explizitem Wunsch nach einem Mitarbeiter.",
      parameters: {
        type: "object",
        properties: {
          reason:  { type: "string" },
          summary: { type: "string" },
        },
        required: ["reason", "summary"],
      },
    },
  },
];

// ─── Tool Execution (nur RAG + Eskalation — Booking läuft in State Machine) ───
async function executeTool(name, args, session) {
  switch (name) {
    case "search_knowledge_base": {
      const context = await retrieveContext(args.query);
      if (!context) return "Keine spezifischen Informationen gefunden.";
      return `Relevante Informationen:\n\n${context}`;
    }
    case "start_booking_flow":
      return "__START_BOOKING__";
    case "escalate_to_human":
      console.log(`[ESCALATION] ${args.reason}\nSummary: ${args.summary}`);
      session.bookingState = "escalated";
      return "Eskalation eingeleitet. Ein Mitarbeiter meldet sich innerhalb von 24 Stunden.";
    default:
      return `Unbekanntes Tool: ${name}`;
  }
}

// ─── System Prompt ────────────────────────────────────────────────────────────
function buildSystemPrompt(channel) {
  return `Du bist der KI-Assistent von TalkingHEADS. Du beantwortest ausschließlich Fragen auf Basis der Wissensdatenbank.

## WICHTIGSTE REGEL — KEIN EIGENES WISSEN
Du darfst NIEMALS aus deinem eigenen Trainingswissen antworten. Keine generischen Tipps, keine allgemeinen Ratschläge, keine Erfindungen.
- IMMER zuerst search_knowledge_base aufrufen
- Wenn die Datenbank nichts liefert: "Dazu habe ich gerade keine spezifische Information — das klären wir am besten in einem kurzen Gespräch."
- NIEMALS Inhalte erfinden, die nicht aus der Wissensdatenbank stammen

## Aufgaben
1. Fragen zu TalkingHEADS mit Datenbank-Inhalten beantworten
2. Qualifizierte Leads zu einem kostenlosen Erstgespräch einladen

## Wissensabruf
- Bei JEDER inhaltlichen Frage: ZUERST search_knowledge_base aufrufen, DANN antworten
- Nur das wiedergeben was die Datenbank liefert — nichts dazuerfinden
- Kommt nichts zurück: ehrlich sagen + Gespräch anbieten

## Terminbuchung
- Nach jeder inhaltlichen Antwort aus der Wissensdatenbank: Füge am Ende deiner Antwort GENAU diesen Satz hinzu: "Soll ich dir gleich ein paar freie Termine für ein kostenloses Erstgespräch zeigen?"
- Diesen Satz nur EINMAL pro Gespräch stellen (nicht nach jeder Antwort wiederholen — prüfe den Gesprächsverlauf)
- start_booking_flow NUR aufrufen wenn User auf diese Frage mit "ja", "gerne", "zeig mal", "klar" oder ähnlichem antwortet
- NIEMALS start_booking_flow bei Fragen oder Problemschilderungen aufrufen — immer erst das Angebot als Text machen und auf Ja warten

## Tonalität
- Direkt, auf Augenhöhe, kein Corporate-Sprech
- Max. 3 Absätze
- Nur konkrete Aussagen aus der Datenbank

${channel === "whatsapp"
  ? "Kanal WhatsApp: Kein Markdown, kurze Nachrichten."
  : "Kanal Widget: Markdown erlaubt."
}`;
}

// ─── Agentic Loop (OpenAI) ────────────────────────────────────────────────────
async function runAgentLoop(messages, systemPrompt, session) {
  let currentMessages = [...messages];

  for (let round = 0; round < 6; round++) {
    const response = await openai.chat.completions.create({
      model:    "gpt-4o",
      messages: [{ role: "system", content: systemPrompt }, ...currentMessages],
      tools:    TOOLS,
    });

    const choice  = response.choices[0];
    const message = choice.message;

    if (choice.finish_reason === "stop") {
      return { text: message.content ?? "" };
    }

    if (choice.finish_reason === "tool_calls") {
      currentMessages.push(message);

      const results = [];
      for (const tc of message.tool_calls) {
        const args   = JSON.parse(tc.function.arguments);
        const result = await executeTool(tc.function.name, args, session);
        if (result === "__START_BOOKING__") {
          return { startBooking: true };
        }
        results.push({ role: "tool", tool_call_id: tc.id, content: result });
      }

      currentMessages.push(...results);
      continue;
    }

    break;
  }

  return { text: "Entschuldigung, ich konnte keine vollständige Antwort generieren." };
}

// ─── Booking State Machine ────────────────────────────────────────────────────
const UNCLEAR = null;

function parseTimeOfDay(msg) {
  const m = msg.toLowerCase();
  if (m.includes("vormittag") || m.includes("morgen") || m.includes("früh") || m.includes("9") || m.includes("10") || m.includes("11")) return "morning";
  if (m.includes("nachmittag") || m.includes("14") || m.includes("15") || m.includes("16") || m.includes("17") || m.includes("18")) return "afternoon";
  return UNCLEAR;
}

function parseWeek(msg) {
  const m = msg.toLowerCase();
  if (m.includes("nächst") || m.includes("next")) return "next";
  if (m.includes("dies") || m.includes("diese") || m.includes("this") || m.includes("jetzt") || m.includes("aktuell")) return "this";
  return UNCLEAR;
}

function parseWeekPart(msg) {
  const m = msg.toLowerCase();
  if (m.includes("anfang") || m.includes("montag") || m.includes("mo") || m.includes("dienstag") || m.includes("di") || m.includes("start") || m.includes("beginn")) return "start";
  if (m.includes("mitte") || m.includes("mittwoch") || m.includes("mi") || m.includes("donnerstag") || m.includes("do") || m.includes("end")) return "end";
  return UNCLEAR;
}

// Erkennt ob User den Buchungsflow abbrechen will oder eine andere Frage stellt
function wantsToExit(message, step) {
  const m = msg => message.toLowerCase().includes(msg);
  if (m("abbrech") || m("stopp") || m("cancel") || m("nein danke") || m("nicht mehr")) return true;
  // Bei Infofragen während des Flows: raus
  if (["ask_time","ask_week","ask_week_part"].includes(step)) {
    const isQuestion = message.includes("?") ||
      message.toLowerCase().startsWith("was ") ||
      message.toLowerCase().startsWith("wie ") ||
      message.toLowerCase().startsWith("wer ") ||
      message.toLowerCase().startsWith("warum ") ||
      message.toLowerCase().startsWith("welche");
    if (isQuestion) return true;
  }
  return false;
}

async function handleBookingStep(session, sessionId, message, channel) {
  const step = session.bookingStep;
  const wa   = channel === "whatsapp";

  // Escape-Hatch: User fragt was anderes oder will abbrechen
  if (wantsToExit(message, step)) {
    session.bookingStep    = null;
    session.bookingOffered = false;
    await saveSession(sessionId, session);
    return null; // weiter zum Agent
  }

  switch (step) {
    case "ask_time": {
      const val = parseTimeOfDay(message);
      if (!val) return "Bitte wähle: **Vormittags (9–12 Uhr)** oder **Nachmittags (14–18 Uhr)**?";
      session.bookingPrefs = { time_of_day: val };
      session.bookingStep  = "ask_week";
      await saveSession(sessionId, session);
      return "Diese Woche oder nächste Woche?";
    }

    case "ask_week": {
      const val = parseWeek(message);
      if (!val) return "Bitte wähle: **Diese Woche** oder **Nächste Woche**?";
      session.bookingPrefs.week = val;
      session.bookingStep       = "ask_week_part";
      await saveSession(sessionId, session);
      return wa
        ? "Wochenanfang (Mo/Di) oder Wochenmitte (Mi/Do)?"
        : "Eher **Wochenanfang (Montag/Dienstag)** oder **Wochenmitte (Mittwoch/Donnerstag)**?";
    }

    case "ask_week_part": {
      const val = parseWeekPart(message);
      if (!val) return "Bitte wähle: **Wochenanfang (Mo/Di)** oder **Wochenmitte (Mi/Do)**?";
      session.bookingPrefs.week_part = val;
      session.bookingStep            = "show_slots";

      let slots;
      try {
        slots = await getAvailableSlots(session.bookingPrefs);
      } catch (err) {
        console.error("[Slots] Fehler:", err.message);
        session.bookingStep = null;
        await saveSession(sessionId, session);
        return "Beim Laden der Termine ist ein Fehler aufgetreten. Bitte versuch es gleich nochmal.";
      }

      if (!slots.length) {
        session.bookingStep = null;
        await saveSession(sessionId, session);
        return "Für diese Kombination sind leider keine freien Termine verfügbar. Möchtest du andere Zeiten probieren?";
      }

      session.availableSlots = slots;
      await saveSession(sessionId, session);
      const list = slots.map((s, i) => `${i + 1}. ${s.label}`).join("\n");
      return `Hier sind freie Termine:\n\n${list}\n\nWelcher passt dir? (Einfach die Nummer eingeben)`;
    }

    case "show_slots": {
      const slots = session.availableSlots || [];
      // Nummer aus Nachricht extrahieren
      const num = parseInt(message.match(/\d+/)?.[0]);
      if (!num || num < 1 || num > slots.length) {
        const list = slots.map((s, i) => `${i + 1}. ${s.label}`).join("\n");
        return `Bitte gib eine Nummer zwischen 1 und ${slots.length} ein:\n\n${list}`;
      }
      session.selectedSlot = slots[num - 1];
      session.bookingStep  = "ask_name";
      await saveSession(sessionId, session);
      return `Super, **${session.selectedSlot.label}** ist vorgemerkt.\n\nWie ist dein vollständiger Name?`;
    }

    case "ask_name": {
      session.bookingData = { name: message.trim() };
      session.bookingStep = "ask_email";
      await saveSession(sessionId, session);
      return "Und deine E-Mail-Adresse?";
    }

    case "ask_email": {
      session.bookingData.email = message.trim();
      session.bookingStep       = "ask_phone";
      await saveSession(sessionId, session);
      return "Und deine Handynummer (für eventuelle Rückfragen)?";
    }

    case "ask_phone": {
      session.bookingData.phone = message.trim();
      const { name, email, phone } = session.bookingData;
      const slot = session.selectedSlot;

      try {
        console.log(`[Calendar] Buche: ${name} | ${email} | ${slot.start}`);
        const event = await createCalendarEvent({
          name, email, phone,
          startIso: slot.start,
          endIso:   slot.end,
          notes:    "",
        });
        console.log(`[Calendar] Gebucht: ${event.id}`);
        session.bookingStep  = null;
        session.bookingState = "confirmed";
        session.bookedEvent  = event;
        await saveSession(sessionId, session);

        // Bestätigungs-E-Mail an Kunden
        sendBookingConfirmation({
          name,
          email,
          slotLabel: slot.label,
          calendarLink: event.htmlLink,
        }).catch(err => console.error("[Email] Fehler:", err.message));

        return wa
          ? `✅ Termin gebucht: ${slot.label}\nBestätigung geht an ${email}. Bis dann!`
          : `✅ **Dein Termin ist gebucht!**\n\n📅 ${slot.label}\n📧 Bestätigung geht an ${email}\n\nWir freuen uns auf das Gespräch!`;
      } catch (err) {
        console.error(`[Calendar] Buchungsfehler:`, err.message);
        session.bookingStep = null;
        await saveSession(sessionId, session);
        return `Es gab leider einen technischen Fehler (${err.message}). Meld dich bitte direkt per E-Mail.`;
      }
    }

    default:
      session.bookingStep = null;
      await saveSession(sessionId, session);
      return null; // weiter zum Agent
  }
}

// ─── Haupt-Handler ────────────────────────────────────────────────────────────
export async function handleMessage({ sessionId, message, channel = "widget" }) {
  const session = await getSession(sessionId);

  // Booking State Machine hat Vorrang
  if (session.bookingStep) {
    const reply = await handleBookingStep(session, sessionId, message, channel);
    if (reply) {
      session.messages = [...session.messages,
        { role: "user", content: message },
        { role: "assistant", content: reply },
      ].slice(-24);
      await saveSession(sessionId, session);
      return reply;
    }
  }

  // Normaler Agent-Flow
  const updatedMessages = [
    ...session.messages,
    { role: "user", content: message },
  ];

  const systemPrompt = buildSystemPrompt(channel);
  const result       = await runAgentLoop(updatedMessages, systemPrompt, session);

  // Agent will Booking starten
  if (result.startBooking) {
    session.bookingStep  = "ask_time";
    session.bookingPrefs = {};
    session.messages     = updatedMessages;
    await saveSession(sessionId, session);
    return "Lieber **Vormittags (9–12 Uhr)** oder **Nachmittags (14–18 Uhr)**?";
  }

  const reply = result.text;
  session.messages = [
    ...updatedMessages,
    { role: "assistant", content: reply },
  ];
  await saveSession(sessionId, session);
  return reply;
}
