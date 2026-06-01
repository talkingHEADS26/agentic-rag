# Agentic RAG Bot

Channel-agnostischer KI-Assistent mit RAG-Wissensdatenbank, Google Calendar Terminbuchung und Bestätigungs-E-Mail. Ein Backend, zwei Kanäle (Chat-Widget + WhatsApp).

## Was der Bot kann

- Fragen ausschließlich aus der eigenen Wissensdatenbank beantworten (kein GPT-Eigenwissen)
- Qualifizierte Leads zu einem kostenlosen Erstgespräch führen
- Termine direkt in Google Calendar buchen
- Bestätigungs-E-Mail mit HTML-Template an den Kunden senden
- Als Chat-Widget auf jeder Website einbettbar
- Über WhatsApp erreichbar (gleicher Bot, gleiche Logik)

## Stack

| Komponente | Technologie |
|---|---|
| Runtime | Node.js 22 ESM |
| LLM | OpenAI GPT-4o |
| Embeddings | text-embedding-3-small |
| Vektordatenbank | Supabase pgvector |
| Sessions | Redis (24h TTL) |
| Kalender | Google Calendar API (OAuth2) |
| E-Mail | Nodemailer (SMTP) |
| Server | Express + WebSocketServer |
| WhatsApp | Meta Cloud API |
| Deployment | Docker Compose + Caddy |

---

## Setup (Schritt für Schritt)

### Voraussetzungen

- Node.js 22+
- Docker + Docker Compose
- Supabase-Account (kostenlos)
- OpenAI API Key
- Google Cloud Project mit Calendar API

---

### 1. Repository klonen

```bash
git clone https://github.com/talkingHEADS26/agentic-rag.git
cd agentic-rag
npm install
```

---

### 2. Environment Variables

```bash
cp .env.example .env
```

`.env` öffnen und alle Werte eintragen. Die wichtigsten:

| Variable | Wo holen |
|---|---|
| `OPENAI_API_KEY` | platform.openai.com → API Keys |
| `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` | Supabase Dashboard → Project Settings → API |
| `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` | Google Cloud Console → OAuth 2.0 Clients |
| `GOOGLE_REFRESH_TOKEN` | Schritt 4 (Google Auth) |
| `SMTP_HOST/USER/PASS` | Dein E-Mail-Provider |
| `ADMIN_PASSWORD` | Frei wählen |
| `COMPANY_NAME` | Dein Unternehmensname |

---

### 3. Supabase Schema anlegen

Im [Supabase SQL Editor](https://supabase.com/dashboard) → **New query** → Inhalt von `supabase/schema.sql` einfügen → **Run**.

Das legt an:
- Tabelle `knowledge_chunks` mit pgvector
- HNSW-Index für schnelle Vektorsuche
- Suchfunktion `match_chunks`

---

### 4. Google OAuth (einmalig)

```bash
# Callback-URL in Google Cloud Console hinterlegen:
# http://localhost:3001/oauth2callback
# → APIs & Services → OAuth 2.0-Client-IDs → Redirect URIs

node --env-file=.env googleAuth.js
```

Browser öffnet sich → Google-Account authorisieren → `GOOGLE_REFRESH_TOKEN` wird in der Konsole ausgegeben → in `.env` eintragen.

---

### 5. Bot starten

**Lokal:**
```bash
npm run dev
# → http://localhost:3000
```

**Produktion (Docker):**
```bash
docker compose up -d --build
```

---

### 6. Wissensdatenbank befüllen

Admin-Interface öffnen: `http://localhost:3000/admin` (oder Produktions-URL)

- Passwort: `ADMIN_PASSWORD` aus `.env`
- Drag & Drop: `.txt` oder `.md` Dateien hochladen
- Kategorie wählen → Upload → fertig

Alternativ direkt via Script:
```bash
node --env-file=.env ingestKnowledge.js
```

---

### 7. Widget einbetten

Das Widget ist bereits unter `/` erreichbar. Zum Einbetten auf einer externen Seite:

```html
<script>
  window.TH_CHAT_CONFIG = {
    wsUrl: 'wss://deine-domain.de/chat',
    companyName: 'MeinUnternehmen',
    agentName: 'MeinUnternehmen Assistent',
  };
</script>
<!-- Dann den gesamten Widget-HTML-Block aus index.html einfügen -->
```

`WIDGET_ORIGIN` in `.env` auf die Zieldomain setzen (CORS).

---

### 8. WhatsApp einrichten

1. [Meta Developer Console](https://developers.facebook.com) → App → WhatsApp → Webhooks
2. Webhook-URL: `https://deine-domain.de/webhook/whatsapp`
3. Verify Token: Wert aus `WHATSAPP_VERIFY_TOKEN` in `.env`
4. Webhook Events: `messages` subscriben

---

## Deployment (Strato / beliebiger Linux-Server)

### Caddyfile

```
deine-domain.de {
    reverse_proxy localhost:3000
}
```

### Update deployen

```bash
# Lokal:
git add . && git commit -m "..." && git push

# Auf Server:
cd /opt/agentic-rag
git pull && docker compose up -d --build
```

### Server-Management

```bash
docker compose ps                        # Status
docker compose logs -f bot               # Live-Logs
docker compose restart bot               # Neustart
docker exec -it agentic-rag-redis-1 redis-cli FLUSHDB  # Sessions löschen
```

---

## Architektur

```
Internet
    │
Caddy (HTTPS/WSS)
    │
    ├── /            → Chat-Widget (index.html, Config via .env injiziert)
    ├── /admin       → Admin-Interface (Wissensbasis-Management)
    ├── /webhook/whatsapp → WhatsApp Cloud API Handler
    └── /chat        → WebSocketServer → agentHandler.js
                                              │
                              ┌───────────────┼───────────────┐
                              ▼               ▼               ▼
                         Supabase        OpenAI GPT-4o   Google Calendar
                       (pgvector)      (Chat + Embed)      (OAuth2)
                              │                               │
                           Redis                          Nodemailer
                        (Sessions)                    (Bestätigungs-Mail)
```

### Agentic Loop

```
User-Nachricht
    │
GPT-4o mit 3 Tools:
  ├── search_knowledge_base(query)  → Supabase Vektorsuche
  ├── start_booking_flow()          → Startet Buchungs-State-Machine
  └── escalate_to_human(reason)    → Eskalations-Log
    │
Tool-Ergebnis → GPT → Finale Antwort
```

### Buchungs-State-Machine (Code-Level, nicht Prompt)

```
ask_time → ask_week → ask_week_part → show_slots → ask_name → ask_email → ask_phone → [BUCHUNG + MAIL]
```

---

## Konfiguration

Alle kundenspezifschen Werte kommen aus `.env` — kein Code anfassen nötig:

| Was | Variable |
|---|---|
| Unternehmensname im Bot & E-Mail | `COMPANY_NAME` |
| Anzeigename des Assistenten | `AGENT_NAME` |
| Begrüßungstext (optional) | `WIDGET_WELCOME_MSG` |
| Widget-Farben | `WIDGET_PRIMARY_COLOR`, `WIDGET_ACCENT_COLOR` |
| E-Mail-Absender | `SMTP_USER` |
| CORS für Widget-Embed | `WIDGET_ORIGIN` |
