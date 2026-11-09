# Portal Przeglądania Akt – pobieranie dokumentów

Nieoficjalny skrypt użytkownika (userscript) do
[Portalu Przeglądania Akt](https://przegladanieakt.prokuratura.gov.pl) prokuratury.
Portal pozwala zdigitalizowane akta tylko oglądać – skrypt dodaje do niego pobieranie:

- **Pobierz otwarty dokument** – dokument otwarty w przeglądarce akt,
  np. `<sygnatura> – 12. Protokół przesłuchania świadka (k. 30-34).pdf`;
- **Pobierz całe akta** – wszystkie dokumenty z drzewa akt w jednym archiwum: folder na tom,
  dokument jako PDF albo folder ze stronami i `spis-dokumentow.csv` (otwiera się w LibreOffice i Excelu).

Strony mają oznaczenia kart jak w aktach („k. 12”, „k. 12v” dla rewersu) – jako etykiety stron
w PDF-ie albo w nazwach plików (`k. 012.png`, `k. 012v.png`).

## Formaty

| Format | Co dostajesz |
|---|---|
| **PDF – oryginalne skany** (domyślnie) | strony z portalu w PDF-ie bajt w bajt – bez strat i zwykle najmniejszy plik |
| PNG – oryginalne skany | dokładnie pliki, które wysyła portal, po jednym na stronę |
| PDF ze stronami w JPEG | stratnie, z wyborem jakości |
| JPEG / WebP | stratnie, plik na stronę, z wyborem jakości |

Archiwum (całe akta albo dokument jako obrazy): **ZIP**, **ZIP z kompresją**, **TAR** albo **TAR.GZ**.

Portal wysyła strony jako PNG z 16 kolorami (ok. 200 DPI), co jest już bardzo oszczędne.
Na prawdziwym, 3-stronicowym dokumencie (oryginały: 332 kB) wyszło:

| Format | Rozmiar |
|---|---|
| PNG / PDF – oryginalne skany | 332 kB / 335 kB |
| WebP, jakość 80 | 686 kB (ok. 2×) |
| PDF z JPEG, jakość 60 | 778 kB (ok. 2,3×) |
| JPEG, jakość 80 | 1085 kB (ok. 3,3×) |

Formaty stratne przydają się więc dla programów, które nie czytają PNG, a nie do oszczędzania miejsca.
Z tego samego powodu kompresja archiwum zmniejsza PDF-y i obrazy najwyżej o kilka procent.

Konwersja do JPEG/WebP odbywa się w przeglądarce (canvas). Jeśli przeglądarka blokuje albo zaszumia
odczyt z canvas (ochrona przed fingerprintingiem, np. `privacy.resistFingerprinting` we Firefoksie),
skrypt przerwie konwersję z komunikatem – formaty „oryginalne skany” działają zawsze.

> Skrypt nie jest związany z Prokuraturą Krajową. Działa tylko po zalogowaniu i pobiera
> wyłącznie to, co portal i tak wyświetla zalogowanemu użytkownikowi.

## Instalacja

1. Zainstaluj menedżer skryptów: [Violentmonkey](https://violentmonkey.github.io/) (zalecany)
   albo Tampermonkey.
2. Otwórz [pobieranie-akt.user.js](https://raw.githubusercontent.com/Czekoloczek/prokuratura-akta/main/pobieranie-akt.user.js) –
   menedżer pokaże okno instalacji.
3. Zaloguj się do portalu i otwórz akta sprawy. Skrypt dodaje:
   - przycisk **Pobierz akta** w pasku nad drzewem akt (obok „Przejdź do wniosku”) – otwiera dymek
     z pobieraniem, wyborem formatu i postępem;
   - ikonę pobierania w pasku przeglądarki dokumentu (obok trybu pełnoekranowego) – od razu pobiera
     otwarty dokument w wybranym formacie.

   Gdy portal nie pokazuje paska nad drzewem (udostępnienia bez prawa do wniosku), zamiast przycisku
   pojawia się wąska zakładka „Pobierz akta” przy prawej krawędzi ekranu.

## Prywatność i obciążenie portalu

- Skrypt działa wyłącznie w Twojej przeglądarce i łączy się tylko z portalem. Niczego nigdzie
  nie wysyła, nie ma telemetrii ani zewnętrznych bibliotek – cały kod jest w jednym pliku.
- Pobiera po 2 strony naraz, z odstępem między żądaniami – regulamin portalu (§ 12) zabrania
  działań utrudniających jego funkcjonowanie. Przy długim pobieraniu przedłuża sesję tak,
  jak przycisk w okienku o wygasającej sesji.
- Nośników (płyt, nagrań) portal nie udostępnia zdalnie, tylko w czytelni prokuratury –
  skrypt ich nie pobiera, wpisuje je jedynie do spisu.

## Uwagi prawne

- W postępowaniu przygotowawczym sporządzanie kopii akt wymaga zgody prowadzącego
  postępowanie (art. 156 § 5 KPK). Sprawdź, czy zarządzenie o udostępnieniu akt ją obejmuje.
- Publiczne rozpowszechnianie wiadomości z postępowania przygotowawczego, zanim zostały
  ujawnione w postępowaniu sądowym, jest przestępstwem (art. 241 § 1 KK).
- Skrypt jest dostarczany „tak jak jest”, bez żadnej gwarancji. Za sposób korzystania
  z pobranych akt odpowiada użytkownik.

## Ograniczenia

Przetestowane na udostępnieniu internetowym (strony w PNG, jeden tom) w przeglądarce opartej
na Chromium: wszystkie formaty i archiwa, przyciski w paskach portalu i zakładka zapasowa.
Na żywo nie było jeszcze okazji sprawdzić: załączników do dokumentów, wyłączeń stron, wersji
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
PDF i archiwa składa sam skrypt, bez bibliotek: JPEG i PNG są osadzane bez dekodowania
(PNG z predyktorem Flate), inne formaty – przez canvas. Portal zapisuje w PNG domyślne
96 DPI z .NET, choć skany mają 200 DPI, dlatego strony spoza zakresu A7–A3 dostają rozmiar A4.

## Testy

```
node testy/test-rdzen.cjs /tmp/test-akta
```

Sprawdza CRC-32, PDF (JPEG bajt w bajt, PNG piksel w piksel – przez `pdfinfo` i `pdfimages`
z popplera), archiwa ZIP, ZIP z kompresją, TAR i TAR.GZ (`unzip -t`, GNU tar, `gzip -t`, długie
polskie nazwy przez nagłówki PAX), nazwy plików i etykiety kart. Wymaga Node.js 18+, ImageMagick 7,
popplera, unzip, GNU tar i gzip. Konwersji przez canvas i przycisków w portalu test nie obejmuje.

## Licencja

[GNU GPL w wersji 3 lub dowolnej późniejszej](LICENSE) (`GPL-3.0-or-later`). Możesz skrypt
używać, zmieniać i rozpowszechniać; jeśli rozpowszechniasz zmienioną wersję albo program,
który go zawiera, musi on pozostać na GPL i z kodem źródłowym.
