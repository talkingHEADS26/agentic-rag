# Projektdokumentation: Agentic RAG Chat-Bot
**TalkingHEADS Digital Marketing**
**Entwicklungszeitraum:** Mai–Juni 2026
**Status:** Produktiv auf `https://chat.diebestenberatungsagenturen.de`

---

## 1. Ausgangssituation & Ziel

### Erster Prompt
> "Lies den Ordnerinhalt insbesondere die Dokumente Readme und Agentic RAG Chat und mach Dich mit dem Projekt vertraut."

### Ziel
Ein channel-agnostischer KI-Assistent für TalkingHEADS, der:
- Fragen zu Angeboten und Programmen aus einer eigenen Wissensdatenbank beantwortet (RAG)
- **Kein** allgemeines GPT-Wissen nutzt — ausschließlich Datenbank-Inhalte
- Qualifizierte Leads über einen strukturierten Dialog zu einem kostenlosen Erstgespräch führt
- Termine direkt in Google Calendar bucht
- Dem Kunden eine Bestätigungs-E-Mail mit HTML-Template schickt
- Als Chat-Widget auf Webseiten eingebettet werden kann
- Über WhatsApp erreichbar ist (selber Bot, anderer Kanal)
- Ohne Middleware (kein n8n) betrieben wird
- **White-Label-fähig:** Alle kundenspezifschen Texte und Farben kommen aus `.env` — kein Code anfassen nötig

---

## 2. Technologie-Stack

| Komponente | Technologie | Begründung |
|---|---|---|
| Runtime | Node.js 22 ESM | Native WebSocket-Unterstützung (Supabase-Requirement) |
| LLM | OpenAI GPT-4o | Umstieg von Anthropic Claude auf Kundenwunsch |
| Embeddings | OpenAI text-embedding-3-small | Supabase-kompatibel, kostengünstig |
| Vektordatenbank | Supabase pgvector | Managed, einfaches SQL-Interface |
| Session-Speicher | Redis | 24h TTL, max. 24 Nachrichten pro Session |
| Kalender | Google Calendar API (OAuth2) | Direktbuchung ohne Zwischendienst |
| E-Mail | Nodemailer (SMTP) | Fancy HTML-Bestätigungsmail nach Buchung |
| HTTP/WS-Server | Express + ws (WebSocketServer) | Dual-Channel: HTTP + WebSocket |
| WhatsApp | Meta WhatsApp Cloud API | Webhook-basiert |
| Reverse Proxy | Caddy | Automatisches Let's Encrypt SSL |
| Containerisierung | Docker Compose | Isolierte Umgebung auf Strato-Server |
| Hosting | Strato Cloud Server (Ubuntu 24.04) | Bereits vorhandene Infrastruktur |
| DNS | Hetzner DNS | Domain registriert bei Hetzner |

---

## 3. Systemarchitektur

```
Internet
    │
    ▼
Caddy (Port 443, HTTPS + WSS)
    │
    ├── /            → Express → index.html (Config via .env injiziert)
    ├── /admin       → Express → admin/upload.html (Passwortgeschützt)
    ├── /admin/*     → Basic Auth → Knowledge-Management-API
    ├── /webhook/whatsapp → WhatsApp Cloud API Handler
    └── /chat        → WebSocketServer → agentHandler.js
                                              │
                              ┌───────────────┼───────────────┐
                              ▼               ▼               ▼
                         Supabase        OpenAI GPT-4o   Google Calendar
                       (pgvector)      (Chat + Embed)      (OAuth2)
                              │                               │
                           Redis                          Nodemailer
                        (Session Store)              (Bestätigungs-Mail)
```

### Channel-Architektur
```
Widget-User   → WSS → WebSocketServer → handleMessage() → Antwort → WS
WhatsApp-User → HTTPS Webhook → Express POST → handleMessage() → WhatsApp API
```

Beide Kanäle teilen dieselbe `handleMessage()`-Logik — unterschieden nur durch `channel: "widget"` oder `channel: "whatsapp"`.

---

## 4. Dateistruktur

```
/opt/agentic-rag/          (Produktionsserver)
/Desktop/Agentic-RAG/      (Entwicklung lokal)
│
├── server.js              Haupt-Server: Express + WebSocket + WhatsApp Webhook
│                          Injiziert Widget-Config aus .env in index.html
├── agentHandler.js        Kern-Logik: RAG, GPT-Agent, Booking State Machine
├── emailService.js        HTML-Bestätigungsmail via Nodemailer (SMTP)
├── ingestKnowledge.js     Wissens-Ingestion: Chunking, Embedding, Supabase-Upload
├── googleAuth.js          OAuth2-Flow für initiale Google-Token-Generierung
├── index.html             Chat-Widget (branding-neutral, Config via window.TH_ENV_CONFIG)
├── admin/upload.html      Admin-Interface für Wissensbasis-Management
├── supabase/schema.sql    Einmalig in Supabase ausführen → Tabelle + Suchfunktion
├── talkingHEADS_Wissensdatenbank.md  Vollständige Wissensbasis (lokal, nicht in Git)
├── Dockerfile             Node 22 Alpine Image
├── docker-compose.yml     Bot + eigener Redis-Container
├── .env.example           Vollständige Variablen-Vorlage (dokumentiert)
├── .dockerignore          Schützt .env und node_modules vor Image
├── .gitignore             Schützt .env, node_modules, docs
├── package.json           Dependencies + npm-Scripts
├── README.md              Kunden-Setup-Guide (Schritt für Schritt)
└── .env                   Secrets + Branding (nie in Git)
```

---

## 5. Kernkomponenten im Detail

### 5.1 agentHandler.js — Das Herzstück

**Agentic Loop (OpenAI tool_calls):**
```
User-Nachricht
    │
    ▼
GPT-4o mit 3 Tools:
  ├── search_knowledge_base(query) → Supabase RPC match_chunks
  ├── start_booking_flow()         → Startet State Machine
  └── escalate_to_human(reason)   → Eskalations-Log
    │
    ▼
Tool-Ergebnis zurück an GPT → Finale Antwort
```

**Booking State Machine (Code-Level, NICHT prompt-basiert):**
```
ask_time → ask_week → ask_week_part → show_slots → ask_name → ask_email → ask_phone → [BUCHUNG + MAIL]
```

Jeder Schritt wird im Code verarbeitet — GPT hat keine Kontrolle über den Ablauf. Einzige GPT-Aufgabe: `start_booking_flow` aufrufen wenn User "ja" zu einem Termin sagt.

**RAG-Ablauf:**
1. User-Frage → text-embedding-3-small → Embedding-Vektor
2. Supabase RPC `match_chunks(query_embedding, threshold=0.55, count=4)`
3. Top-K Chunks → Kontext für GPT
4. GPT antwortet **nur** auf Basis dieser Chunks

### 5.2 Booking-Flow im Detail

```
User: "Ich komme nicht weiter"
  → GPT: search_knowledge_base → antwortet mit Daten-Inhalten
  → GPT hängt an: "Soll ich dir gleich ein paar freie Termine zeigen?"
  → User: "ja"
  → GPT: start_booking_flow() → __START_BOOKING__ Signal
  → Code: bookingStep = "ask_time"

Schritt 1: "Lieber Vormittags (9-12 Uhr) oder Nachmittags (14-18 Uhr)?"
Schritt 2: "Diese Woche oder nächste Woche?"
Schritt 3: "Wochenanfang (Mo/Di) oder Wochenmitte (Mi/Do)?"
Schritt 4: Google Calendar freebusy API → 5 freie Slots
           "1. Montag, 02.06.2026, 10:00 Uhr
            2. Montag, 02.06.2026, 11:00 Uhr
            ..."
Schritt 5: "Wie ist dein vollständiger Name?"
Schritt 6: "Deine E-Mail-Adresse?"
Schritt 7: "Deine Handynummer?"
           → Google Calendar: Event anlegen
           → Nodemailer: HTML-Bestätigungsmail an Kunden
```

**Berlin-Timezone-Fix:**
```javascript
// Zuverlässig via en-CA locale (YYYY-MM-DD) + noon UTC Anker:
const todayStr = now.toLocaleDateString("en-CA", { timeZone: "Europe/Berlin" });
const todayNoon = new Date(todayStr + "T12:00:00Z");
```

### 5.3 System Prompt — STRICT RAG-Only

Unternehmensname kommt aus `process.env.COMPANY_NAME` — kein Hardcoding:

```
Du bist der KI-Assistent von ${COMPANY_NAME}. Du beantwortest ausschließlich
Fragen auf Basis der Wissensdatenbank.

WICHTIGSTE REGEL — KEIN EIGENES WISSEN:
- NIEMALS aus eigenem Trainingswissen antworten
- IMMER zuerst search_knowledge_base aufrufen
- Wenn DB nichts liefert: ehrlich sagen + Gespräch anbieten
- NIEMALS Inhalte erfinden
```

### 5.4 E-Mail-Bestätigung (emailService.js)

Nach erfolgreicher Buchung geht automatisch eine HTML-Mail an den Kunden:
- Fancy Template im talkingHEADS CI (blau/orange, responsive)
- Absender, Unternehmensname, Tagline, Website aus `.env`
- Link zum Google Calendar-Event
- "Was Dich erwartet"-Checkliste
- Wird nur versendet wenn `SMTP_HOST/USER/PASS` gesetzt sind (graceful skip)

### 5.5 White-Label-Architektur

```
.env → server.js liest COMPANY_NAME, AGENT_NAME, WIDGET_*
     → injiziert window.TH_ENV_CONFIG in index.html beim Serving
     → Widget zeigt korrekten Namen/Farben ohne Code-Änderung

.env → agentHandler.js liest COMPANY_NAME
     → System Prompt nennt korrektes Unternehmen

.env → emailService.js liest COMPANY_NAME, COMPANY_TAGLINE, COMPANY_WEBSITE
     → Mail-Template mit korrektem Branding
```

**Für einen neuen Kunden:** Repo klonen → `.env` befüllen → `docker compose up`. Fertig.

### 5.6 Session Management (Redis)
- Key: `session:{sessionId}` (z.B. `session:widget_abc123`)
- TTL: 86400 Sekunden (24 Stunden)
- Max. 24 Nachrichten pro Session
- Gespeichert: `messages[]`, `bookingStep`, `bookingPrefs`, `selectedSlot`, `bookingData`, `availableSlots`

---

## 6. Wissensdatenbank

### Aufbau
- Datei: `talkingHEADS_Wissensdatenbank.md`
- Inhalt: Alle 5 TalkingHEADS-Domains gescrapt (talkingheads.business, talkingheads.consulting, talkingheads.academy, sell-as-hell.online, get-shit-done.online)
- Chunk-Größe: 800 Zeichen, 150 Zeichen Overlap
- Embedding-Dimension: 1536 (text-embedding-3-small)

### Supabase Schema
Vollständig in `supabase/schema.sql` — einmalig im SQL Editor ausführen:

```sql
create extension if not exists vector;

create table knowledge_chunks (
  id         bigserial primary key,
  content    text not null,
  embedding  vector(1536),
  metadata   jsonb,  -- { source, category, chunk_index }
  created_at timestamptz default now()
);

-- HNSW-Index für schnelle Cosine-Suche
create index knowledge_chunks_embedding_idx
  on knowledge_chunks using hnsw (embedding vector_cosine_ops);

-- Suchfunktion
create or replace function match_chunks(
  query_embedding vector(1536),
  match_threshold float default 0.55,
  match_count     int   default 4
) returns table (id bigint, content text, metadata jsonb, similarity float)
```

### Admin-Interface
URL: `https://chat.diebestenberatungsagenturen.de/admin`
Passwort: `ADMIN_PASSWORD` aus `.env`
Features:
- Drag & Drop Upload (.txt, .md)
- Kategorie-Auswahl
- Chunk-Statistik (pro Quelle)
- Gesamte Wissensbasis löschen

---

## 7. Deployment

### Infrastruktur
- **Server:** Strato Cloud Server, Ubuntu 24.04 LTS, IP: `212.227.82.29`
- **Domain-Verwaltung:** Hetzner DNS (Registrar: United Domains → Transfer zu Hetzner angeschoben)
- **Reverse Proxy:** Caddy (systemd service, Auto-HTTPS via Let's Encrypt)
- **Container:** Docker Compose in `/opt/agentic-rag/`

### Caddyfile (`/etc/caddy/Caddyfile`)
```
n8n.diebestenberatungsagenturen.de {
    reverse_proxy 127.0.0.1:5678
}

chat.diebestenberatungsagenturen.de {
    reverse_proxy localhost:3000
}
```

### docker-compose.yml
```yaml
services:
  bot:
    build: .         # Node 22 Alpine
    ports:
      - "127.0.0.1:3000:3000"
    env_file: .env
    environment:
      REDIS_URL: redis://redis:6379
    restart: unless-stopped
    depends_on:
      - redis

  redis:
    image: redis:alpine
    restart: unless-stopped
    volumes:
      - redis_data:/data
```

### DNS-Einträge (Hetzner)
| Typ | Name | Wert |
|---|---|---|
| A | chat | 212.227.82.29 |
| A | n8n | 212.227.82.29 |

**Wichtig:** Kein AAAA-Record für `chat` — führte zu SSL-Fehler (Strato Wildcard-Cert `*.your-server.de` wurde via IPv6 ausgeliefert).

### Update-Prozess
```bash
# Lokal:
git add . && git commit -m "..." && git push

# Auf Server:
cd /opt/agentic-rag
git pull
docker compose up -d --build

# Nur .env geändert (kein Code-Update):
scp .env root@212.227.82.29:/opt/agentic-rag/.env
ssh root@212.227.82.29 "cd /opt/agentic-rag && docker compose restart bot"
```

---

## 8. Environment Variables (`.env`)

Vollständige Vorlage in `.env.example`. Die wichtigsten Gruppen:

```env
# Branding (White-Label — steuert Widget, System Prompt und E-Mail-Template)
COMPANY_NAME=talkingHEADS
AGENT_NAME=talkingHEADS Assistent
COMPANY_TAGLINE=Digital Marketing
COMPANY_WEBSITE=https://talkingheads.business
WIDGET_PRIMARY_COLOR=#0E51A0
WIDGET_ACCENT_COLOR=#EA9413

# OpenAI
OPENAI_API_KEY=sk-...

# Supabase
SUPABASE_URL=https://xyz.supabase.co
SUPABASE_SERVICE_KEY=eyJ...

# Google Calendar
GOOGLE_CLIENT_ID=...apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-...
GOOGLE_REFRESH_TOKEN=1//...
GOOGLE_REDIRECT_URI=http://localhost:3001/oauth2callback
GOOGLE_CALENDAR_ID=primary

# E-Mail (Terminbestätigung)
SMTP_HOST=smtp.provider.de
SMTP_PORT=587
SMTP_USER=bot@talkingheads.business
SMTP_PASS=...

# WhatsApp (Meta Cloud API)
WHATSAPP_TOKEN=...
WHATSAPP_PHONE_ID=...
WHATSAPP_VERIFY_TOKEN=...

# Admin
ADMIN_PASSWORD=...

# Redis (automatisch gesetzt via Docker Compose)
REDIS_URL=redis://redis:6379

# Port
PORT=3000
```

---

## 9. Gelöste Probleme & Lessons Learned

| Problem | Ursache | Lösung |
|---|---|---|
| Bot nutzte GPT-Wissen statt DB | System Prompt zu weich | Striktes "KEIN EIGENES WISSEN" Prompt |
| Terminbuchung zu früh | GPT ignorierte Prompt-Regeln | Code-Level State Machine statt Prompt-Logik |
| Booking sofort getriggert | GPT zu aggressiv mit Tool-Call | Zweistufige `bookingOffered`-Guard → vereinfacht zu Prompt-Instruction |
| Falsches Jahr 2023 bei Buchung | GPT rekonstruierte ISO aus Label ohne Jahr | Slot-Labels mit Jahr + noon-UTC-Anker für Berlin-Timezone |
| Bot stellte alle 3 Buchungsfragen auf einmal | Prompt-basierter Flow | State Machine in Code: ein Schritt pro Antwort |
| Bot bot keine Termine mehr an | `bookingOffered`-Guard zu restriktiv | Guard entfernt, GPT fügt Angebot als Text an |
| Begrüßung erschien nicht | WS-Verbindung noch nicht offen beim Panel-Open | Begrüßung beim ersten Panel-Klick statt in `ws.onopen` |
| `Cannot find package 'express'` | `npm install` vergessen | `npm install` |
| `.env` nicht geladen | `dotenv` Paket fehlte | `node --env-file=.env` Flag (kein Paket nötig) |
| Widget-Button kein Effekt | `<div id="th-typing">` fehlte im HTML → JS-Crash | Element hinzugefügt |
| `Cannot GET /` | Keine Route für Root | `app.get("/", ...)` hinzugefügt |
| Google OAuth `redirect_uri_mismatch` | Callback-URL nicht in Google Console hinterlegt | `http://localhost:3001/oauth2callback` hinzugefügt |
| `invalid_client` bei OAuth | CLIENT_SECRET = CLIENT_ID verwechselt | Korrektes Secret aus Google Console |
| Node 20 WebSocket-Fehler in Docker | Supabase Realtime braucht native WS | Node 22 im Dockerfile |
| SSL `ERR_CERT_COMMON_NAME_INVALID` | Browser verbindet via IPv6 → Strato Wildcard-Cert | AAAA-Record aus Hetzner DNS gelöscht |
| WebSocket-Button mobil kein Effekt | `ws://localhost:3000/chat` hardcoded | Dynamische URL: `(wss/ws)://${location.host}/chat` |
| Git push blockiert | OAuth-JSON-Datei mit Credentials im Repo | `git rm --cached` + `.gitignore` + force push |

---

## 10. Noch ausstehend / Nächste Schritte

### Domain-Transfer: United Domains → Hetzner
**Status:** Transfer angeschoben (Stand: 01.06.2026)

Aktuell: Domains bei **United Domains** registriert, DNS bereits bei **Hetzner** verwaltet. Transfer übergibt auch die Registrierung zu Hetzner — übersichtlicher, günstigere Verlängerung, bessere API.

- [ ] **Auth-Code (EPP-Key)** bei United Domains anfordern (Kundenkonto → Domain → Transfer)
- [ ] **Transfer-Sperre aufheben** bei United Domains (falls aktiv)
- [ ] **Auth-Code bei Hetzner eingeben** — Hetzner Robot → Domains → Domain hinzufügen
- [ ] **Bestätigungs-E-Mail** vom bisherigen Registrar bestätigen
- [ ] **Transfer-Status prüfen** — dauert typisch 5–7 Werktage
- [ ] Nach Abschluss: DNS-Einträge prüfen (A-Records für `chat` und `n8n` müssen erhalten bleiben)
- [ ] **Kein AAAA-Record für `chat`** setzen (SSL-Fehler via IPv6)
- [ ] SMTP-Zugangsdaten in `.env` aktualisieren falls E-Mail-Hosting ebenfalls umzieht

> **Wichtig:** Während des Transfers bleibt die Domain voll funktionsfähig — keine Downtime.

### Offene Punkte

- [ ] **SMTP konfigurieren** — `.env` auf Server: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` eintragen → Bestätigungs-E-Mail nach Buchung aktiv
- [ ] **WhatsApp Webhook** — Warte auf Meta-Verifizierung der Nummer. Danach: Meta Developer Console → Webhook-URL `https://chat.diebestenberatungsagenturen.de/webhook/whatsapp` + Verify Token eintragen + `messages` subscriben
- [ ] **Widget-Embed** — Widget-Code auf talkingheads.business / andere Domains einbetten (`WIDGET_ORIGIN` in `.env` setzen)
- [ ] **Wissensdatenbank erweitern** — Weitere Dokumente über Admin-Interface hochladen
- [ ] **Monitoring** — `docker compose logs -f bot` oder Tool wie Grafana/Loki
- [ ] **Backups** — Redis Volume `agentic-rag_redis_data` regelmäßig sichern

---

## 11. Wichtige URLs

| Zweck | URL |
|---|---|
| Chat-Widget (Prod) | https://chat.diebestenberatungsagenturen.de |
| Admin-Interface | https://chat.diebestenberatungsagenturen.de/admin |
| WhatsApp Webhook | https://chat.diebestenberatungsagenturen.de/webhook/whatsapp |
| GitHub Repository | https://github.com/talkingHEADS26/agentic-rag |
| Supabase Dashboard | https://supabase.com/dashboard |
| Google Cloud Console | https://console.cloud.google.com |
| n8n (gleicher Server) | https://n8n.diebestenberatungsagenturen.de |

---

## 12. Produkt-Vertrieb (White-Label)

Der Bot ist vollständig white-label-fähig. Für einen neuen Kunden:

**Infrastruktur-Empfehlung:** Hetzner CX22 (~4€/Monat), Ubuntu 24.04, Docker

**Was der Kunde selbst einrichtet:**
1. Supabase-Projekt anlegen → `supabase/schema.sql` ausführen
2. OpenAI API Key
3. Google Cloud Project → Calendar API → OAuth2 → `node googleAuth.js`
4. E-Mail-SMTP-Zugangsdaten

**Was als Setup-Service gemacht wird:**
1. Repo auf Hetzner deployen
2. `.env` befüllen (Branding + alle API-Keys)
3. Caddy + DNS konfigurieren
4. Wissensdatenbank über Admin-Interface befüllen
5. Widget-Code auf Kundenwebsite einbetten

**Kein Code anfassen** — alles läuft über `.env`.

---

## 13. Server-Management Cheat Sheet

```bash
# SSH
ssh root@212.227.82.29

# Bot-Status
cd /opt/agentic-rag
docker compose ps
docker compose logs -f bot

# Bot neustarten
docker compose restart bot

# Update deployen (Code)
git pull && docker compose up -d --build

# Nur .env aktualisiert
scp .env root@212.227.82.29:/opt/agentic-rag/.env
docker compose restart bot

# Redis leeren (Sessions zurücksetzen)
docker exec -it agentic-rag-redis-1 redis-cli FLUSHDB

# Caddy neustarten
systemctl restart caddy

# Logs Caddy
journalctl -u caddy -f
```
