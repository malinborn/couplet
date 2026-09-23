# md-mini heißt jetzt couplet

**Powerful for you and your AI, yet minimalistic.**

Dieselbe App, dieselben KI-Funktionen, ein neuer Name. Alles, was du hattest, ist von selbst mitgekommen: offene Fenster, Cursorpositionen, ungesicherte Entwürfe, Wiederherstellungskopien, dein Theme und deine zuletzt geöffneten Dateien.

## Warum wir uns umbenannt haben

**Es gibt zwei Apps namens mdmini.** Der anderen gehört mdmini.com. Zwei kleine Editoren mit demselben Namen bedeuten verwirrende Suchergebnisse, hin und wieder einen falschen Download und Fehlerberichte über die App von jemand anderem. Das wollten wir nicht zu deinem Problem machen, also sind wir beiseitegetreten, statt um den Namen zu kämpfen.

**Und der alte Name hat nicht mehr gestimmt.** md-mini hat als minimalistischer Markdown-Editor angefangen. Geworden ist daraus eine Seite, an der du und dein KI-Agent gemeinsam arbeitet. Der Agent springt mit dir zu einer Zeile, schreibt das offene Dokument um, während du zusiehst, fragt mit echten Buttons nach und antwortet auf die Kommentare, die du am Rand hinterlässt. Ein Couplet ist ein Reimpaar: zwei Zeilen, die sich wie eine lesen, und genau darum geht es jetzt. Der Minimalismus bleibt: Er ist unsere Art zu bauen, nur nicht mehr der ganze Zweck.

## Nichts geht kaputt

| | |
|---|---|
| **Terminal** | `mdmini` funktioniert weiterhin, neben `couplet` und dem kurzen `coup`. Skripte, Aliase und `$EDITOR` brauchen keine Änderung. |
| **KI-Agenten** | Ein Agent, der couplet als `mdmini` kennt, funktioniert weiter: Der MCP-Server, seine Werkzeuge und die Notiz in der Konfiguration deines Agenten bleiben unverändert. Für eine neue Einrichtung: `claude mcp add --scope user couplet -- couplet mcp`. |
| **Homebrew** | `brew upgrade` hat dich schon umgestellt. `brew upgrade --cask mdmini` funktioniert ebenfalls weiter. |
| **Deine Daten** | Wurden beim ersten Start aus dem Ordner von md-mini in den von couplet verschoben. Im Ordner von md-mini liegt eine Notiz, wohin sie gegangen sind. |

## Wo du uns findest

Die Website ist jetzt **couplet.pro**, md-mini.com leitet dorthin weiter. Der Code bleibt, wo er war, auf GitHub.

Danke, dass du von Anfang an dabei bist. Das Notizbuch ist dasselbe, es hat jetzt nur einen Namen, der besser zu dem passt, was es tut.
