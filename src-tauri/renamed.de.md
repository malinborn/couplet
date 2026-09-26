# md-mini heißt jetzt couplet

**Powerful for you and your AI, yet minimalistic.**

Dieselbe App, dieselben KI-Funktionen, ein neuer Name. Alles, was du hattest, ist von selbst mitgekommen: offene Fenster, Cursorpositionen, ungesicherte Entwürfe, Wiederherstellungskopien, dein Theme und deine zuletzt geöffneten Dateien.

## Was zu tun ist — einmal, ein paar Minuten

1. **Starte die Sitzungen deiner KI-Agenten neu.** Eine Sitzung, die vor dem Update geöffnet wurde, hängt noch am alten md-mini und sieht couplet erst nach einem Neustart.
2. **Bring es deinem Agenten neu bei.** Öffne **KI → Bring deiner KI couplet bei**, kopiere den Prompt und gib ihn deinem Agenten. Er registriert den MCP-Server `couplet` anstelle von `mdmini`, ersetzt den Skill `mdmini` durch `couplet`, aktualisiert die Notiz in `CLAUDE.md` (oder in der Konfiguration deines Agenten) und sagt dir am Ende, was er geändert hat.
3. **Wenn du aus der DMG installiert hast und nicht über Homebrew,** lösche `/Applications/md-mini.app`. Deine Daten sind schon in couplet, und die alte App startet leer, falls du sie versehentlich öffnest.

## Warum wir uns umbenannt haben

**Es gibt zwei Apps namens mdmini.** Der anderen gehört mdmini.com. Zwei kleine Editoren mit demselben Namen bedeuten verwirrende Suchergebnisse, hin und wieder einen falschen Download und Fehlerberichte über die App von jemand anderem. Das wollten wir nicht zu deinem Problem machen, also sind wir beiseitegetreten, statt um den Namen zu kämpfen.

**Und der alte Name hat nicht mehr gestimmt.** md-mini hat als minimalistischer Markdown-Editor angefangen. Geworden ist daraus eine Seite, an der du und dein KI-Agent gemeinsam arbeitet. Der Agent springt mit dir zu einer Zeile, schreibt das offene Dokument um, während du zusiehst, fragt mit echten Buttons nach und antwortet auf die Kommentare, die du am Rand hinterlässt. Ein Couplet ist ein Reimpaar: zwei Zeilen, die sich wie eine lesen, und genau darum geht es jetzt. Der Minimalismus bleibt: Er ist unsere Art zu bauen, nur nicht mehr der ganze Zweck.

## Was auch ohne das funktioniert

| | |
|---|---|
| **Terminal** | `mdmini` funktioniert weiter als zweiter Name für `couplet`, daneben gibt es das kurze `coup`. Skripte, Aliase und `$EDITOR` brauchen keine Änderung. |
| **KI-Agenten** | Eine MCP-Registrierung unter dem Namen `mdmini` funktioniert nach einem Neustart des Agenten weiter, sofern sie den Befehl `mdmini` aufruft – so hat sie „Teach Your AI“ eingerichtet. Eine Registrierung mit dem vollständigen Pfad zu `md-mini.app` funktioniert nicht mehr: Das behebt Schritt 2. |
| **Homebrew** | `brew upgrade --cask mdmini` stellt dich auf couplet um und funktioniert auch danach weiter. |
| **Deine Daten** | Wurden beim ersten Start aus dem Ordner von md-mini in den von couplet verschoben. Im Ordner von md-mini liegt eine Notiz, wohin sie gegangen sind. |

## Wo du uns findest

Die Website ist jetzt **couplet.pro**, und die alte Adresse md-mini.com führt ebenfalls dorthin. Der Code bleibt, wo er war, auf GitHub.

Danke, dass du von Anfang an dabei bist. Das Notizbuch ist dasselbe, es hat jetzt nur einen Namen, der besser zu dem passt, was es tut.
