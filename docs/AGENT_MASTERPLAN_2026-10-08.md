# VCUBF Secretary — Masterdokument přechodu na agentní správu

**Verze 1.1 — 8. 10. 2026 — stav: platný. Rozhodnutí D1–D6 přijata 8. 10. 2026 (Marek rozhodnutí delegoval).** Toto je autoritativní kopie, verzovaná s kódem; změny jdou přes PR. Kopie v projektu Claude (`claude/masterdokument-agentni-sprava-2026-10-08.md`) je zrcadlo.

Tento dokument přebírá všechny plánované funkce z popisu projektu VCUBF Secretary (§1–§75) a říká, jak každou z nich dodá agentní model. Je podřízen CLAUDE.md: Marek slučuje PR, nic funkčního se nerozbíjí, nic není hotové bez živé akceptace, žádná změna konfigurace Railway bez souhlasu.

Řídicí zásada celého přechodu: **agenti se mění, jádro ne.** Inteligence smí být kdykoli vyměněna, zpřesněna nebo vypnuta; data, oprávnění, audit a potvrzování zůstávají v deterministickém jádru, které existuje už dnes. Proto se přechod dá provést bez jediného dne výpadku tří hlavních funkcí (kalendář, e-mail, WhatsApp).

---

## 1. Ověřený výchozí stav (master `b6f681e`, 8. 10. 2026)

**Co už stojí a agenti to zdědí beze změny:**

| Vrstva | Stav v kódu |
|---|---|
| Popsané akce | 143 Action Contracts s rizikem a oprávněním (`actionContracts.ts`) |
| Hlasově spustitelné akce | ~80 akcí se Zod schématy (`voiceActionCatalogue.ts`), firemní vypínače per schopnost (`EMMA_CAPABILITIES`, stránky + akce + příkazy) |
| Potvrzování | náhled → „ano/ne“ → provedení, `VoicePendingAction` s expirací a převzetím (claim) |
| Audit | kdo, co, vstup, výsledek, riziko; otisk obsahu u odeslání |
| Idempotence | middleware + claim-based provedení; neznámý výsledek se nezdvojí |
| Oddělení firem | `companyId` na každém business řádku |
| Jazyky | pevná gramatika per jazyk, jen zapnutý jazyk se čte; angličtina = interní formát |
| Konektory | Gmail ×2, Calendar čtení+zápis, WhatsApp, Contacts, Drive; synchronizace na pozadí à 5 min |
| Data (Digital Twin v zárodku) | 52 Prisma modelů: klienti, poptávky, zakázky, úkoly, nabídky, faktury+platby, kapacita, nábor, portfolio, dokumenty, komunikace, playbooky, paměť, učení |
| Učení | aliasy, naučené příkazy, pravidla, scénář chování (podřízený bezpečnosti) |

**Co chybí (a tento dokument dodává):** ~~brána modelů~~ (dodána, PR #32), ~~verzovaný katalog nástrojů~~ (dodán, F0.2), jeden vykonávací engine (potvrzování má dnes 7 kopií), agentní smyčka, stínový režim, Control Tower, události + dlouhé procesy, oddělené predikce, simulátor rozhodnutí.

**AI dnes:** 5 volání OpenAI (porozumění, přepis, hlas, překlad, starý realtime), od PR #32 všechna přes Model Gateway. Jeden model, jedno volání na požadavek, model nic neprovádí.

---

## 2. Slepé uličky

### 2.1 Existující — nestavět na nich

| Co | Verdikt |
|---|---|
| `Secretary_Server`, `Secretary_Android` | jen referenční materiál (CLAUDE.md) |
| Python Windows companion (`emma_voice_v2.py` a spol.) | legacy; hlas žije v okně Secretary; neopravovat, neportovat do agentů. Jeho přímé volání OpenAI TTS se do brány nepřevádí — běží na uživatelově PC mimo backend a u Marka je zastavený |
| Realtime adaptér | přechodový zvukový kanál; **nikdy ne orchestrátor** |
| `VoiceControlCenter.tsx` | nikde se nevykresluje; nerozšiřovat |
| Starý lokální panel (`C:\VCUBF\vcubf-panel.ps1`) | nahrazen panelem pro Railway (#31) |
| PR #1 (reconcile, 20. 9.) | zastaralý; cíle přebírá F0 tohoto dokumentu. Rozhodnuto zavřít (D6); zavření klikne Marek |
| 7 kopií potvrzování (`voicePendingAction` v 7 souborech) | hlavní technický dluh; konsoliduje F0 |

### 2.2 Budoucí — čemu se tento plán záměrně vyhýbá

1. **FastAPI + LangGraph jako druhá služba.** Druhý jazyk, druhý deploy, duplikace oprávnění, auditu a tenant izolace přes síťovou hranici. Agenti patří **do stávajícího backendu jako TypeScript modul** — stejné transakce, stejné testy, stejné CI. (Rozhodnuto, D1; `PRODUCTION_ARCHITECTURE.md` upraven.)
2. **Přepis webu na Next.js a mobil ve Flutteru.** Odkládá se za agentní jádro; parita menu/jazyků/oprávnění je podmínkou, která dnes nejde splnit levně. Capacitor Android zůstává.
3. **Temporal a NATS JetStream od prvního dne.** Dlouhé procesy začnou tabulkou v PostgreSQL + stávajícím plánovačem (transactional outbox). Temporal až při prokázané potřebě. §71 to připouští — „exact implementation remains subject to controlled architectural decisions“.
4. **Další ručně stavěné LLM cesty** (vzor `voiceGmailService`). Vzor se zmrazuje; každá nová schopnost = nástroj v katalogu + engine, ne nová služba s vlastním potvrzováním.
5. **Model, který sám vykonává.** Nikdy. Model navrhuje, engine vykonává (§4, §42).
6. **Agenti jako viditelné osoby.** Uživatel mluví s Alfonzem; specialisté jsou vnitřní role (§6).
7. **pgvector a embeddingy předčasně.** Vektorové hledání až od objemu, který ho ospravedlní (F6).
8. **Hlasová biometrie a Team Session před základem.** §10–11 až po F4; mikrofonní pipeline se kvůli agentům nemění (pravidlo: žádné vypínače mikrofonu).

---

## 3. Cílový model

Jeden požadavek, ať přijde hlasem, textem, z webu, telefonu nebo e-mailem, projde **vždy stejnou rourou** (§5). Nic ji nesmí obejít — ani agent, ani konektor, ani budoucí externí agent.

```
VSTUP ──► POROZUMĚNÍ ──► KONTEXT ──► PLÁN ──► KOORDINACE AGENTŮ
(kanál,    (parser první,   (nástroje   (model   (orchestrátor +
 identita,  model druhý)     pro čtení)  přes     specialisté,
 jazyk)                                  bránu)   jen návrhy)
                                                      │
AUDIT ◄── OVĚŘENÍ ◄── PROVEDENÍ ◄── „ANO“ ◄── KONTRAKT + RIZIKO
(vždy)    (výsledek    (engine,      (vázané    (Action Contract,
           nastal?)     idempotence)  na otisk)  oprávnění, politika)
   │
   └──► UČENÍ (aliasy, playbooky, stínová porovnání)
```

### Vrstvy (odspodu)

**A. Deterministické jádro** — existuje. Roste jen o **Execution Engine**: jediné místo, kudy projde každý zápis a každá externí akce. Validace → oprávnění → firemní politika → riziko → náhled → „ano“ → převzetí → provedení s idempotencí → ověření → audit. Neznámý výsledek (§44) je stav, ne výjimka: záznam `outcome: unknown` + smírčí úloha.

**B. Katalog nástrojů v1** — verzované JSON Schema vygenerované ze stávajících Zod schémat. Každý nástroj nese: `read|write`, riziko 0–4, požadované oprávnění, firemní vypínač, verzi. Test parity: každá akce má nástroj, nebo zapsaný důvod, proč ne (dnes 21 výjimek typu hesla a OAuth — zůstávají výjimkami).

**C. Brána modelů (Model Gateway, §7)** — **dodána 8. 10. 2026 (PR #32, `backend/src/lib/modelGateway.ts`).** Všech 5 volání AI + budoucí agentní smyčka jde jedním místem. Tabulka úloha→model; běhový log nese úlohu, model, výsledek, trvání a tokeny; cena na běh přibude v auditu s `AgentRun` (F1). Poskytovatelé jako adaptéry; výchozí OpenAI, další jen po dodání klíče (D3).

**D. Agentní runtime** — TypeScript modul `backend/src/agents/`:
- **Orchestrátor:** rozloží záměr, vybere specialisty, složí jeden návrh. Limity běhu: max. kroků, max. čas, strop ceny (D5).
- **Specialista = role, ne proces:** systémový pokyn + podmnožina nástrojů + rozpočet (§6). Smyčka: nástroje pro čtení se provedou hned (s oprávněními volajícího uživatele), nástroje pro zápis se jen **sbírají do návrhu**.
- **Žádný agent nevidí cizí firmu:** nástroje běží pod uživatelovou identitou, tenant klíč platí i pro ně.

**E. Návrh a vázané schválení (§40–41)** — návrh = seznam kontraktů s otiskem obsahu. Jedno „ano“ schválí přesně tento otisk; změna návrhu otisk zneplatní. Alfonzo přečte celé shrnutí; u opakování řekne „přesně tohle jsem už odeslal…“.

**F. Události a dlouhé procesy (§50–51)** — tabulky `DomainEvent` (outbox, zapisované ve stejné transakci jako změna) a `WorkflowRun` (stav, čeká-na: schválení / platba / datum / odpověď / člověk). Pohání je stávající plánovač na pozadí; proces přežije restart.

**G. Stínový režim, kanárek, rollback (§59–61)** — tabulka `AgentRun` (kroky, nástroje, model, cena, výsledek; **bez textů zpráv** — jen odkazy a otisky; D4). Stín běží na skutečném provozu a nic neprovádí. Zapnutí per firma vypínačem; vypnutí = okamžitý návrat na starou cestu, která se nemaže, dokud agent neprojde živou akceptací.

**H. Nouzové zastavení (§49)** — firemní přepínač `safe_mode`: engine odmítá všechny zapisující a externí nástroje, čtení a audit běží. Nastavuje jen administrátor; agent na něj nástroj nemá.

**I. Control Tower (§57)** — stránka `/agents` nad `AgentRun` + auditem: běhy, kroky, model, cena, čekající schválení, chyby, vypínače.

**J. Paměť a Digital Twin (§3, §56)** — Twin = stávající Prisma data zpřístupněná čtecími nástroji; operační graf nejdřív jako SQL pohledy nad existujícími vztahy. `AssistantMemory` zůstává explicitní pamětí; pgvector až F6.

**K. Model pravdy (§63–64)** — výstupní schéma agenta nutí označit každý údaj: `record` (z nástroje, s odkazem) / `derived` / `estimate` / `prediction` (s jistotou a horizontem). Engine odmítne návrh s údajem bez původu — technické vynucení ne-vymýšlení.

**L. Bezpečnostní ústava (§48)** — invarianty vynucené enginem a pokryté testy: agent nemůže měnit oprávnění, limity, politiku, audit, konektory ani vypínače; nemůže schválit vlastní návrh; nemůže zvýšit vlastní autonomii (§39). Úroveň autonomie je **politika per třída akce a firma**: `jen informuje → doporučuje → připravuje ke schválení → automaticky (jen riziko 0–1 a po explicitním zapnutí)`.

---

## 4. Převzetí plánovaných funkcí (popis projektu → tento plán)

| § | Funkce | Dnes | Agentně | Fáze |
|---|---|---|---|---|
| 4, 40–47 | Deterministické jádro, kontrakty, schválení, audit, idempotence, oprávnění, delegace | hotové kromě jednoho enginu a delegace | Execution Engine; delegovaná autorita jako časově omezené oprávnění | **F0**, delegace F5 |
| 7 | Model Gateway | **dodána (PR #32)** | vrstva C | **F0** |
| 5 | Jednotná roura požadavku | částečně (hlas/text) | všechny kanály touž rourou | **F1** |
| 6, 57 | Multi-agent + Control Tower | není | vrstvy D, I | **F1–F3** |
| 39, 48, 49 | Autonomie, ústava, nouzové zastavení | vypínače schopností | politika autonomie, safe_mode, invarianty | **F1–F2** |
| 59–62 | Stín, řízené nasazení, rollback, observabilita | CI + Railway | AgentRun, kanárek per firma, metriky běhů | **F1–F2** |
| 12–13, 33 | CRM, poptávky, komunikace | moduly hotové | CRM agent: čtení, deduplikace, návrhy navazujících kroků | **F3** |
| 17 | Plánování (kalendář) | zápis hlasem hotový | Plánovací agent: kolize, přesuny, „najdi termín“ | **F3** |
| 31, 33 | AI Front Desk (e-mail, WhatsApp, web) | příjem + odpovědi po „ano“ | Komunikační agent: třídění `CommunicationIntake`, návrhy odpovědí, eskalace na člověka | **F3–F4** |
| 50–51 | Události, dlouhé procesy | není | DomainEvent + WorkflowRun (nabídka→schválení→záloha→termín) | **F4** |
| 14 | Nabídky a ceny | modul + PDF + odeslání | cenotvorba zůstává deterministická; agent jen vykládá zadání a plní vstupy | **F4** |
| 16, 23–24 | Ochrana rozsahu, Proof of Work, Quality Gates | částečně (stavy, fotky) | porovnání požadavku s nabídkou (návrh „vícepráce“); brány jako podmínky enginu | **F4–F5** |
| 19–20, 25–27 | Kapacita, nábor, sklad, nákup, majetek | kapacita + nábor + zdroje v datech | Kapacitní a Nákupní agent: čtení + návrhy objednávek/náboru přes „ano“ | **F5** |
| 28–29, 36 | Finance, cash flow, BI | faktury, platby, metriky | Finanční agent **jen čtení**; signály cash flow s označením `derived/estimate` | **F5** |
| 37–38 | Predikce, simulátor rozhodnutí | není | predikce jako označené odhady (K); simulátor v0 = scénář nad čtecími nástroji, bez zápisu | **F5–F6** |
| 34–35 | Znalosti, přenos znalostí | playbooky, paměť, učení | Znalostní agent nad playbooky + pamětí; zápis jen explicitním „zapamatuj“ | **F5** |
| 30, 32 | Zákaznický portál, telefon | není | podepsaný read-only odkaz; telefon až po F6 (nový konektor, Markovo rozhodnutí) | **F6** |
| 55 | Brána externích agentů (MCP) | není | externí agent = další volající enginu se svým oprávněním; nikdy přímý zápis | **F6** |
| 58 | Řízená sebe-evoluce | fakticky běží (Claude Code → Codex → Marek → CI → Railway) | formalizovat: návrh→test→stín→Marek→kanárek→rollback | **F6** |
| 10–11 | Hlasová identita, Team Session | není | důkaz identity, ne autorita | **F6** |
| 52–54, 63–70 | Tenancy, odvětví, konektory, pravda, mobil, web, personalizace, lokalizace, bezpečnost, soukromí | z velké části hotové | beze změny; agenti je dědí | průběžně |

Nic z popisu projektu se neruší; mění se jen pořadí a to, že **každá** z těchto funkcí nově vzniká jako nástroje + agent nad jedním enginem, ne jako další ručně psaná cesta.

---

## 5. Fáze — každá série malých PR, CI zelené, Marek slučuje

### F0 — Konsolidace (žádná změna chování)
1. `modelGateway.ts` — 5 volání AI jedním místem; běhový log nese model, trvání a tokeny. **Hotovo: PR #32.**
2. Katalog nástrojů v1 + test parity s kontrakty. **Hotovo (F0.2):** `backend/src/agents/toolCatalogue.ts` — 94 nástrojů nad spustitelnými akcemi, JSON Schema ze Zod schémat (41 přísných, zbytek validuje služba), druh read/write/external/administration z katalogu schopností (9 čtecích), riziko + oprávnění + firemní vypínač z kontraktů, obsahový otisk vynucující vědomé verzování. Verze 1.1.0 (9. 10.): 95 nástrojů — přibyl `resolve_communication_intakes` (hromadné označení nevyřízených zpráv kanálu za vyřízené, s náhledem a potvrzením vázaným na náhled).
3. `executionEngine.ts`; 7 kopií potvrzování se převede po jedné, stávající testy jako pojistka. **Hotovo (F0.3, PR #34–#39):** stavový stroj revidovaných akcí nad `VoicePendingAction` — poradní zámek serializuje překrývající se přípravy i převzetí, převzetí je atomické (výběr + převzetí + úklid duplikátů v jedné transakci) a čte čas až po zámku, nejednoznačná shoda časů mezi duplikáty neprovede nic, poražené souběžné potvrzení hlásí „už vyřízeno“. Migrováno: oznámení (#34), vytvoření a archivace klienta (#35), archivace kontaktu (#37), univerzální fronta spustitelných akcí včetně kalendáře (#38), WhatsApp a Gmail (#39). Stavová slova jednotlivých front („replaced“, „archiving“, „sending“, „sent“…) zůstala a definice je nese jako konfiguraci.
4. Zmrazení vzoru: nové schopnosti jen přes katalog + engine. **Hotovo (#39):** `tests/executionEnginePatternFreeze.test.ts` selže, jakmile kód mimo engine sáhne na `VoicePendingAction`. Jediná zdůvodněná výjimka: smazání hlasové historie (`voiceState.ts`) ruší čekající e-mail ve stejné transakci jako mazání přepisu.

**Vázané schválení (vrstva E) — vyřešeno v PR #41:** každá odpověď, která připravila revizi, nese `pendingReview.id`; webový klient si ho pamatuje a posílá s každým dalším příkazem (`review_id`, `null` když nic nezobrazuje). „Ano“ pak schválí **jen přesně tu revizi, kterou uživatel na tomto zařízení viděl/slyšel** — ne novější téže fronty, ne jedinou čekající v jiné frontě, a při `null` nic; odpověď má kód `REVIEW_NOT_HEARD` a říká pravdu — něco čeká, ale tady to nezaznělo, ať si to nechá připravit a přečíst znovu. Klient si id drží v `localStorage` (`vcuf_shown_review`), takže „ano“ platí i po obnovení stránky nebo po uvolnění WebView na telefonu; odhlášení ho maže. Zapamatované id se vymaže, jakmile ta revize přestane čekat (vyřízená, zrušená, vypršelá, vyřízená jinde), takže zastaralé id neblokuje. Bez pole `review_id` (starší klienti) se chová jako dřív. Zrušení („ne“) vázané není — nanejvýš zruší i novější revizi, nikdy nic neprovede. Pro agentní návrhy (F2) se na totéž id naváže otisk návrhu. Známé omezení (nízké riziko): klient drží jediné id — když se po sobě přečtou dvě revize z různých front, „ano“ potvrdí jen tu poslední a první se odmítne; směr je bezpečný (nic se neprovede bez slyšení), jen je potřeba první nechat přečíst znovu. Stejně tak sdílí id karty téhož prohlížeče.

**Akceptace:** celá sada testů zelená; mluvené chování beze změny (živě ověří Marek); běhové logy nesou model, trvání a tokeny — cena na běh přibude v auditu s `AgentRun` (F1).

### F1 — Orchestrátor ve stínu
Agentní smyčka s rozpočty; `AgentRun`; stín na skutečném provozu; parser zůstává první. **Akceptace:** ≥ 95% shoda návrhů se skutečnými výsledky na vzorku ≥ 100 požadavků; nulové provedení čehokoli stínem.

**F1a (PR #40):** `backend/src/agents/shadowAgent.ts` + tabulka `agent_runs`. Po zpracování příkazu parserem (`/command/assistant`, `/command/text`) dostane agent stejný požadavek a navrhne nástroje; **nic z návrhu se neprovede**. Nástroje = 94 spustitelných akcí z katalogu + **most na parser** `run_command`, který bere kanonický příkaz ze stejného seznamu jako hlasová interpretace (`backend/src/lib/canonicalCommands.ts`) a jehož návrh znovu čte deterministický parser — porovnává se záměr se záměrem a model nemůže vymyslet příkaz, který parser nezná. Shoda: `match` (přesně jedna akce, ta, kterou provedl parser, **se stejnými hodnotami** — porovnáno v paměti, uloženy jen otisky), `both_none` (obě strany nic) — jen tyto dvě se počítají jako shoda; proti ní: `arguments_differ` (správná akce, jiné hodnoty), `extra_calls` (správná akce + další volání), `mismatch`, `agent_only` (agent by jednal, parser ne — signál pro F2), `parser_only`, `invalid_proposal` (kterékoli volání, které by parser nebo schéma akce odmítly); `error` a `parser_rejected` (požadavek, který odmítla sama služba — není s čím srovnávat; připravený náhled akce s potvrzením, `CONFIRMATION_REQUIRED`, je naopak přijetí) se do míry nepočítají (k `error` patří i plán useknutý na limitu výstupu — `budget_exceeded`/`OUTPUT_BUDGET` — aby prázdná useknutá odpověď nevypadala jako „obě strany nic“). Potvrzovací tahy („ano“) se nestínují. Uloženo jen: otisk požadavku (HMAC), názvy nástrojů a otisky argumentů, záměr parseru, model, tokeny, trvání, verze katalogu a otisk přesné sady nástrojů (D4). Rozpočty D5: max. 6 kroků, 15 s (úloha `agent_plan` v bráně), omezený výstup; cenový strop 0,10 $ nejde vynutit bez ceníku tokenů — ten se nehádá, tokeny se ukládají. **Vypnuto, dokud Marek nenastaví `AGENT_SHADOW_SAMPLE_RATE`** (podíl příkazů 0–1; běh ≈ 10 tis. vstupních tokenů). Souhrn pro akceptaci: `GET /audit/agent-shadow` (administrátor) — počítá **jen aktuální kohortu** (model + otisk přesné sady nástrojů + **nasazený build**, který pokrývá prompt, čtení i posuzování návrhů a vše, co volají — parser, schémata akcí); každý nový model, katalog i nasazení začíná od nuly (bez identifikovaného buildu — mimo Railway/GitHub — se neschválí nic), takže akceptace potřebuje 100 porovnaných požadavků na jednom buildu, **a to pro každý jazyk a každou cestu požadavku zvlášť** (angličtina nikdy neručí za češtinu, psané příkazy nikdy neručí za hlasového asistenta; zapnout se smí jen dvojice jazyk × cesta v `acceptance.accepted`). Jazyk projde, jen když navíc má ≥ 95 % shody na ≥ 50 požadavcích, kde parser opravdu jednal (plánovač, který nic nenavrhuje, neprojde na samé konverzaci), a chybovost plánovače ≤ 5 % (nedostupnost se nesmí schovat za vyřazené chyby; vybraný požadavek, na který stín neměl kapacitu, se zapíše jako chyba `SHADOW_CAPACITY` bez volání modelu); souhrn uvádí u každého jazyka, které podmínky zatím chybí — měřit se tedy vyplatí v klidném období bez nasazování, starší běhy se jen ukážou. Hodnoty se porovnávají **přesně** (text zprávy lišící se velikostí písmen nebo mezerami je jiný text).

**F1b (další krok, po prvních datech ze stínu):** mapování synonym mezi nástroji a záměry parseru (např. nástroj `set_task_status` × záměr `change_task_status`, přímé `send_email`/`send_whatsapp` × `prepare_gmail_message`/`prepare_whatsapp_message`). Dnes se takové návrhy hodnotí jako neshoda — chyba je **konzervativní** (míru shody jen snižuje, nikdy nenafukuje) a plánovač má pro tyto případy i most `run_command`. Adaptéry klíčů a hodnot se postaví podle skutečných neshod, ne odhadem; cena za běh až s ceníkem tokenů.

### F2 — Zapnutí pro vícekrokové úkoly
Vypínač per firma; úkoly, kterým parser nerozumí a mají > 1 krok, jdou agentovi; návrhy přes engine a jedno „ano“; Control Tower v1; safe_mode. **Akceptace:** živý test s Markem („přesuň zítřejší první zakázku a napiš klientovi e-mail“ = jeden návrh, jedno ano), ověřený rollback vypínačem.

**Nouzové zastavení (vrstva H, §49) — PR #42:** `Company.safeModeSince`; zapíná a vypíná jen administrátor v Nastavení firmy (`PUT /company/safe-mode`, řádek zamčený po dobu přepnutí, audit s rizikem 4 a důvodem jen při skutečné změně), stav vidí každý přihlášený (`GET /company/safe-mode`, pruh nahoře na každé stránce). Secretary na něj nemá nástroj — nemůže zastavení sám zrušit. Vynucení ve čtyřech vrstvách (`backend/src/lib/safeMode.ts`), aby cesta zapomenutá jednou vrstvou neprošla další: (1) HTTP — každý přihlášený POST/PUT/PATCH/DELETE dostane 423 `SAFE_MODE_ACTIVE`, kromě krátkého seznamu: vypínač, přihlášení a vlastní heslo/hlas (ne schválení nového zařízení), `/command/text|assistant`, přepis a řeč, hlasová relace (ne mazání hlasové historie — může být jediným záznamem incidentu) a **zadržovací kroky administrátora**, které jen berou přístup: deaktivace účtu (požadavek nesmí měnit nic jiného), nové dočasné heslo (odhlásí účet všude), vypnutí konektoru. Kontrola běží po idempotenčním strážci: opakování požadavku dokončeného před zastavením dostane původní odpověď a odmítnutí se nikdy neuloží k přehrání; (2) příkazy — hlas, text i playbooky projdou jen jako čtení (podle režimu schopností v oprávněních asistenta), stažení čekající revize nebo vlastní hlasová nastavení; ostatní dostane odpověď slovy (cs/pl/en); (3) engine — `claimReviewedAction` odmítne dřív, než na revizi sáhne, takže „ano“ nic neprovede a revize čeká dál; odmítnutí z enginu se v příkazu vrátí stejnou odpovědí, takže audit i záznam běhu playbooku zůstanou; (4) pozadí — synchronizace konektorů a plánovaný přehled e-mailem firmu přeskočí, a to i uprostřed už běžícího průchodu (kontrola u každého zdroje a každého e-mailu). Záměrně běží dál: příjem zpráv z WhatsApp webhooku (zákazníkovy zprávy se neztratí; zapíše i kontakt odesílatele), e-mail pro obnovu hesla (bezpečnostní, jde jen na adresu účtu, omezený počtem), dokončení OAuth, které začalo před zapnutím (vypnutí konektoru jeho rozpracované OAuth zruší), a stínový agent (jen diagnostika). Odmítnuty jsou i náhledy posílané jako POST (např. spuštění playbooku bez potvrzení) — čtení přes GET a hlasové dotazy fungují.

**Control Tower v1 (vrstva I, §57) — PR #44:** stránka `/agents` („Dohled nad agenty“, jen pro `users.manage`, pouze ke čtení) nad `GET /audit/control-tower` a `GET /audit/agent-shadow`: nasazený build a model každé úlohy brány, zda běží agent ve stínu (podíl, klíč k modelu, běhy v letu), stav nouzového zastavení, co čeká na „ano“ po druzích akcí (`pendingReviewsOverview` v enginu — jen počty a časy, nikdy obsah), posledních 24 h běhů (chyby, tokeny), akceptace stínu po jazycích × cestách a posledních 50 běhů (názvy navržených nástrojů a shoda; otisky argumentů se nezobrazují). Nic nemění; vypínač agenta per firma přibude s F2 a bude tu vidět.

**F2a — vypínač agenta per firma (§39) — PR #46:** `Company.agentEnabledAt`; přepíná jen administrátor na stránce „Dohled nad agenty“ (`PUT /company/agent-mode`, audit s rizikem 3, jen skutečná změna; řádek zamčený). Secretary na vypínač nemá nástroj — nemůže si zvýšit autonomii. Agent smí jednat (`agentMayActFor`) jen když platí všechny tři podmínky: vypínač zapnutý, jazyk × cesta prošly akceptací stínu v aktuální kohortě, žádné nouzové zastavení. Během zastavení jde agent vypnout, ne zapnout. Sám o sobě vypínač zatím nic nespouští — první konzument je F2b (vícekrokový návrh s jedním „ano“).

**F2b — vícekrokový návrh s jedním „ano“ (vrstvy D a E, §5, §39–42, §48) — PR #47:** `backend/src/agents/agentProposal.ts`. Když interpretace pozná složený úkol (`kind: "plan"`) a agent smí jednat (vypínač, akceptace pro jazyk × hlasovou cestu, žádné zastavení) a správce nevypnul schopnost `execute_agent_proposal`, nepřečte se jen plán, ale požadavek dostane agent:
- **Čtení se provede hned** (nástroje `read` z katalogu a čtecí příkazy přes most `run_command`), pod oprávněními uživatele a vypínači schopností; výsledek (nejvýš 4 000 znaků) dostane model zpět, aby krok nesl přesný záznam místo odhadu.
- **Nic, co mění data, se neprovede:** každé takové volání je jeden krok návrhu. Akce s vlastním náhledem (e-mail, WhatsApp, kalendář…) si náhled udělají hned — stejnou cestou jako mluvený příkaz, jen bez vlastní revize — a krok se přečte jejich slovy; ostatní kroky se přečtou přesně tak, jak se provedou (název a hodnoty, příkaz doslova).
- **Nikdy v návrhu:** správa (oprávnění a chování asistenta, zaměstnanci) a správa konektorů (přihlášení, odpojení, zapnutí/vypnutí, nastavení, výchozí odesílací účet); playbooky (spuštění by provedlo uložené kroky, které se nepřečtou ani nezkontrolují; tvorba a úprava by je uložila); vlastní nastavení asistenta (jméno, oslovení, rychlost řeči), paměť a pravidla učení; příkazy s vlastní revizí (archivace, mazání oznámení, zprávy — místo nich nástroje odeslat/odpovědět, které mají náhled), změna jazyka a „zapamatuj“. Platí pro nástroj i pro most `run_command` (tvar `voice action …`). Co agent vynechal, Alfonzo řekne.
- **Rozpočet (D5):** max. 6 volání, 4 kola modelu, 15 s a nikdy později než 16 s od přijetí požadavku (Windows companion čeká 18 s); termín se hlídá před každým voláním nástroje i těsně před uložením návrhu — po něm se nic neuloží (jinak by návrh čekal na „ano“, které nikdo neslyšel) a jako dřív se jen přečte plán. Totéž při jakékoli chybě plánovače — nic se nezmění. Návrh delší než 900 znaků (tolik companion přečte nahlas) se nepřipraví vůbec; Alfonzo řekne, ať se to rozdělí.
- **Návrh** čeká v enginu (`agent_proposal`, 10 min) s klíčovaným otiskem (HMAC) všech kroků i slov, jimiž zazněly; **stojí sám** — jeho příprava stáhne ostatní revize, které uživatel má čekající, a příprava jakékoli jiné revize stáhne jeho, takže holé „ano“ vždy znamená to, co zaznělo naposled. Při „ano“ se znovu ověří (otisk, akce v katalogu, schéma, revize, příkaz čte parser stejně) — změněný návrh se neprovede (§41). „Ano“ funguje s vázaným schválením (`pendingReview`) jako každá revize.
- **Provedení:** kroky jdou popořadě stejnými cestami jako mluvený příkaz (akce s náhledem s potvrzením, na které byly přečteny; příkazy jako potvrzený playbook), před každým se znovu ověří vypínač schopnosti a nouzové zastavení; první selhání zastaví zbytek a odpověď řekne, co proběhlo, co selhalo a co se neprovedlo.
- **Rollback vypínačem:** vypnutý agent čekající návrh při „ano“ zruší a nic neprovede; nouzové zastavení odmítne „ano“ a návrh nechá čekat (jde zrušit „ne“).
- **Požadavek bez změny** (jen čtení) agent rovnou zodpoví z toho, co přečetl.
- **Záznam (D4):** běh `agent_runs` s `mode: "proposal"` (nástroje, druh, použití čtení/krok/odmítnuto, otisky argumentů, tokeny; žádný text) a audit `execute_agent_proposal` (příprava, provedení, zrušení — jen názvy akcí, záměry, názvy polí, otisk).
- **Stín u plánů neběží:** složený úkol nemá v parseru s čím srovnat, stínový běh by se platil zbytečně a počítal by se agentovi proti. Plány se akceptují živě (F2), přes návrhy, které uživatel schválí.
- **Známá omezení:** obecný popis kroku bez vlastního náhledu je technický (anglické názvy polí, příkaz doslova); v režimu LocalMode companion čeká jen 12 s; průběžná hláška „pracuju na tom“ po 3 s zatím není; výsledky čtení (údaje klientů) jdou k poskytovateli modelu (OpenAI, `store: false`).

### F3 — Specialisté pro tři hlavní funkce
Komunikační (e-mail + WhatsApp, angličtina), Plánovací (kalendář), CRM. Orchestrátor skládá jeden návrh napříč specialisty. **Akceptace:** scénáře nad třemi funkcemi, které Marek chce od začátku — jedna věta → jeden návrh → jedno ano.

### F4 — Události, dlouhé procesy, Front Desk
DomainEvent + WorkflowRun; proces nabídky (odeslání → urgence → schválení → záloha → termín); třídění příchozí komunikace s návrhy odpovědí. **Akceptace:** proces přežije redeploy backendu; urgence odejde jen po „ano“ nebo po explicitním automatickém pravidlu.

### F5 — Kapacita, nákup, finance (čtení), predikce v0, delegace
Označování původu údajů (K) vynucené enginem. **Akceptace:** finanční odpovědi citují záznamy; predikce nese jistotu a horizont.

### F6 — Rozšíření
Portál, telefon, MCP brána, pgvector, simulátor v1, formální sebe-evoluce, hlasová identita, Team Session. Každé jako samostatné rozhodnutí s vlastním návrhem.

---

## 6. Co se nestaví (trvale, dle CLAUDE.md)
Obecný chatbot, makro rekordér, obecná automatizace desktopu, CorelDRAW jako střed, druhý databázový model, agenti s pamětí mimo audit.

## 7. Rizika a protiopatření
- **Rychlost hlasu:** parser první; agent jen na složené úkoly; průběžná hláška po 3 s; limit běhu.
- **Cena:** strop na běh (D5), cena v logu a později v auditu, levné modely na levné úlohy přes bránu.
- **Chyby modelu:** zápis jen návrhem; stín před zapnutím; otisk schválení; model pravdy.
- **Rozbití funkčního:** F0 nemění chování; staré cesty se mažou až po živé akceptaci nové; kanárek per firma; vše vratné vypínačem.
- **Závislost na OpenAI:** brána + adaptéry; druhý klíč jen po D3.

## 8. Rozhodnutí — přijata 8. 10. 2026 (Marek delegoval: „rozhodni“)
- **D1 — ROZHODNUTO:** agenti jako TypeScript modul ve stávajícím backendu, ne FastAPI/LangGraph služba. `docs/PRODUCTION_ARCHITECTURE.md` upraven (PR #32).
- **D2 — ROZHODNUTO:** F0 zahájena hned; první PR #32 (Model Gateway, beze změny chování).
- **D3 — ROZHODNUTO:** zatím výhradně OpenAI. Druhý poskytovatel až ve chvíli, kdy Marek dodá klíč do Railway.
- **D4 — ROZHODNUTO:** `AgentRun` ukládá kroky, nástroje, model, cenu a otisky obsahu — nikdy texty zpráv.
- **D5 — ROZHODNUTO:** výchozí rozpočty běhu agenta: max. 6 kroků, 15 s, strop 0,10 USD na běh; nastavitelné per firma, změny auditované.
- **D6 — ROZHODNUTO:** PR #1 zavřít jako nahrazený tímto dokumentem (větev zůstává); zavření provede Marek.

## 9. Vztah k živým testům
F0 a stín (F1) nečekají na nic. **Zapnutí** (F2+) čeká na: novou autorizaci Gmail/Contacts/Drive, druhý Gmail a živé ověření tří funkcí po staru — aby stín měl s čím srovnávat a přepnutí mělo změřený základ.
