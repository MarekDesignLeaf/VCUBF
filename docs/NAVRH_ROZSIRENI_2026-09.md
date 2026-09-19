# Návrh rozšíření VCUBF Secretary — září 2026

Vychází z úplného průchodu dokumentace (app `README.md` + `docs/`, C:\VCUBF
Engineering Bible v10 a externí v7 review) a kódu (backend 34 route skupin,
50 Prisma modelů, 135 Action Contracts, 73 testovacích sad, frontend ~40
stránek, Voice v2, 6 konektorů). Priorita je řazena podle poměru
hodnota / riziko / pracnost a podle toho, co si dokumentace sama označuje za
mezeru.

## Priorita 1 — dokončit rozdělané smyčky (nejvyšší denní hodnota)

1. **Odeslání nabídky a faktury e-mailem — HOTOVO (18. 9. 2026).**
   Quote i Invoice už mají PDF export a Gmail už umí potvrzené odeslání —
   chybí jen spojení: akce `send_quote_pdf` / `send_invoice_pdf` (risk 3,
   confirmationRequired, náhled příjemce + předmětu + přílohy), která připojí
   vygenerované PDF k potvrzenému `send_gmail_message`. Stav nabídky `sent`
   by pak odpovídal skutečnému odeslání, dnes je jen interní záznam.
2. **Push doručování notifikací — HOTOVO (denní e-mailový digest).** Feed má 11 zdrojů, ale je pull-only.
   Nejmenší bezpečný krok: denní e-mailový digest přes potvrzený Gmail zdroj
   (nová akce `send_notification_digest`, risk 3, náhled před odesláním) a
   volitelně WhatsApp šablona pro `urgent` položky. Nic se neposílá bez
   explicitního zapnutí per-user.
3. **Un-merge / reaktivace klienta — HOTOVO.** README výslovně uvádí, že sloučení
   klientů nejde vrátit. Merge už ukládá before/after audit — stačí uložit
   snapshot přemapovaných FK do vlastní tabulky `ClientMergeRecord` a přidat
   potvrzovanou akci `unmerge_clients` (risk 3), která vrátí FK a `isActive`.
4. **KPI čte faktury — HOTOVO.** Modul faktur a plateb existuje, ale
   `metricsService` ho nečte (pole `unavailableMetrics.unpaidInvoices`).
   Doplnit skutečný obrat z vydaných faktur, neuhrazené saldo, DSO a srovnání
   fakturace s přijatou hodnotou nabídek — vše jen z reálných záznamů.
5. **Gmail push (watch/Pub-Sub) místo 5min pollingu** + ingest metadat
   příloh (bez stahování bajtů, stejný vzor jako Drive/Photos picker).

### Co bylo 18. 9. 2026 doprogramováno

- `send_quote_pdf` / `send_invoice_pdf` (risk 3, potvrzované): PDF se vykreslí
  z uložených dat, připojí jako `multipart/mixed` příloha a odešle přes
  autorizovaný firemní Gmail; po potvrzení poskytovatelem se koncept nabídky
  změní na „sent“, faktuře se stav nemění a obojí zapíše odchozí komunikaci.
  Koncept faktury odeslat nelze a příjemce se nikdy nehádá.
- `send_notification_digest` + `update_notification_digest_preferences`: denní
  textový souhrn vlastního feedu na vlastní účtový e-mail, per-user opt-in,
  ruční odeslání s náhledem a denní automatický sweep v existujícím časovači.
- `unmerge_clients` + model `ClientMergeRecord`: snapshot přesměrovaných ID,
  zpětné přemapování jen těch záznamů, které stále patří ponechanému klientovi,
  obnovení původního stavu duplikátu a report toho, co vrátit nelze. Merge nově
  přemapuje i faktury.
- Fakturační KPI v `GET /metrics/overview` (vystaveno, přijaté platby, saldo a
  po splatnosti ke konci období, průměrná doba úhrady) + sekce na stránce
  Business Metrics.
- Prahy notifikací per firma (`Company` → Notification thresholds) s výchozími
  hodnotami, mezemi a auditem změny.
- Vše je pokryto testy (73 souborů / 601 testů, celá sada zelená) a promítnuto
  do katalogu menu i znalostní báze Emmy v osmi jazycích.

## Priorita 2 — architektura podle PRODUCTION_ARCHITECTURE.md

6. **Emma Voice Orchestrator (FastAPI + LangGraph) jako oddělená služba** s
   verzovanými tool kontrakty proti stávajícímu API; Realtime adaptér zůstává
   fallbackem. Předpoklad: zafixovat tool katalog (dnes
   `emmaExecutableActionCatalogue.ts`) jako verzované JSON schéma.
7. **Paměť: pgvector + Redis.** `AssistantMemory` povýšit na dlouhodobou
   paměť s embeddingy (PostgreSQL + pgvector, připraveno pro Neon); Redis /
   Upstash pro krátkodobý stav relace. `remember_fact` už fakticky existuje
   („remember that…“) — doplnit zdroj, viditelnost a vektorové vyhledávání.
8. **Denní plánovací mřížka.** Kapacita je týdenní; dalším krokem je denní
   agenda s cestovním časem (mapový konektor), vícedenními etapami a
   rezervací zdrojů — JobResourceRequirement už dává stavy připravenosti.
9. **Konfigurovatelné prahy per firma — HOTOVO.** `STALE_LEAD_THRESHOLD_DAYS`,
   `STUCK_JOB_THRESHOLD_DAYS`, okno oznámení nabídek atd. přesunout z konstant
   do CompanySettings (s auditem změny a bezpečnými výchozími hodnotami).
10. **Playbooky s větvením a delšími vzory.** Memory Model detekuje jen
    dvojice akcí; rozšířit na delší sekvence a v playboocích povolit
    podmíněný krok na výsledku předchozího (stále stop-on-failure, stále
    potvrzovaný náhled).

## Priorita 3 — produktová expanze

11. **Klientský portál** (schválení nabídky online, stav zakázky, platba) —
    architektura §30; začít read-only odkazem s podpisem a expirací.
12. **Website publishing konektor** — schválené návrhy obsahu dnes nemohou
    opustit Secretary; první cíl: export schváleného návrhu + risk-4
    publikační akce s post-publikační verifikací (architektura §16, audit).
13. **Účetní export** (Xero/QuickBooks) navázaný na vydané faktury a platby.
14. **SMS a job-board konektory** (nábor má drafty inzerátů bez kanálu).
15. **Flutter mobilní klient** až po zafixování API kontraktů (fáze 3);
    do té doby zůstává PWA + Capacitor.

## Governance / dluh (levné, ale důležité)

16. **Foundation větev — HOTOVO/ověřeno.** Foundation v1.4 už obsahuje všechny
    opravy z v7 review (D19–D30); 17. 9. 2026 z čistého rozbalení 57/57 testů
    a 54/54 statických gate. Staré verze přesunuty do `C:\VCUBF\docs\_superseded`.
    Zbývá jen živá DB sada `npm run verify:db` proti PostgreSQL 18.
17. **Úklid — HOTOVO částečně.** Zálohy `*.before-*` přesunuty ze `src/` do
    `C:\VCUBF\_archive`, 115 jednorázových skriptů archivováno, prázdné
    scaffold složky smazány. Zbývá na tobě: roztřídit a commitnout ~150
    necommitnutých změn v gitu (obsahově je nerozhoduji za tebe).
18. **Kontrola driftu dokumentace — HOTOVO.** `backend/tests/docsDrift.test.ts`
    přepočítá route skupiny, Prisma modely, Action Contracts, oprávnění a
    testovací sady a selže, když se liší od sekce „Current snapshot“ v README.

## Co záměrně nenavrhuji

Automatické akce bez potvrzení (platby, publikace, nábor), ukládání audia,
inference faktů modelem do CRM a přepis funkčního Node jádra na jiný stack —
vše by porušilo platná pravidla projektu (deterministické jádro, non-invention,
potvrzování rizikových akcí).
