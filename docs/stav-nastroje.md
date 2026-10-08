# animbench — stav nástroje a metodická rozhodnutí

Stav k 8. 10. 2026. Jak nástroj používat, popisuje [návod](navod.md). Tento
dokument zaznamenává, **proč** je nástroj takový, jaký je: každé metodické
rozhodnutí spolu s měřením, které k němu vedlo. Slouží jako podklad pro
metodickou kapitolu práce.

---

## Stav

| oblast | stav |
|---|---|
| měření časování snímků | hotovo |
| ořez na ustálené okno | hotovo |
| vytížení procesoru (CDP) | hotovo, režie ověřena |
| automatický záznam stroje a napájení | hotovo (macOS ověřen na stroji) |
| testy | 74, ověřené mutacemi |
| pilotní měření | hotovo — 429 běhů, bez CPU vzorkování |
| Android | **chybí** — čeká na zařízení k vyzkoušení |
| sloupec se zařízením v CSV | **chybí** — doplní se s Androidem |
| závěrečné měření | **čeká** na dokončení aplikace a Androidu |

---

## Metodická rozhodnutí a jejich doklady

### 1. Měří se ve viditelném okně

Bezhlavý Chromium vykresluje přes SwiftShader, softwarový rasterizér na
procesoru; ve viditelném okně jede vykreslování přes Metal na grafické kartě.
Bezhlavý režim navíc `chrome://gpu` vůbec neotevře, takže v něm akceleraci nelze
ani ověřit. Výhoda kompozitoru, kterou práce zkoumá, by v něm zmizela.

Nástroj před každou dávkou ověří, že Compositing a Rasterization hlásí
hardwarovou akceleraci, a jinak dávku nespustí.

### 2. Rozpočet snímku se odvozuje z naměřené frekvence

Stránka změří klidový rozestup snímků před během a rozpočet se odvodí z něj.
Praktický doklad: testovací sestava běžela v srpnu na 75 Hz (rozpočet 13,3 ms)
a v září po výměně monitoru na 60 Hz (16,7 ms). Nástroj změnu zachytil sám;
pevná hodnota 16,7 ms by srpnová data tiše zkreslila.

Snímek se počítá jako propadlý až nad 1,5násobkem rozpočtu, aby se mezi propady
nedostal běžný rozptyl razítek.

### 3. Nástroj měření spouští, stránka jen ohlašuje připravenost

Kontrakt obsahuje `__benchStart`. Stránka po postavení scény ohlásí
připravenost a čeká; měření spustí nástroj. Bez toho by stránka startovala sama
a do měřených dat by se míchala stavba scény — což se v aplikaci skutečně dělo,
dokud se start neoddělil.

### 4. Rozptyl mezi shodnými běhy je řádově menší než rozdíl mezi technikami

Rozhodovací bod před ostrým měřením. Dvacet běhů shodné kombinace na zátěžové
testovací stránce:

| metrika | variační koeficient |
|---|---|
| medián rozestupu snímků | 0,5 % |
| průměrná frekvence | 5,9 % |
| 1. percentil frekvence | 29,8 % |
| nejdelší snímek | 59,5 % |

Rozdíl mezi zatíženou a nezatíženou technikou dal Cohenovo d = 115. Metodika
obstála. Zároveň z tabulky plyne, že nejdelší snímek je jen doprovodný údaj —
rozhoduje o něm jediná odlehlá hodnota.

### 5. Metriky se počítají jen z ustáleného okna

Scény rozjíždějí prvky postupně (4 ms na prvek), takže zátěž během běhu roste,
drží se a zase klesá. Průměr přes celý běh míchá tři různé zátěže a skutečnou
zátěž podhodnocuje: u `css-transition` při 2000 prvcích vyšlo 20,8 FPS přes celý
běh, ale 12,4 FPS v ustáleném stavu.

Stránka proto ohlašuje hranice ustáleného okna (`steadyStateFromMs`,
`steadyStateToMs`) a metriky se počítají jen z něj. Surová razítka zůstávají
v datech celá.

Bez ořezu by se ztratilo i hlavní zjištění pilotu: podíl zdvojených rozestupů
u `css-transition` vyšel přes celý běh 20,3 %, v ustáleném okně 50,1 %. Náběh
půlení snímků rozmazal — proto ho srpnová ověřovací série nezachytila.

### 6. Percentily potřebují dost vzorků

Měřeno proti referenci z celého okna: 95. percentil rozestupů (`p5Fps`) se
ustálí kolem 75 vzorků, 99. percentil (`p1Fps`) až kolem 300 — při 50 vzorcích
se odchyloval až o 477 %. Nástroj na nedostatek vzorků upozorní už během dávky;
běh se nezahazuje, jen se příslušný percentil neinterpretuje.

### 7. Šířka okna 10 / 20 / 20 s a prodleva 15 s

Širší okno dává víc vzorků, ale u techniky na hranici výkonu zvyšuje rozptyl:
`css-transition` při 2000 prvcích měl variační koeficient 9,8 % s 10s oknem
a 30,3 % s 30s oknem. Rozptyl přitom sleduje **zátěž**, ne délku běhu — při
srovnatelném počtu vzorků vyšel 3,9 % u 800 prvků, 7,3 % u 1200 a 17,1 % u 1500.

Původní domněnka o tepelném škrcení se nepotvrdila: pořadí běhů a výkon spolu
nekorelují (Spearmanovo ρ = −0,21). Příčina vyššího rozptylu u dlouhých běhů
zůstává neurčená.

### 8. Složitost se nezvyšuje nad 2000 prvků

Nad 2000 prvků se při daném rozjíždění nikdy nehýbou všechny prvky současně —
při 4000 nejvýš 2500 — a pro percentily by bylo potřeba okno přes 80 s. Techniky
na stropu displeje se místo toho rozliší měřením na slabších zařízeních.

### 9. Medián se u techniky vynechávající snímky nepoužívá

U techniky, která půlí snímkovou frekvenci, nabývají rozestupy jen dvou hodnot
(16,7 a 33,3 ms) a medián mezi nimi přeskakuje: u `css-transition` při 2000
prvcích kolísal mezi běhy o ±7 ms. Spolehlivé jsou podíl dosažené frekvence
(`refreshRatio`) a podíl snímků nad rozpočtem.

### 10. Vytížení procesoru se vzorkuje po 1000 ms

Čítače času hlavního vlákna a procesů se čtou přes DevTools protokol; stránka
nespouští žádný kód navíc. Režie ověřena na `css-transition` při 2000 prvcích,
deset běhů na variantu, prokládaně:

| | vypnuto | 500 ms | 100 ms |
|---|---|---|---|
| `refreshRatio` | 0,668 | 0,662 | 0,653 |
| snímky nad rozpočtem | 48,5 % | 49,8 % | 51,8 % |

Při 500 ms bez průkazného rozdílu (95% interval režie [−0,026; +0,013]), při
100 ms průkazný posun. Režie tedy existuje a roste s hustotou. Hustší vzorkování
přitom přesnost nezvyšuje (vytížení 81,7 % při 500 ms, 81,2 % při 100 ms), protože
čítače jsou kumulativní. Proto 1000 ms; ve výchozím stavu je vzorkování vypnuté.

### 11. Stroj a napájení se zapisují automaticky

Ručně zadané popisky už jednou selhaly: data měřená na 60 Hz nesla popisek
„75Hz" z dřívější sestavy. Model, procesor, paměť a systém se proto zapisují
samy a napájení (síť či baterie a stav baterie) se čte před každým během a po
něm, mimo měřený úsek. Notebooky na baterii omezují výkon, takže napájení je
podmínka měření, ne detail stroje.

---

## Pilotní měření (září 2026)

429 běhů, žádný zahozený; MacBook Air M3, 60 Hz, sedm technik, tři scény,
deset opakování. **Pilot vznikl bez vzorkování procesoru a bez záznamu
napájení — závěrečné měření ho nahradí.**

Do 500 prvků jsou všechny techniky nerozeznatelné (`refreshRatio` 1,000). Při
2000 prvcích:

| technika | grid | composite |
|---|---|---|
| gsap | 1,000 | 0,999 |
| raf | 0,993 | 0,999 |
| waapi | 0,994 | 0,999 |
| css-keyframes | 0,999 | 0,997 |
| motion | 0,961 | 0,996 |
| **css-transition** | **0,619** | **0,581** |

Scroll-driven animace na scéně parallax drží 0,999 na všech složitostech.

**Hlavní zjištění:** dělicí čára nevede mezi CSS a JavaScriptem — knihovny GSAP
a Motion jedou stejně jako nativní `requestAnimationFrame` a `css-keyframes`
také. Propadá jediná technika, `css-transition`, a to pravidelným vynecháváním
každého druhého snímku (na scéně composite má 73 % rozestupů dvojnásobnou
délku, medián přesně 33,3 ms), ne postupným zpomalováním.

Ověřeno, že nejde o chybu adaptéru: zapisuje cílovou hodnotu jen pětkrát za běh.
Kontrolní srovnání ve stejné scéně se 2000 prvky: `css-transition` (8000
souběžných přechodů) 71 % zdvojených rozestupů, `css-keyframes` 3,7 %, Motion
3,0 % (přestože zapisuje styl každý snímek), WAAPI 0 %.

Orientační měření procesoru (dva běhy na kombinaci) ukazuje, kde práce vzniká:
hlavní vlákno vytížené na 81 % u `css-transition` proti 59 % u `raf` a 66 %
u `css-keyframes`; rozdíl leží celý mimo skript, styly i layout. Čas procesu
řídícího grafickou kartu je u všech technik stejný.

### Práh

Doplňková série mezi 500 a 2000 prvky (`raf` a `css-transition`):

| prvků | `css-transition` / `raf` — průměrná frekvence | 1. percentil |
|---|---|---|
| 800 | 99 % | 93 % |
| 1200 | 96 % | 81 % |
| 1500 | 87 % | 48 % |
| 2000 | 46 % | 39 % |

Percentily varují dřív než průměr: při 1500 prvcích je průměr ještě na 87 %, ale
nejhorší procento snímků už na 48 %.

---

## Známá omezení

- **Jedno zařízení.** Všechna dosavadní data pocházejí z jednoho stroje, jednoho
  prohlížeče (Chrome 151) a jednoho grafického rozhraní (Metal).
- **Kompozitor není vidět.** Čas hlavního vlákna pokrývá jen vlákno stránky.
- **„CPU čas GPU procesu" není vytížení grafické karty**, jen čas procesoru,
  který ji řídí. Prohlížeč vytížení GPU nevystavuje.
- **Spotřeba se neměří.** Rozhraní prohlížečů pro baterii je omezené a systémové
  měření by mísilo prohlížeč se zbytkem stroje.
- **Playwright spouští Chrome s vlastními přepínači**, mimo jiné s vypnutým
  *Direct Rendering Display Compositor*. Srovnání technik to neovlivní, absolutní
  čísla se ale mohou lišit od běžného prohlížeče.
- **Záznam napájení na Windows a Linuxu** je ověřený jen na ukázkových výstupech,
  ne na skutečném stroji.

---

## Co zbývá

1. **Android** — připojení přes `adb`, ověření, co z DevTools protokolu na
   telefonu funguje, a jeden kompletní běh. Zařízení budou k dispozici jen
   jednou, takže musí fungovat napoprvé.
2. **Sloupec se zařízením v CSV**, aby šly sady z více strojů sloučit.
3. **Závěrečné měření** se vzorkováním procesoru (`cpuSampleIntervalMs: 1000`),
   na více zařízeních a odděleně na baterii.
