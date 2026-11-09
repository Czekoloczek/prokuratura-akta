# Portal Przeglądania Akt – pobieranie dokumentów

Nieoficjalny skrypt użytkownika (userscript) do
[Portalu Przeglądania Akt](https://przegladanieakt.prokuratura.gov.pl) prokuratury.
Portal pozwala zdigitalizowane akta tylko oglądać – skrypt dodaje panel, który zapisuje je na dysku:

- **Pobierz otwarty dokument (PDF)** – dokument otwarty w przeglądarce akt,
  np. `<sygnatura> – 12. Protokół przesłuchania świadka (k. 30-34).pdf`;
- **Pobierz całe akta (ZIP z PDF-ami)** – wszystkie dokumenty z drzewa akt: folder na tom,
  PDF na dokument i `spis-dokumentow.csv` (otwiera się w LibreOffice i Excelu).

Strony w PDF-ie mają etykiety kart jak w aktach („k. 12”, „k. 12v” dla rewersu).
Obrazy stron trafiają do PDF-a bez ponownej kompresji, więc jakość jest taka jak na ekranie.

> Skrypt nie jest związany z Prokuraturą Krajową. Działa tylko po zalogowaniu i pobiera
> wyłącznie to, co portal i tak wyświetla zalogowanemu użytkownikowi.

## Instalacja

1. Zainstaluj menedżer skryptów: [Violentmonkey](https://violentmonkey.github.io/) (zalecany)
   albo Tampermonkey.
2. Otwórz [pobieranie-akt.user.js](https://raw.githubusercontent.com/Czekoloczek/prokuratura-akta/main/pobieranie-akt.user.js) –
   menedżer pokaże okno instalacji.
3. Zaloguj się do portalu i otwórz akta sprawy. W prawym dolnym rogu pojawi się panel
   „⬇ Pobieranie akt”; kliknięcie nagłówka zwija go do małego paska.

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

Przetestowane na udostępnieniu internetowym (strony w PNG, jeden tom). Na żywo nie było
jeszcze okazji sprawdzić: załączników do dokumentów, wyłączeń stron, wersji dokumentów,
akt większych niż 1,5 GB (ZIP dzielony na części) i bardzo długiego pobierania
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
PDF i ZIP składa sam skrypt, bez bibliotek: JPEG i PNG są osadzane bez dekodowania
(PNG z predyktorem Flate), inne formaty – przez canvas. Portal zapisuje w PNG domyślne
96 DPI z .NET, choć skany mają 200 DPI, dlatego strony spoza zakresu A7–A3 dostają rozmiar A4.

## Testy

```
node testy/test-rdzen.cjs /tmp/test-akta
```

Sprawdza CRC-32, PDF (JPEG bajt w bajt, PNG piksel w piksel – przez `pdfinfo` i `pdfimages`
z popplera), ZIP (`unzip -t`), nazwy plików i etykiety kart. Wymaga Node.js 18+,
ImageMagick 7, popplera i unzip.

## Licencja

[GNU GPL w wersji 3 lub dowolnej późniejszej](LICENSE) (`GPL-3.0-or-later`). Możesz skrypt
używać, zmieniać i rozpowszechniać; jeśli rozpowszechniasz zmienioną wersję albo program,
który go zawiera, musi on pozostać na GPL i z kodem źródłowym.
