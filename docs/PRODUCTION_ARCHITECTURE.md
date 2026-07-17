# VCUF Secretary / Emma — produkční architektura

Tento dokument je závazný produkční směr od 17. července 2026. Vychází z
aktualizovaného návrhu produktu a doplňuje stávající implementaci; neruší již
fungující business logiku, audit ani ověřená pravidla Emmy.

## Produktový kontrakt

Emma je hlasový asistent integrovaný do business platformy. Web je plná
pracovní plocha; mobil slouží především pro hlasové rychlé akce, upozornění a
práci na cestách. Zdroj pravdy pro operace zůstává společný backend.

Následující vlastnosti jsou regresní brány pro každou změnu:

- jediná viditelná a ovladatelná relace Emmy;
- uložený jazyk uživatele řídí rozhraní, rozpoznávání, odpovědi i syntézu řeči;
- mikrofon zůstává k dispozici při řeči Emmy, ale její přehrávání nesmí být
  rozpoznáno jako uživatel;
- žádný zápis, odeslání nebo smazání se nesmí hlásit jako úspěšné bez potvrzení
  autoritativní business služby;
- zvuk mikrofonu se neukládá; ukládá se pouze textový přepis konverzace;
- všechny hlasové akce se odvozují z jednotného katalogu menu a Action Contracts
  a podléhají oprávněním administrátora.

## Cílové rozdělení odpovědností

```
Webová pracovní plocha / mobilní klient
                  │  HTTPS + WebSocket
                  ▼
       Emma Voice Orchestrator (session, language, tools, memory)
                  │
                  ▼
Stávající Secretary business API (práva, validace, audit, data, konektory)
                  │
       ┌──────────┴──────────┐
       ▼                     ▼
PostgreSQL + pgvector      Redis
trvalá data a paměť       krátkodobý stav relace
```

Business API zůstává jediným místem, které může měnit klienty, kontakty,
e-maily, WhatsApp, kalendář, nabídky a ostatní firemní data. Orchestrátor nikdy
nezapisuje přímo do databáze: použije pouze ověřený tool/API kontrakt a obdrží
strukturovaný výsledek.

## Technologie a postup migrace

Stávající Node.js/Express + Prisma + PostgreSQL a React/Vite PWA nejsou
překážkou produkčního cíle. Obsahují reálná data, validace, oprávnění, audit,
katalog menu a Android/Capacitor klient. Jejich jednorázový přepis na
FastAPI/Next.js/Flutter by bez přínosu ohrozil funkční operace.

Proto se postupuje po vrstvách:

1. **Business jádro zůstává.** Node API a Prisma zůstávají autoritativní pro
   data, Action Contracts, práva, audit a konektory. PostgreSQL musí být
   připravené pro Neon a rozšíření `pgvector`.
2. **Emma Voice Orchestrator se přidává jako oddělená služba.** Cílová
   implementace je FastAPI + LangGraph, komunikující se Secretary přes
   verzované HTTP/WebSocket tool kontrakty. Dokud není nasazen, existující
   Realtime adaptér zůstává funkčním přechodovým řešením.
3. **Poskytovatelé hlasu jsou nahraditelní adaptéry.** Produkční výchozí volby
   jsou Porcupine pro lokální wake word, Deepgram Nova-3 pro STT a ElevenLabs
   Turbo nebo Cartesia pro streamované TTS. Žádný z nich nesmí být natvrdo
   zabudován do business logiky ani aktivován bez vlastního klíče a testu.
4. **Web se migruje na Next.js až při splnění parity.** Do té doby React/Vite
   zůstává produkční webový klient. Přepis je přípustný pouze po automatické
   kontrole stejného menu, jazyků, oprávnění a hlasových akcí.
5. **Mobil se přidává ve Flutteru po zafixování API kontraktů.** Současná PWA
   a Capacitor Android aplikace zůstávají testovacím klientem. Flutter sdílí
   autentizaci, stav jazyka, WebSocket události a tool/API kontrakty; nenese
   vlastní business logiku. iOS používá push-to-talk jako výchozí režim.

## Hlasové chování

- Wake word je lokální a konfigurovatelné, výchozí hodnota je `Emma`.
- Web může běžet v kontinuálním režimu. Android může nabídnout background režim
  v mezích systému. iOS používá push-to-talk, pokud systém nedovolí spolehlivý
  background režim.
- STT určí jazyk pro aktuální tah. Tool `change_language` pak atomicky uloží
  jazyk relace a uživatele a obnoví webové i mobilní UI ve stejném jazyce.
- Přerušení je full-duplex: lokální přehrávání se po ověřeném uživatelském
  vstupu zastaví, aktivní odpověď se zruší a neodehraný výstup se ořízne.
- Orchestrátor smí zahájit akci jen přes deklarovaný tool. U rizikových nebo
  externích akcí zachová potvrzovací pravidla Action Contractu.

## Paměť

- **Krátkodobá:** Redis/Upstash — relace, aktuální jazyk, kontext stránky,
  rozpracovaná potvrzení a poslední tahy.
- **Dlouhodobá:** PostgreSQL/Neon + pgvector — explicitně uložená fakta,
  preference, schválené pracovní postupy a relevantní vyhledatelný kontext.
- `remember_fact` ukládá explicitně požadovanou informaci se zdrojem, vlastníkem
  firmy, viditelností a auditním záznamem. Automatický výběr do paměti musí být
  konzervativní a nikdy nesmí ukládat mikrofonní audio.

## Povinné tooly první produkční verze

| Tool | Závazek |
| --- | --- |
| `navigate_to` / `perform_menu_action` | Kompletní zrcadlo menu a podmenu, pouze povolené cesty a operace. |
| `create_contact` | Validuje e-mail a telefon, nezapíše neplatná data jako úspěch. |
| `send_email` / `send_whatsapp` | Používá existující konektor, oprávnění a potvrzovací tok. |
| `change_language` | Změní jazyk odpovědi, STT/TTS, relace a UI společně. |
| `remember_fact` | Zapíše výslovně potvrzené trvalé pravidlo. |
| `get_current_context` | Vrací aktuální stránku, firmu, oprávnění a bezpečný pracovní kontext. |

## Dodávací fáze a akceptace

### Fáze 1 — stabilní webové MVP

Plné menu, Action Contracts, jednotný jazyk CS/EN, jedna hlasová relace,
viditelné přepisy, wake word, nástroje pro navigaci a základní akce. Každé
vydání projde testem jazykové konzistence, jedné relace, přerušení bez ozvěny a
potvrzených výsledků akcí.

### Fáze 2 — orchestrátor a paměť

FastAPI/LangGraph sidecar, provider adaptéry, Redis pro session, pgvector pro
dlouhodobou paměť a přesně auditovaný `remember_fact`. Přechod nesmí změnit
žádnou veřejnou Action Contract ani business validaci.

### Fáze 3 — mobil a škálování

Flutter klient se sdílenou autentizací, jazykem, WebSocket stavem a
push-to-talk. Následně škálování hostingu, metriky kvality hlasu, minutové
limity a účtování.

## Provozní rozhodnutí

Neon, Upstash, Deepgram, ElevenLabs/Cartesia a externí komunikační služby se
aktivují až po dodání příslušných produkčních přístupů. Hosting lze přesunout z
Railway na Render nebo Coolify + Hetzner samostatným infrastrukturním krokem;
nesmí být součástí změny hlasové logiky.
