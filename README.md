# Portal Przeglądania Akt – pobieranie dokumentów

> 🤖 **Vibecoded:** kod tego skryptu, testy i ten opis napisała sztuczna inteligencja –
> **Claude Opus 5.5** (Anthropic) – na polecenie i pod kierunkiem autora.

Nieoficjalny skrypt użytkownika (userscript) do
[Portalu Przeglądania Akt](https://przegladanieakt.prokuratura.gov.pl) prokuratury.
Portal pozwala zdigitalizowane akta tylko oglądać – skrypt dodaje do niego pobieranie:

- **Pobierz otwarty dokument** – dokument otwarty w przeglądarce akt,
  np. `<sygnatura> – 12. Protokół przesłuchania świadka (k. 30-34).pdf`;
- **Pobierz całe akta** – wszystkie dokumenty z drzewa akt w jednym archiwum: folder na tom,
  dokument jako PDF albo folder ze stronami i `spis-dokumentow.csv` (otwiera się w LibreOffice i Excelu).

Strony mają oznaczenia kart jak w aktach („k. 12”, „k. 12v” dla rewersu) – jako etykiety stron
w PDF-ie albo w nazwach plików (`k. 012.webp`, `k. 012v.webp`).

> Skrypt nie jest związany z Prokuraturą Krajową. Działa tylko po zalogowaniu i pobiera
> wyłącznie to, co portal i tak wyświetla zalogowanemu użytkownikowi.

## Formaty

Portal wysyła strony jako PNG z 16 kolorami (ok. 200 DPI). Wyniki na prawdziwych aktach
(11 dokumentów, 29 stron, oryginalne PNG ≈ 2,9 MB):

| Format | Bez strat? | Rozmiar | Czas na stronę | Uwagi |
|---|---|---|---|---|
| **PDF z oryginalnymi PNG** (domyślnie) | tak | 100% | – | strony w PDF-ie bajt w bajt |
| PDF zoptymalizowany | tak | **ok. 90%*** | 0,1–0,4 s | otworzy go każdy czytnik PDF |
| PNG – oryginalne skany | tak | 100% | – | dokładnie pliki z portalu |
| WebP bezstratny (effort 6) | tak | **ok. 77%** | ułamek sekundy | otworzy go każda przeglądarka |
| JPEG XL bezstratny (effort 7) | tak | **ok. 55%** | ok. 1,5 s | otworzy go niewiele programów (Safari, GIMP, przeglądarki zdjęć na Linuksie; Chrome i Firefox – nie) |
| WebP stratny (jakość 80) | nie | ok. 200% | ułamek sekundy | |
| PDF z JPEG / JPEG (jakość 60–80) | nie | ok. 230–330% | ułamek sekundy | |
| JPEG XL stratny | nie | ok. 200% i więcej | ok. 1,5 s | |

Bezstratność WebP i JPEG XL jest sprawdzona: piksele są identyczne z oryginałem. Formaty stratne
przydają się dla programów, które nie czytają PNG – na takich skanach nie oszczędzają miejsca.

\* **PDF zoptymalizowany** – WebP i JPEG XL nie da się włożyć do PDF-a (żaden czytnik PDF ich nie
wyświetli), ale stronę da się zapisać oszczędniej w tym, co PDF obsługuje. Skrypt robi to osobno dla
każdej strony, bo akta różnią się między sprawami: rozpakowuje ją, liczy kolory, które naprawdę na niej
są, i dobiera paletę o najmniejszej głębi (1, 2, 4 albo 8 bitów na piksel; przy ponad 256 kolorach –
RGB albo odcienie szarości), przy 8 bitach także filtry PNG wiersz po wierszu, i kompresję Deflate.
Z kilku wariantów – łącznie z oryginałem – bierze najmniejszy, więc strona nigdy nie jest większa niż
w „PDF z oryginalnymi PNG”. Strony JPEG i 16-bitowe PNG (bez przezroczystości) zostają bez zmian,
a PNG, którego nie da się odczytać ściśle według normy, ale przeglądarki go pokazują – też. Zysk zależy od akt: na prawdziwych aktach
(29 stron, wszystkie z 4 kolorami zapisanymi przez portal w 4 bitach) skrypt wybrał paletę 2-bitową
i PDF-y zmalały z 3,0 do 2,7 MB (o ok. 10%); czysta strona testowa z 4 kolorami zmalała do 30%,
a zaszumiona z 16 kolorami – tylko o 1%. Piksele we wszystkich 29 stronach są identyczne z oryginałem
(sprawdzone popplerem). Effort to poziom kompresji Deflate (1–9).

**Effort** (WebP bezstratny 0–9, stratny 0–6, JPEG XL 1–9): wyżej = mniejsze pliki, ale wolniej.
Bezstratny WebP 9 daje zwykle tylko 1–2% mniej niż 6, a trwa kilka–kilkanaście sekund na stronę;
bezstratny JPEG XL 9 daje o 10–30% mniej niż 7, ale 10–20 s na stronę. Najniższe wartości dają pliki
większe od PNG. Kodowanie idzie po kilka stron naraz, więc długi dokument nie zapycha pamięci.

**Archiwum** (całe akta albo dokument zapisywany jako obrazy): ZIP, ZIP z kompresją (Deflate 1–9),
TAR, TAR.GZ (1–9), TAR.XZ (0–9), TAR.ZST (1–19). PDF-y i obrazy są już skompresowane, więc
kompresja archiwum i jej poziom zmieniają rozmiar najwyżej o kilka procent. TAR.GZ/XZ/ZST są
kompresowane porcjami po 32 MB (każda to osobny strumień, złączone dają poprawny plik). Akta większe
niż ok. 1,5 GB trafiają do kilku archiwów („część 1”, „część 2”…); w pamięci jest naraz najwyżej
jedna część (przy TAR.GZ/XZ/ZST także jej skompresowana kopia). Gdyby kompresja części się nie
udała, skrypt zapisze ją jako zwykły TAR, żeby pobrane dokumenty nie przepadły. Chrome i inne
przeglądarki na Chromium przy drugiej części pytają o zgodę na pobieranie wielu plików – trzeba zezwolić.

## Instalacja

1. Zainstaluj menedżer skryptów: [Violentmonkey](https://violentmonkey.github.io/) (zalecany)
   albo Tampermonkey.
2. Otwórz [pobieranie-akt.user.js](https://raw.githubusercontent.com/Czekoloczek/prokuratura-akta/main/pobieranie-akt.user.js) –
   menedżer pokaże okno instalacji i pobierze kodeki (ok. 2,3 MB, patrz niżej).
3. Zaloguj się do portalu i otwórz akta sprawy. Skrypt dodaje:
   - przycisk **Pobierz akta** w pasku nad drzewem akt (obok „Przejdź do wniosku”) – otwiera dymek
     z pobieraniem, wyborem formatu, effortu, archiwum i poziomu kompresji oraz postępem;
   - ikonę pobierania w pasku przeglądarki dokumentu (obok trybu pełnoekranowego) – od razu pobiera
     otwarty dokument w wybranym formacie.

   Gdy portal nie pokazuje paska nad drzewem (udostępnienia bez prawa do wniosku), zamiast przycisku
   pojawia się wąska zakładka „Pobierz akta” przy prawej krawędzi ekranu.

## Kodeki

WebP, JPEG XL, XZ, Zstandard i poziomy Deflate/gzip wymagają kodeków w WebAssembly. Skrypt deklaruje
je jako `@resource` z sumami SHA-256 – menedżer skryptów pobiera je raz, przy instalacji, z jsDelivr
i odrzuca pliki z niezgodną sumą:

| Kodek | Do czego | Licencja |
|---|---|---|
| [fflate](https://github.com/101arrowz/fflate) 0.8.3 | Deflate i gzip z poziomami | MIT |
| [lzma-wasm](https://github.com/Wu-Yijun/lzma-wasm) 1.0.7 | XZ | MIT / Apache-2.0 |
| [@bokuweb/zstd-wasm](https://github.com/bokuweb/zstd-wasm) 0.0.27 | Zstandard | MIT |
| [@jsquash/webp](https://github.com/jamsinclair/jSquash) 1.5.0 (libwebp) | WebP | Apache-2.0 (libwebp: BSD) |
| [@jsquash/jxl](https://github.com/jamsinclair/jSquash) 1.3.0 (libjxl) | JPEG XL | Apache-2.0 (libjxl: BSD) |

Kodeki uruchamiają się dopiero po wybraniu formatu, który ich potrzebuje, w osobnym wątku
(Web Worker) – kodowanie nie zamraża strony portalu. Po pobieraniu wątek jest zamykany, więc pamięć
koderów (przy JPEG XL nawet ponad 1 GB) wraca do systemu. Strony PNG skrypt dekoduje sam, bez canvas,
więc WebP i JPEG XL działają także przy ochronie przed fingerprintingiem. Gdyby menedżer skryptów
nie udostępnił kodeków, formaty, które ich wymagają, są w dymku wyszarzone, a ZIP z kompresją
i TAR.GZ kompresuje wtedy sama przeglądarka (bez wyboru poziomu). Kodek, który nie wystartuje
(np. przy wyłączonym WebAssembly), zatrzymuje pobieranie od razu, zanim skrypt zacznie pobierać strony.

## Prywatność i obciążenie portalu

- Skrypt działa wyłącznie w Twojej przeglądarce i łączy się tylko z portalem. Niczego nigdzie
  nie wysyła i nie ma telemetrii. Jedyne pliki spoza tego repozytorium to kodeki z tabeli wyżej,
  pobierane przez menedżer skryptów przy instalacji.
- Pobiera po 2 strony naraz, z odstępem między żądaniami – regulamin portalu (§ 12) zabrania
  działań utrudniających jego funkcjonowanie. Przy długim pobieraniu przedłuża sesję tak,
  jak przycisk w okienku o wygasającej sesji.
- Gdy portal chwilowo nie odpowiada, skrypt ponawia żądanie coraz rzadziej (łącznie do ok. 50 s),
  a cały dokument – jeszcze raz po minucie przerwy. Po 3 dokumentach z rzędu bez odpowiedzi przerywa
  pobieranie i zapisuje to, co już pobrał (archiwum „– NIEKOMPLETNE”, z adnotacją w spisie).
- Nośników (płyt, nagrań) portal nie udostępnia zdalnie, tylko w czytelni prokuratury –
  skrypt ich nie pobiera, wpisuje je jedynie do spisu.
- JPEG powstaje przez canvas przeglądarki. Jeśli przeglądarka blokuje albo zaszumia odczyt z canvas
  (np. `privacy.resistFingerprinting` we Firefoksie), skrypt przerwie konwersję z komunikatem.
  Formaty bez strat z portalowych PNG canvas nie potrzebują.

## Uwagi prawne

- W postępowaniu przygotowawczym o udostępnieniu akt i o sporządzaniu ich kopii decyduje
  w zarządzeniu prowadzący postępowanie (art. 156 § 5 KPK). Pobranie akt skryptem to sporządzenie
  kopii – sprawdź, czy zarządzenie o udostępnieniu akt obejmuje kopie, a nie tylko przeglądanie.
- Publiczne rozpowszechnianie wiadomości z postępowania przygotowawczego, zanim zostały
  ujawnione w postępowaniu sądowym, jest przestępstwem (art. 241 § 1 KK).
- Skrypt jest dostarczany „tak jak jest”, bez żadnej gwarancji. Za sposób korzystania
  z pobranych akt odpowiada użytkownik.

## Ograniczenia

Przetestowane na udostępnieniu internetowym (strony w PNG, jeden tom) w przeglądarce opartej
na Chromium: wszystkie formaty i archiwa, przyciski w paskach portalu i zakładka zapasowa.
Kodeki były tam podawane przez zastępcze `GM_getResource*` – sama instalacja z `@resource`
w Violentmonkeyu/Tampermonkeyu i działanie we Firefoksie (Floorpie) nie były jeszcze sprawdzane.
Na żywo nie było też okazji sprawdzić: załączników do dokumentów, wyłączeń stron, wersji
dokumentów, akt większych niż 1,5 GB (archiwum dzielone na części) i bardzo długiego pobierania
(przedłużanie sesji). Portal może się zmienić w każdej chwili i wtedy skrypt przestanie działać.

## Zgłaszanie błędów

[Zgłoś problem](https://github.com/Czekoloczek/prokuratura-akta/issues) i podaj: wersję portalu
(stopka strony: „Wersja aplikacji”), przeglądarkę, menedżer skryptów oraz komunikat z panelu
lub z konsoli (F12, wpisy zaczynające się od `[pobieranie akt]`).
**Nie wklejaj sygnatury, nazw dokumentów ani treści akt.**

## Jak to działa

Skrypt korzysta z tych samych adresów co przeglądarka akt (trasy bierze z obiektu `routing` strony):

| Co | Żądanie |
|---|---|
| drzewo akt | `POST /api/pl-PL/CaseTree/GetTreeItems?shareId=…&parentIds=<klucz>` z ciałem `null` |
| karty dokumentu | `GET /api/pl-PL/Card/GetDocumentCards?shareId=…&documentId=…` |
| obraz strony | `GET /api/pl-PL/Card/GetPage?shareId=…&pageKey=…` |
| przedłużenie sesji | `GET /api/pl-PL/Session/Refresh` |

Klucze w drzewie: `cs:` sprawa, `t:` grupa akt, `v:` tom, `d:` dokument, `ba:` nośnik.
Karta ma pola `numberPart` (numer karty), `twoPages` i `pages[]` (`pageKey`, `isVerte`).
PDF i archiwa składa sam skrypt: JPEG i PNG (także 16-bitowe) są osadzane w PDF-ie bez dekodowania
(PNG z predyktorem Flate); PNG z przezroczystością lub przeplotem skrypt sam dekoduje i nakłada na białe
tło, inne formaty – przez canvas. Portal zapisuje w PNG domyślne 96 DPI z .NET, choć skany mają
200 DPI, dlatego strony z 96 albo 72 DPI i spoza zakresu A7–A3 dostają rozmiar A4.

## Testy

```
node testy/test-rdzen.cjs /tmp/test-akta
node testy/test-przegladarka.cjs /tmp/test-akta
```

`test-rdzen` sprawdza CRC-32, PDF (JPEG bajt w bajt, PNG – także 16-bitowe – piksel w piksel, przez
`pdfinfo`, `pdfimages` i `pdftoppm`), dekoder PNG (piksel w piksel jak ImageMagick, palety z przezroczystością),
wątek kodeków – ten sam kod co w przeglądarce, uruchomiony w Node: wczytanie wszystkich kodeków, kompresję,
WebP i JPEG XL bezstratnie co do piksela, błąd zamiast zawieszenia przy uszkodzonym WASM –
optymalizację PDF (nigdy większa od oryginału, piksele z `pdfimages` identyczne ze źródłem),
wszystkie archiwa – także wielostrumieniowe, bez kodeków i zapasowy TAR po nieudanej kompresji – przez
`unzip -t`, GNU tar, `gzip`/`xz`/`zstd -t` i `7z t` (długie polskie nazwy przez nagłówki PAX), nazwy
plików, etykiety kart i rozmiary stron. Przy pierwszym uruchomieniu pobiera kodeki z adresów `@resource`
i sprawdza ich sumy SHA-256. Wymaga Node.js 22+, ImageMagick 7 (z WebP i JPEG XL), popplera, unzip,
GNU tar, gzip, xz, zstd i 7z.

`test-przegladarka` uruchamia cały skrypt w Node z atrapami portalu, wątku kodeków i strony: limit
stron w toku, przerwanie i błędy stron, unikalne nazwy stron, kolejkę żądań, archiwa bez kodeków,
nieudaną kompresję części, awarię portalu (ponowienie, przerwanie, zapis „– NIEKOMPLETNE”) i kodek,
który nie startuje. Wymaga Node.js 22+, GNU tar, gzip, xz i unzip. Przycisków w portalu testy nie obejmują.

## Licencja

[GNU GPL w wersji 3 lub dowolnej późniejszej](LICENSE) (`GPL-3.0-or-later`). Możesz skrypt
używać, zmieniać i rozpowszechniać; jeśli rozpowszechniasz zmienioną wersję albo program,
który go zawiera, musi on pozostać na GPL i z kodem źródłowym. Kodeki mają własne licencje
(tabela wyżej), zgodne z GPL-3.0.

---

🤖 **Vibecoded** – kod, testy i dokumentację napisał Claude Opus 5.5 (Anthropic) na polecenie autora.
