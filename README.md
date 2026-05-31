# RAG Agent — Widget & WhatsApp

Channel-agnostischer RAG Bot auf Basis von Claude + Supabase pgvector + Redis.
Ein Backend, zwei Kanäle.

## Stack

- **Runtime**: Node.js 20+ (ESM)
- **LLM**: Anthropic Claude (Sonnet 4) + Tool Use / Agentic Loop
- **Embeddings**: OpenAI text-embedding-3-small
- **Vektordatenbank**: Supabase pgvector
- **Session State**: Redis
- **Kanäle**: WebSocket (Chat Widget) + HTTP Webhook (WhatsApp Cloud API)

## Setup

### 1. Dependencies installieren
```bash
npm install
```

### 2. Environment Variables
```bash
cp .env.example .env
# .env befüllen
```

### 3. Supabase Schema anlegen
```bash
npm run setup-db
# → Gibt SQL aus → in Supabase SQL Console ausführen
```

### 4. Wissensbasis laden
```bash
# Docs als .txt oder .md in ./docs/ ablegen
mkdir -p docs/sales docs/coaching
# Dann laden:
npm run ingest ./docs/sales Sales
npm run ingest ./docs/coaching Coaching
```

### 5. Server starten
```bash
npm run dev      # Development (auto-restart)
npm start        # Production
```

## WhatsApp Setup

1. Meta Developer Console → App erstellen → WhatsApp Product hinzufügen
2. Test-Nummer konfigurieren
3. Webhook URL: `https://your-domain.com/webhook/whatsapp`
4. Verify Token: Wert aus `.env` → `WHATSAPP_VERIFY_TOKEN`
5. Webhook Events: `messages` subscriben

## Widget einbetten

```html
<script>
  window.TH_CHAT_CONFIG = {
    wsUrl: 'wss://your-domain.com/chat',
    agentName: 'TalkingHEADS Assistent'
  };
</script>
<script src="https://your-cdn.com/widget/index.html"></script>
```

Oder einfach `widget/index.html` als statische Datei serven und das `<script>`-Block
am Ende herauskopieren.

## Architektur

```
Eingehende Nachricht
       │
       ├── WebSocket (/chat)      → Widget
       └── HTTP POST (/webhook)   → WhatsApp
              │
              ▼
    handleMessage() [core/agentHandler.js]
              │
       ┌──────┴──────┐
       ▼             ▼
  Redis (History)  Agentic Loop
                      │
               Tool: search_knowledge_base
                      │
               Supabase match_chunks RPC
                      │
               Claude generiert Antwort
                      │
              zurück an Kanal
```

## Eigene Tools hinzufügen

In `core/agentHandler.js` → `TOOLS` Array erweitern:

```javascript
{
  name: "book_appointment",
  description: "Bucht einen Termin für den User",
  input_schema: {
    type: "object",
    properties: {
      date: { type: "string", description: "Datum im Format YYYY-MM-DD" },
      time: { type: "string", description: "Uhrzeit HH:MM" }
    },
    required: ["date", "time"]
  }
}
```

Dann in `executeTool()`:

```javascript
case "book_appointment": {
  // Google Calendar API Call
  return `Termin gebucht für ${toolInput.date} um ${toolInput.time}`;
}
```
