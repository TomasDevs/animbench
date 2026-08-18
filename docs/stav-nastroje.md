# animbench — stav nástroje a kontrakt pro demo aplikaci

Stav k 18. 8. 2026. Dokument shrnuje, co je v měřicím nástroji hotové, co z toho
plyne pro demo aplikaci `animbench-lab` a čím se pokračuje.

---

## Shrnutí pro netrpělivé

Měřicí nástroj je hotový a ověřený. **Demo aplikace může pokračovat.**

Jedna věc se ale oproti původnímu zadání změnila a demo aplikace ji musí
zohlednit: kontrakt má **pět** klíčů, ne čtyři. Přibyl `window.__benchStart`.
Podrobnosti níže v kapitole [Kontrakt](#kontrakt-který-musí-stránka-splnit).

---

## Proč se čekalo a jak to dopadlo

Čekalo se na rozhodovací bod: dvacet běhů shodné kombinace a posouzení, jestli
rozptyl mezi shodnými běhy není srovnatelný s rozdílem mezi technikami. Kdyby
byl, metodika by padala a musela by se přepracovat dřív, než začne ostré měření.

**Rozptyl mezi shodnými běhy** (n = 20, náhodné pořadí, 2 s prodleva):

| metrika | průměr | směrodatná odchylka | variační koeficient |
|---|---|---|---|
| průměrné FPS | 22,38 | 1,32 | 5,9 % |
| medián rozestupu snímků | 49,76 ms | 0,24 | **0,5 %** |
| snímky nad rozpočtem | 45,1 | 2,61 | 5,8 % |
| 1. percentil FPS | 16,04 | 4,78 | 29,8 % |
| nejdelší snímek | 78,85 ms | 46,95 | **59,5 %** |

**Rozdíl mezi technikami** (n = 8 na techniku, tři různě náročné režimy):

```
readback vs transform:  rozdíl 51,63 FPS,  sdružená sd 0,45,  Cohenovo d = 115
layout   vs transform:  rozdíl  0,01 FPS,  sdružená sd 0,01,  Cohenovo d = 0,9
```

**Závěr: rozptyl je řádově menší než rozdíl mezi technikami. Metodika obstála,
ostré měření může začít.**

### Ale pozor — co to neznamená

Rozhodovací bod ověřil, že **nástroj měří spolehlivě**. Neověřil, že se
**techniky v demo aplikaci rozejdou** — to nástroj zjistit nemůže.

Poslední řádek tabulky je varování: `layout vs transform` = rozdíl 0,01 FPS. Obě
techniky jedou na stropu displeje a nástroj mezi nimi nerozliší nic. Správně,
protože tam žádný rozdíl není.

Testovací stroj (Apple M3) je rychlý. Aby srovnání technik mělo co ukázat, musí
být scény natolik náročné, aby se techniky rozešly. Při ladění scén je užitečné
vědět, že M3 nesrazí pod 75 FPS ani 1500 animovaných prvků poháněných přes
`transform` nebo přes `left` — spolehlivě to dokázal až vynucený synchronní
layout každý snímek.

**Toto je nyní hlavní riziko celé práce a leží na straně demo aplikace.**
Doporučení: u každé scény si ověřit, že aspoň v nejnáročnějším nastavení klesá
frekvence pod strop displeje. Scéna, kde všechny techniky jedou na 100 %,
neposkytne data k porovnání.

---

## Kontrakt, který musí stránka splnit

Toto je jediné, co nástroj o stránce ví. Nezná techniky, scény ani adresy;
všechno popisné cestuje uvnitř `meta` jako neinterpretovaná data.

### Klíče na `window`

| klíč | typ | význam |
|---|---|---|
| `__benchReady` | `true` | scéna je postavená a adaptér inicializovaný |
| `__benchStart` | `() => void` | **nově** — nástroj tímto spustí měření |
| `__benchResult` | objekt | surová razítka a metadata po doběhnutí |
| `__benchDone` | `true` | výsledek je k dispozici |
| `__benchError` | objekt | nastaví se místo výsledku, pokud běh selhal |

### Změna oproti původnímu zadání: `__benchStart`

Původní kontrakt měl čtyři klíče, všechny jen ke čtení. Nástroj tak neměl čím
měření spustit — stránka by musela startovat sama a nešlo by oddělit dobu stavby
scény od doby měřeného běhu.

Adaptér tedy po dokončení příprav vystaví funkci `window.__benchStart` a teprve
pak nastaví `__benchReady = true`. Nástroj po zaznamenání připravenosti tuto
funkci zavolá.

**Bez `__benchStart` skončí každý běh s `contract-violation`.**

### Tvar `__benchResult`

```ts
{
  timestamps: number[],       // razítka z performance.now(), v ms, aspoň dvě
  baseline: {
    frameIntervalMs: number,  // klidový rozestup snímků (medián), > 0
    refreshRateHz: number,    // odvozená obnovovací frekvence, > 0
    samples?: number[]        // volitelně surové klidové vzorky
  },
  meta: { ... },              // libovolné klíče; nástroj je nikdy neinterpretuje
  startTime: number,          // performance.now() na začátku běhu
  endTime: number,            // performance.now() na konci běhu
  overflowed: boolean         // true, pokud došel buffer na razítka
}
```

### Tvar `__benchError`

```ts
{ message: string, stack?: string }
```

### Tři pravidla, na kterých stojí platnost měření

1. **Ve stránce se nic nepočítá.** Žádné průměry, žádné percentily. Výpočet ve
   stránce by zatížil právě to vlákno, které se měří. Všechno se počítá až
   v Node.

2. **`meta` je volné.** Cokoli tam adaptér dá (technika, scéna, počet prvků,
   parametry prostředí), nástroj zaznamená a použije k seskupení, ale nikdy
   neinterpretuje. Sem patří všechno, co má být v datech vidět.

3. **`baseline` je povinná a měří se před během.** Rozpočet na snímek se odvozuje
   z ní, ne z pevných 16,7 ms. Ověřeno prakticky: testovací displej běží na
   75 Hz, rozpočet je tedy 13,3 ms. Na 120Hz a 144Hz displejích by pevná hodnota
   byla ještě víc mimo.

### Parametry běhu

Nástroj předává kombinace jako query parametry v adrese. Názvy i hodnoty jsou
volné — matice se zadává v konfiguraci nástroje, aplikace si je jen přečte
z `location.search`.

**Doporučení z praxe:** parametry validovat a při nesmyslné hodnotě nastavit
`__benchError`. Během vývoje se ukázalo, že `?count=abc` vedlo k `NaN`, prázdné
scéně a vykázané perfektní frekvenci — vypadalo to jako výborné měření. Takový
tichý nesmysl je horší než hlášená chyba.

### Minimální kostra adaptéru

```js
async function main() {
  const baseline = await measureBaseline();   // klidové rozestupy před během
  buildScene();                               // postavit scénu

  window.__benchStart = async () => {
    try {
      window.__benchResult = await runAnimation(baseline);
    } catch (error) {
      window.__benchError = { message: String(error?.message ?? error) };
    }
    window.__benchDone = true;
  };

  window.__benchReady = true;                 // až úplně nakonec
}

main().catch((error) => {
  window.__benchError = { message: String(error?.message ?? error) };
  window.__benchDone = true;
});
```

---

## Co je v nástroji hotové

| | stav |
|---|---|
| kostra projektu (Node 22, TS, tsx, tsup, Playwright) | hotovo |
| ověření hardwarové akcelerace | hotovo |
| typy: kontrakt, konfigurace, záznam | hotovo |
| jeden běh proti kontraktu | hotovo |
| zápis NDJSON | hotovo |
| agregace a výstup CSV | hotovo |
| dávkové spouštění | hotovo |
| **rozhodovací bod** | **prošel** |

### Příkazy

```
animbench check-gpu                                   ověří hardwarovou akceleraci
animbench run <adresa> [--out <soubor.ndjson>]        jeden běh
animbench batch <config.json>                         matice kombinací
animbench aggregate <soubor.ndjson> <soubor.csv>      souhrn do CSV
```

### Metodická rozhodnutí, která už jsou ověřená

**Viditelné okno, ne bezhlavý režim.** Ověřeno přímo: ve viditelném okně jede
vykreslování přes Metal na M3, v bezhlavém přes SwiftShader — softwarový
rasterizér na CPU. Bezhlavý režim navíc `chrome://gpu` vůbec neotevře, takže
v něm akceleraci nelze ani ověřit.

**Rozpočet z naměřené frekvence.** Odvozuje se z `baseline`, ne z 16,7 ms. Snímek
se počítá jako propadlý až nad 1,5násobkem rozpočtu — bez této tolerance by se
mezi propady dostal běžný jitter razítek.

**Zahozené běhy se zapisují i s důvodem.** Nemizí potichu; v CSV je vidět, kolik
běhů odpadlo a proč. Rozehřívací běhy se vykazují zvlášť, aby je nešlo zaměnit
se skutečnými ztrátami.

**Náhodné pořadí se seedem.** Proti tepelnému škrcení. Seed se zapisuje do
každého záznamu, takže pořadí dokončené dávky lze zopakovat.

**Percentily místo minima.** Data to potvrzují: medián rozestupu kolísá mezi
shodnými běhy o 0,5 %, nejdelší snímek o 59,5 %. Nejdelší snímek je proto
doprovodná informace, ne metrika, na které stavět závěr.

### Odhad času měření

Přibližně 210 běhů na scénu ≈ 68 minut. Tři scény ≈ 3–4 hodiny na zařízení.

---

## Čím se pokračuje

1. **Dokumentace kontraktu** — tento dokument; hotovo.
2. **Testy** — percentily, odvození rozpočtu a plánování dávky zatím ověřené
   jednorázově. Potřebují trvalé testy, na které jde odkázat v textu práce.
3. **Uživatelská dokumentace nástroje** v `docs/`.

Nic z toho neblokuje demo aplikaci.

---

## Poznámky k prostředí měření

- Demo aplikace musí při měření běžet přes `pnpm preview` nad produkčním buildem,
  **ne `pnpm dev`**. Dev server drží v hlavním vlákně HMR klienta, což je další
  skript v měřeném prostředí.
- Před měřením spustit `animbench check-gpu`. Compositing i Rasterization musí
  hlásit hardwarovou akceleraci; jinak výsledky nejsou srovnatelné.
- Playwright spouští Chrome s vlastními přepínači, mimo jiné vypnutým
  *Direct Rendering Display Compositor*. Pro srovnávání technik mezi sebou to
  nevadí (prostředí je pro všechny stejné), ale u absolutních čísel to stojí za
  poznámku v textu práce.
