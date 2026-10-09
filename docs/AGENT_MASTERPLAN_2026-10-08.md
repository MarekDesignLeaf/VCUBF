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
2. Katalog nástrojů v1 + test parity s kontrakty. **Hotovo (F0.2):** `backend/src/agents/toolCatalogue.ts` — 94 nástrojů nad spustitelnými akcemi, JSON Schema ze Zod schémat (41 přísných, zbytek validuje služba), druh read/write/external/administration z katalogu schopností (9 čtecích), riziko + oprávnění + firemní vypínač z kontraktů, obsahový otisk vynucující vědomé verzování.
3. `executionEngine.ts`; 7 kopií potvrzování se převede po jedné, stávající testy jako pojistka. **Hotovo (F0.3, PR #34–#39):** stavový stroj revidovaných akcí nad `VoicePendingAction` — poradní zámek serializuje překrývající se přípravy i převzetí, převzetí je atomické (výběr + převzetí + úklid duplikátů v jedné transakci) a čte čas až po zámku, nejednoznačná shoda časů mezi duplikáty neprovede nic, poražené souběžné potvrzení hlásí „už vyřízeno“. Migrováno: oznámení (#34), vytvoření a archivace klienta (#35), archivace kontaktu (#37), univerzální fronta spustitelných akcí včetně kalendáře (#38), WhatsApp a Gmail (#39). Stavová slova jednotlivých front („replaced“, „archiving“, „sending“, „sent“…) zůstala a definice je nese jako konfiguraci.
4. Zmrazení vzoru: nové schopnosti jen přes katalog + engine. **Hotovo (#39):** `tests/executionEnginePatternFreeze.test.ts` selže, jakmile kód mimo engine sáhne na `VoicePendingAction`. Jediná zdůvodněná výjimka: smazání hlasové historie (`voiceState.ts`) ruší čekající e-mail ve stejné transakci jako mazání přepisu.

**Známé omezení zděděné ze všech 7 kopií (Codex, PR #34):** hlasové potvrzení dnes přebírá *nejnovější* připravenou revizi bez identifikátoru — při dvou překrývajících se přípravách téhož uživatele s různým obsahem může pořadí HTTP odpovědí zobrazit starší náhled jako poslední. Engine to zmenšuje (serializace, nejednoznačné shody neprovedou nic), ale úplně to uzavře až vrstva E: „ano" váže otisk konkrétního návrhu (F1/F2), ne poslední řádek v tabulce. Záměrně se neřeší v F0 — změnilo by to chování potvrzovacích API.

**Akceptace:** celá sada testů zelená; mluvené chování beze změny (živě ověří Marek); běhové logy nesou model, trvání a tokeny — cena na běh přibude v auditu s `AgentRun` (F1).

### F1 — Orchestrátor ve stínu
Agentní smyčka s rozpočty; `AgentRun`; stín na skutečném provozu; parser zůstává první. **Akceptace:** ≥ 95% shoda návrhů se skutečnými výsledky na vzorku ≥ 100 požadavků; nulové provedení čehokoli stínem.

**F1a (PR #40):** `backend/src/agents/shadowAgent.ts` + tabulka `agent_runs`. Po zpracování příkazu parserem (`/command/assistant`, `/command/text`) dostane agent stejný požadavek a navrhne nástroje; **nic z návrhu se neprovede**. Nástroje = 94 spustitelných akcí z katalogu + **most na parser** `run_command`, který bere kanonický příkaz ze stejného seznamu jako hlasová interpretace (`backend/src/lib/canonicalCommands.ts`) a jehož návrh znovu čte deterministický parser — porovnává se záměr se záměrem a model nemůže vymyslet příkaz, který parser nezná. Shoda: `match` (přesně jedna akce, ta, kterou provedl parser, **se stejnými hodnotami** — porovnáno v paměti, uloženy jen otisky), `both_none` (obě strany nic) — jen tyto dvě se počítají jako shoda; proti ní: `arguments_differ` (správná akce, jiné hodnoty), `extra_calls` (správná akce + další volání), `mismatch`, `agent_only` (agent by jednal, parser ne — signál pro F2), `parser_only`, `invalid_proposal` (kterékoli volání, které by parser nebo schéma akce odmítly); `error` a `parser_rejected` (požadavek, který odmítla sama služba — není s čím srovnávat; připravený náhled akce s potvrzením, `CONFIRMATION_REQUIRED`, je naopak přijetí) se do míry nepočítají (k `error` patří i plán useknutý na limitu výstupu — `budget_exceeded`/`OUTPUT_BUDGET` — aby prázdná useknutá odpověď nevypadala jako „obě strany nic“). Potvrzovací tahy („ano“) se nestínují. Uloženo jen: otisk požadavku (HMAC), názvy nástrojů a otisky argumentů, záměr parseru, model, tokeny, trvání, verze katalogu a otisk přesné sady nástrojů (D4). Rozpočty D5: max. 6 kroků, 15 s (úloha `agent_plan` v bráně), omezený výstup; cenový strop 0,10 $ nejde vynutit bez ceníku tokenů — ten se nehádá, tokeny se ukládají. **Vypnuto, dokud Marek nenastaví `AGENT_SHADOW_SAMPLE_RATE`** (podíl příkazů 0–1; běh ≈ 10 tis. vstupních tokenů). Souhrn pro akceptaci: `GET /audit/agent-shadow` (administrátor) — počítá **jen aktuální kohortu** (model + otisk přesné sady nástrojů + **nasazený build**, který pokrývá prompt, čtení i posuzování návrhů a vše, co volají — parser, schémata akcí); každý nový model, katalog i nasazení začíná od nuly (bez identifikovaného buildu — mimo Railway/GitHub — se neschválí nic), takže akceptace potřebuje 100 porovnaných požadavků na jednom buildu, **a to pro každý jazyk a každou cestu požadavku zvlášť** (angličtina nikdy neručí za češtinu, psané příkazy nikdy neručí za hlasového asistenta; zapnout se smí jen dvojice jazyk × cesta v `acceptance.accepted`). Jazyk projde, jen když navíc má ≥ 95 % shody na ≥ 50 požadavcích, kde parser opravdu jednal (plánovač, který nic nenavrhuje, neprojde na samé konverzaci), a chybovost plánovače ≤ 5 % (nedostupnost se nesmí schovat za vyřazené chyby; vybraný požadavek, na který stín neměl kapacitu, se zapíše jako chyba `SHADOW_CAPACITY` bez volání modelu); souhrn uvádí u každého jazyka, které podmínky zatím chybí — měřit se tedy vyplatí v klidném období bez nasazování, starší běhy se jen ukážou. Hodnoty se porovnávají **přesně** (text zprávy lišící se velikostí písmen nebo mezerami je jiný text).

### F2 — Zapnutí pro vícekrokové úkoly
Vypínač per firma; úkoly, kterým parser nerozumí a mají > 1 krok, jdou agentovi; návrhy přes engine a jedno „ano“; Control Tower v1; safe_mode. **Akceptace:** živý test s Markem („přesuň zítřejší první zakázku a napiš klientovi e-mail“ = jeden návrh, jedno ano), ověřený rollback vypínačem.

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
