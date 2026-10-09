# animbench — návod k použití

Nástroj pro měření časování snímků webových animací. Otevře stránku ve
viditelném okně prohlížeče, počká, až ohlásí připravenost, spustí měření
a odečte surová časová razítka. Statistiky se počítají až v Node — nikdy ve
stránce, která se měří.

Nástroj neví nic o konkrétní aplikaci. Funguje proti jakékoli stránce, která
splní [kontrakt](#kontrakt).

---

## Instalace

```bash
pnpm install
pnpm exec playwright install chromium
```

Vyžaduje Node 20 nebo novější.

---

## Než začnete měřit

```bash
pnpm dev check-gpu
```

Vypíše stav grafické akcelerace. **`gpu_compositing` i `rasterization` musí
hlásit `enabled`**, jinak prohlížeč kreslí na procesoru a výsledky nejsou
srovnatelné. Příkaz končí nenulovým návratovým kódem, když podmínka neplatí,
takže jde zařadit před měření ve skriptu.

Měří se vždy ve viditelném okně. Bezhlavý režim Chromia používá softwarový
rasterizér SwiftShader místo grafické karty, čímž by zmizela právě ta výhoda
kompozitoru, kterou měření zkoumá.

---

## Příkazy

```
animbench check-gpu                                       ověří akceleraci
animbench run <adresa> [--out <soubor.ndjson>] [--cpu]    jeden běh
animbench batch <config.json>                             matice kombinací
animbench aggregate <soubor.ndjson>... <soubor.csv> [--batch <id>]   souhrn
```

Ve vývoji se spouštějí přes `pnpm dev <příkaz>`, po sestavení (`pnpm build`)
přes `node dist/cli.js <příkaz>`.

### Jeden běh

Pro rychlé ověření, že stránka kontrakt plní:

```bash
pnpm dev run 'http://localhost:4173/bench.html?technique=raf&complexity=500'
```

Vypíše počet snímků, dobu běhu, naměřenou klidovou frekvenci a obsah `meta` —
nebo důvod, proč běh neprošel. S `--out` zapíše výsledek do souboru NDJSON.

Přijímá i cestu k lokálnímu souboru včetně query parametrů. S `--cpu` se během
běhu vzorkuje i čas procesoru (viz [Vytížení procesoru](#vytížení-procesoru)).

### Dávka

Ostré měření se spouští konfiguračním souborem:

```bash
pnpm dev batch config.json
```

Nástroj vypíše průběh po jednotlivých bězích a na konci souhrn. Když je v okně
málo vzorků na percentily, upozorní na to už během měření.

Přerušení klávesami Ctrl+C zapisovač korektně uzavře, takže dosud naměřené běhy
zůstanou v souboru.

Po celou dobu dávky nástroj brání uspání počítače i displeje (na macOS přes
`caffeinate`, na Linuxu přes `systemd-inhibit`, na Windows přes
`SetThreadExecutionState`) a po skončení či přerušení zámek uvolní. Spící stroj
nekreslí, takže by každý běh až do probuzení skončil časovým limitem. Čím byl
spánek blokovaný, se zapisuje ke každému běhu; když se zámek nepodaří získat,
dávka na to na začátku upozorní. Na Linuxu a Windows to zatím nebylo ověřeno na
skutečném stroji.

### Souhrn

```bash
pnpm dev aggregate results/runs.ndjson results/summary.csv
```

Dávka s vyplněným `output.csvPath` tohle udělá sama. Samostatně se příkaz hodí
při přepočtu už naměřených dat — třeba po změně kritérií.

Souborů NDJSON lze zadat víc — typicky jeden z každého zařízení — a souhrn je
sloučí do jedné tabulky:

```bash
pnpm dev aggregate mac.ndjson telefon.ndjson results/vse.csv
```

Běhy z různých zařízení nebo s různým napájením se přitom nikdy nezprůměrují
dohromady: každá kombinace dostane vlastní řádek pro každé zařízení a pro provoz
v síti i na baterii zvlášť.

Soubor NDJSON se zapisuje přidáváním na konec, takže může obsahovat víc dávek.
Přepínač `--batch <id>` omezí souhrn na jednu; bez něj se sečtou všechny, což
u opakovaného měření zprůměruje nesouvisející běhy.

---

## Konfigurace

```json
{
  "target": {
    "url": "http://localhost:4173/bench.html",
    "matrix": {
      "technique": ["raf", "css-transition"],
      "complexity": ["100", "500", "2000"]
    }
  },
  "timing": { "readyTimeoutMs": 30000, "runTimeoutMs": 300000, "cooldownMs": 15000 },
  "batch": { "repetitions": 10, "warmupRuns": 1, "shuffle": true, "seed": 20260911 },
  "browser": {
    "headless": false,
    "viewport": { "width": 1280, "height": 720 },
    "requireHardwareAcceleration": true
  },
  "output": {
    "ndjsonPath": "results/runs.ndjson",
    "csvPath": "results/summary.csv"
  },
  "labels": { "device": "MacBook Air M3", "display": "60Hz" }
}
```

### target

| pole | význam |
|---|---|
| `url` | adresa měřené stránky; relativní cesta se vyhodnotí vůči konfiguračnímu souboru |
| `matrix` | názvy parametrů a jejich hodnoty |

Z matice vznikne kartézský součin: příklad výše dá 2 × 3 = 6 kombinací. Hodnoty
se předají stránce jako parametry v adrese a zapíší se ke každému běhu jako
klíč, podle kterého se výsledky seskupují.

Názvy parametrů jsou libovolné. Nástroj jim nerozumí a nepotřebuje — jen je
předá a zaznamená.

### timing

| pole | výchozí | význam |
|---|---|---|
| `readyTimeoutMs` | 30 000 | jak dlouho čekat na `__benchReady` |
| `runTimeoutMs` | 300 000 | jak dlouho čekat na `__benchDone` |
| `cooldownMs` | 3 000 | prodleva mezi běhy |
| `cpuSampleIntervalMs` | vypnuto | interval vzorkování procesoru; pro měření 1 000 |

Prodleva slouží k vychladnutí zařízení. U dlouhých zátěžových běhů na pasivně
chlazených strojích má smysl ji zvýšit.

### batch

| pole | výchozí | význam |
|---|---|---|
| `repetitions` | 10 | měřená opakování každé kombinace |
| `warmupRuns` | 1 | rozehřívací běhy, které se zahazují |
| `shuffle` | true | náhodné pořadí měřených běhů |
| `seed` | náhodný | semínko míchání |

Rozehřívací běhy proběhnou vždy jako první a do výsledků nevstupují. Měřené
běhy se zamíchají, aby postupné zahřívání zařízení nezvýhodnilo tu kombinaci,
která by jinak běžela první.

Semínko se vždy vypíše a zapíše ke každému běhu, i když se nezadá — jinak by
pořadí nešlo zopakovat.

### browser

| pole | výchozí | význam |
|---|---|---|
| `headless` | false | viditelné okno; pro měření nechat vypnuté |
| `viewport` | 1280 × 720 | velikost okna |
| `requireHardwareAcceleration` | true | zastavit dávku, když akcelerace neběží |
| `target` | `desktop` | `android` měří Chrome na telefonu připojeném přes adb |
| `deviceSerial` | — | který telefon, je-li jich připojeno víc |
| `adbPath` | hledá se | cesta k `adb`, pokud ho nástroj nenajde sám |

Velikost okna musí být napříč porovnávanými běhy stejná, pokud se scéna
přizpůsobuje jeho šířce. Nástroj zaznamenává rozměr, který stránka skutečně
viděla, ne ten z konfigurace.

### output a labels

`ndjsonPath` je povinná, `csvPath` volitelná. `labels` jsou libovolné popisky
zapsané ke každému běhu — hodí se na označení zařízení nebo účelu měření.

---

## Měření na Androidu

Telefon měření sám neprovede: když na něm jen otevřete adresu, stránka postaví
scénu a čeká, až ji někdo spustí. Běhy spouští, opakuje a ukládá nástroj na
počítači, ke kterému je telefon připojený. Nástroj se k Chromu na telefonu
připojí stejně jako `chrome://inspect` a zpřístupní mu `localhost` počítače,
takže telefon měří přesně stejné sestavení aplikace jako desktop.

### Předem, na počítači

- nainstalované Android platform-tools (`adb version` odpoví); nástroj hledá
  `adb` v `ANDROID_HOME`, v obvyklé složce Android SDK, nebo v `browser.adbPath`
- datový kabel USB — nabíjecí kabely bez datových vodičů telefon nezpřístupní
- aplikace spuštěná přes `pnpm preview` jako u měření na desktopu

### Příprava telefonu

1. **Vývojářské možnosti:** Nastavení → O telefonu → sedmkrát klepnout na
   *Číslo sestavení*.
2. **Ladění USB:** Nastavení → Vývojářské možnosti → zapnout *Ladění USB*.
3. **Připojit kabel** a na telefonu potvrdit *Povolit ladění USB*, se
   zaškrtnutým *Vždy povolit z tohoto počítače*.
4. **Chrome** aktualizovat, jednou otevřít a projít úvodní obrazovky.
5. **Vypnout spořič baterie** a adaptivní režim výkonu, pokud ho telefon má —
   omezují výkon a výsledky by nebyly srovnatelné.
6. **Časový limit obrazovky** nastavit na nejdelší možný. Se zhasnutým displejem
   Android nekreslí. Nástroj displej kontroluje před každým během, a když
   zhasne, dávku ukončí s hlášením; dosud naměřené běhy zůstanou uložené.
7. **Nerušit** zapnout, ať měření nepřeruší oznámení.
8. **Obnovovací frekvenci displeje** zjistit v nastavení displeje. U telefonů
   s proměnlivou frekvencí (60/90/120 Hz) ji zapsat do `labels` — nástroj ji
   změří, ale nastavení telefonu nezná.

### Ověření, pět minut

```bash
adb devices                                     # telefon ve stavu "device"
pnpm dev check-gpu --android                    # akcelerace
pnpm dev run '<adresa>?technique=raf&scene=grid&complexity=500&window=3000&seed=42&mode=bench' --android --cpu
```

Poslední příkaz musí vypsat počet snímků a vytížení hlavního vlákna. Teprve pak
spouštět dávku.

### Měření v síti

V konfiguraci dávky stačí `"browser": { "target": "android" }`. Telefon zůstává
připojený kabelem a nabíjí se; ve výstupu je to `powerSource: ac`.

### Měření na baterii

Kabel USB telefon nabíjí, takže pro měření na baterii se použije **bezdrátové
ladění** (Android 11 a novější). Telefon i počítač musí být ve stejné síti Wi-Fi.

1. Vývojářské možnosti → *Bezdrátové ladění* → zapnout → *Spárovat zařízení
   pomocí párovacího kódu*.
2. Na počítači `adb pair <IP>:<port pro párování>` a zadat kód.
3. `adb connect <IP>:<port>` (port z hlavní obrazovky bezdrátového ladění).
4. Odpojit kabel. `adb devices` teď ukazuje zařízení jako `<IP>:<port>`.
5. Tuto adresu zadat do `browser.deviceSerial`.

Na začátku dávky musí být vidět `Power: on battery`. Bezdrátová cesta zatím
nebyla ověřena na skutečném telefonu — vyzkoušejte ji při přípravě, ne až při
měření.

### Co na Androidu chybí

- **CPU čas rendereru a procesu grafiky:** Android ho u izolovaných procesů
  hlásí jako nulu; v datech je prázdný, ne nulový. Čas hlavního vlákna se měří.
- **Velikost okna** nejde nastavit; měří se na celé obrazovce telefonu a rozměr
  se zapíše.
- **Rok výroby** telefonu nikde vyčíst nejde; zapisuje se do `labels`.

Po skončení vypněte na telefonu ladění USB i bezdrátové ladění.

---

## Kontrakt

Stránka vystavuje na `window` pět hodnot:

| klíč | typ | význam |
|---|---|---|
| `__benchReady` | `true` | scéna je postavená a adaptér inicializovaný |
| `__benchStart` | `() => void` | tímto nástroj spustí měření |
| `__benchResult` | objekt | surová razítka a metadata po doběhnutí |
| `__benchDone` | `true` | výsledek je k dispozici |
| `__benchError` | `{ message, stack? }` | místo výsledku, pokud běh selhal |

Nástroj po načtení počká na `__benchReady`, zavolá `__benchStart()`, počká na
`__benchDone` a odečte `__benchResult`. Na návratovou hodnotu `__benchStart`
nečeká — konec běhu ohlašuje výhradně `__benchDone`.

### `__benchResult`

```ts
{
  timestamps: number[],       // z performance.now(), v ms, nejméně dvě
  baseline: {
    frameIntervalMs: number,  // klidový rozestup snímků, > 0
    refreshRateHz: number,    // odvozená obnovovací frekvence, > 0
    samples?: number[]
  },
  meta: { ... },              // libovolné klíče
  startTime: number,
  endTime: number,
  overflowed: boolean         // true, když došel buffer na razítka
}
```

Ve stránce se nic nepočítá. Výpočet by zatížil právě to vlákno, které se měří.

`baseline` se měří v klidu před během a odvozuje se z ní rozpočet na snímek.
Pevná hodnota 16,7 ms by na displeji se 75 nebo 144 Hz byla chybná.

`meta` je volné. Cokoli tam stránka dá, nástroj zaznamená, ale neinterpretuje.

### Měřené okno

Scéna, která své prvky rozjíždí postupně, je nejprve pod rostoucí, pak klesající
zátěží. Průměr přes celý běh proto míchá tři různé zátěže a skutečnou zátěž
podhodnocuje.

Stránka, která ví, kdy byly všechny prvky v pohybu, to ohlásí v `meta`:

```ts
meta: {
  steadyStateFromMs: number,  // kdy se rozběhl poslední prvek
  steadyStateToMs: number     // kdy se začal zastavovat první
}
```

Obojí ve stejné časové ose jako `timestamps`. Nástroj pak počítá metriky jen
z tohoto úseku. Značka je volitelná — bez ní se měří celý běh.

Surová razítka zůstávají v NDJSON nezkrácená, takže při změně kritéria lze
přepočítat bez nového měření.

---

## Výstupy

### NDJSON

Jeden řádek na běh, surová data. Zahozené běhy se zapisují také, s `valid:
false`, důvodem a podrobností — v datech je tak vidět, kolik běhů odpadlo a
proč.

Důvody zahození:

| důvod | význam |
|---|---|
| `warmup` | rozehřívací běh, zahazuje se záměrně |
| `overflowed` | stránce došel buffer na razítka |
| `page-error` | stránka ohlásila `__benchError` |
| `contract-violation` | výsledek nemá očekávaný tvar |
| `stale-build` | stránka je připravená, ale nevystavuje `__benchStart` |
| `timeout` | stránka neohlásila připravenost nebo dokončení včas |
| `navigation-error` | adresu se nepodařilo načíst |

Ke každému běhu se automaticky zapisuje i prostředí: verze prohlížeče, grafický
renderer, skutečná velikost okna, model a procesor stroje, paměť, operační
systém a **napájení před a po běhu** (síť či baterie a stav baterie). Napájení
se čte mimo měřený úsek. `labels` v konfiguraci tak slouží jen k popisu účelu,
ne k zápisu hardwaru, který by šlo zadat chybně.

`stale-build` obvykle znamená, že server posílá starší sestavení — pomůže
přebuildovat nebo restartovat.

### CSV

Jeden řádek na kombinaci a zařízení. První sloupce popisují podmínky měření,
pak následují parametry matice, počty běhů a metriky.

| sloupec | význam |
|---|---|
| `deviceModel`, `deviceCpu`, `deviceOs` | zařízení, na kterém se měřilo |
| `powerSource` | `ac` (síť), `battery`, nebo `unknown` |
| `batteryMin`, `batteryMax` | rozsah nabití baterie během běhů skupiny |

| sloupec | význam |
|---|---|
| `runsValid` | započítané běhy |
| `runsDiscarded` | ztracené běhy (bez rozehřívacích) |
| `runsWarmup` | rozehřívací běhy |
| `discardReasons` | důvody a jejich počty |
| `meanIntervalMs_mean` | průměrný rozestup snímků |
| `medianIntervalMs_mean` | medián rozestupu |
| `p95IntervalMs_mean`, `p99IntervalMs_mean` | percentily rozestupů |
| `maxIntervalMs_max` | nejdelší snímek |
| `meanFps_mean` | průměrná snímková frekvence |
| `p5Fps_mean`, `p1Fps_mean` | 5. a 1. percentil frekvence |
| `framesOverBudget_mean` | snímky nad rozpočtem |
| `framesOverBudgetRatio_mean` | jejich podíl |
| `refreshRatio_mean` | podíl dosažené a dosažitelné frekvence |
| `budgetMs_median`, `refreshRateHz_median` | rozpočet a frekvence displeje |
| `frameCount_mean` | snímky, ze kterých se počítalo |
| `recordedFrameCount_mean` | snímky celkem, včetně oříznutých |
| `trimmedRatio_mean` | podíl oříznutých snímků |
| `meanIntervalMs_stdDev` | rozptyl mezi opakováními téže kombinace |
| `meanFps_min`, `meanFps_max` | rozsah mezi opakováními |
| `mainThreadBusyRatio_mean` | podíl času, kdy bylo hlavní vlákno zaneprázdněné |
| `mainThreadStyleRatio_mean`, `…ScriptRatio_mean`, `…LayoutRatio_mean` | z toho přepočet stylů, skript, layout |
| `mainThreadOtherRatio_mean` | práce hlavního vlákna mimo tyto tři kategorie |
| `rendererCpuRatio_mean` | CPU čas procesu stránky; může přesáhnout 1 (víc vláken) |
| `gpuProcessCpuRatio_mean` | CPU čas procesu, který řídí grafickou kartu |
| `cpuSampleCount_mean` | počet vzorků uvnitř měřeného okna |

Sloupce procesoru jsou prázdné, když dávka běžela bez vzorkování.

---

## Jak číst výsledky

**`refreshRatio` je hlavní metrika pro srovnání napříč zařízeními.** Absolutní
snímková frekvence se mezi displeji s různou obnovovací frekvencí srovnávat
nedá; podíl dosažené a dosažitelné frekvence ano.

**Percentily místo minima.** Nejdelší snímek rozhodne jediná odlehlá hodnota;
mezi opakováními téže kombinace kolísá o desítky procent, zatímco medián
rozestupu o desetiny. Nejdelší snímek proto patří k doprovodným údajům, ne
k závěrům.

**Percentily potřebují vzorky.** Měřeno proti referenci z celého okna:
`p5Fps` se ustálí kolem 75 vzorků, `p1Fps` až kolem 300 — pod tím kolísá
o stovky procent. Nástroj na nedostatek vzorků upozorní během měření; takové
běhy se nezahazují, ale příslušný percentil se nemá interpretovat.

**Rozptyl mezi opakováními roste se zátěží.** U nezatížených kombinací bývá
pod procentem, u techniky blízko svých mezí i přes 30 %. Proto deset opakování,
ne dvě.

**Zkontrolujte `trimmedRatio_mean`.** Vysoká hodnota znamená, že se z běhu
měřil malý úsek — pak je na místě ověřit, jestli v okně zbylo dost vzorků.

---

**U techniky, která vynechává snímky, nepoužívejte medián.** Rozestupy pak
nabývají jen dvou hodnot (rozpočet a jeho dvojnásobek) a medián mezi nimi mezi
opakováními přeskakuje — u `css-transition` při 2000 prvcích kolísal o ±7 ms.
Stabilní jsou `refreshRatio` a podíl snímků nad rozpočtem.

---

## Vytížení procesoru

S `cpuSampleIntervalMs` nástroj během běhu čte přes DevTools protokol čítače
času hlavního vlákna stránky a CPU času jednotlivých procesů prohlížeče. Stránka
přitom nespouští žádný kód navíc. Vzorky se ukládají surové; podíly pro měřené
okno se počítají až v Node, s hodnotou na hranách okna dopočtenou interpolací.

Dvě omezení pro interpretaci:

- čas hlavního vlákna pokrývá jen vlákno měřené stránky, ne kompozitor;
- „CPU čas GPU procesu" je čas procesoru, který grafickou kartu řídí, **ne
  vytížení grafické karty**. Prohlížeč vytížení GPU nevystavuje.

### Režie

Ověřeno na `css-transition` při 2000 prvcích — technice na hranici výkonu, kde
by se jakákoli režie projevila nejdřív. Deset běhů na variantu, prokládaně
v náhodném pořadí:

| | vypnuto | 500 ms | 100 ms |
|---|---|---|---|
| `refreshRatio` | 0,668 | 0,662 | 0,653 |
| snímky nad rozpočtem | 48,5 % | 49,8 % | 51,8 % |

Při 500 ms není rozdíl proti vypnutému průkazný (permutační test, p ≥ 0,5);
95% interval režie v `refreshRatio` je [−0,026; +0,013], tedy nejvýš desetina
rozdílu mezi měřenými technikami. Při 100 ms je posun průkazný a všechny
metriky se s hustším vzorkováním posouvají stejným směrem — režie tedy existuje
a roste s hustotou.

Hustší vzorkování přitom přesnost nezvyšuje: vytížení hlavního vlákna vyšlo
81,7 % při 500 ms a 81,2 % při 100 ms. Čítače jsou kumulativní, takže záleží jen
na vzorcích u hran okna. Proto se pro měření používá **1 000 ms** a ve výchozím
stavu je vzorkování vypnuté.

---

## Vývoj

```bash
pnpm check      # typová kontrola a testy
pnpm test       # jen testy
pnpm build      # sestavení do dist/
```

Testy pokrývají statistiku, metriky, agregaci, kontrakt, plánování dávky,
konfiguraci a výstupy. V `fixtures/` jsou stránky plnící kontrakt i stránky
záměrně porušené — nástroj tak jde ověřit bez měřené aplikace.
