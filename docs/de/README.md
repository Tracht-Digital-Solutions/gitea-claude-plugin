# Gitea für Claude Code

Ein [Claude-Code](https://code.claude.com)-Plugin, das Claude mit **jeder Gitea-Instanz** verbindet – gitea.com oder einem eigenen, selbst gehosteten Server (auch in Docker). Es bringt einen gebündelten MCP-Server mit **126 Tools** und **7 Workflow-Skills** für Repositories, Dateien, Branches, Issues, Pull Requests und Reviews, Organisationen und Teams, Gitea Actions, Releases, Webhooks und Benachrichtigungen mit.

> English documentation: [README.md](../../README.md)

## Funktionsumfang

| Bereich            | Möglichkeiten                                                                                                                                                                                                   |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Repositories**   | auflisten, suchen, Details, anlegen, Einstellungen, Sichtbarkeit, archivieren, forken, löschen (mit Bestätigung), Topics                                                                                        |
| **Dateien**        | lesen, Verzeichnisse und Bäume anzeigen, Dateien per Glob finden, Inhalte durchsuchen, anlegen/ändern/löschen, Commits mit mehreren Dateien, Datei zwischen Refs vergleichen                                    |
| **Git**            | Branches, Commits mit Diffs, Historienanalyse, Refs vergleichen, Tags, Commit-Status, Branch- und Tag-Schutz, lokales Repository prüfen und pushen                                                              |
| **Issues**         | nach Priorität, Labels, Zuständigkeit, Milestone filtern; repository-übergreifend suchen; anlegen, bearbeiten, zuweisen, labeln, kommentieren, schließen/öffnen; Backlog-Zusammenfassung; Labels und Milestones |
| **Pull Requests**  | auflisten, erstellen, bearbeiten, Diff, Dateien, Commits, Reviews und Inline-Kommentare, Review-Anfragen, Prüfung der Merge-Voraussetzungen, Merge (mit Bestätigung), Branch aktualisieren, schließen           |
| **Organisationen** | Benutzer, Organisationen, Mitglieder, Teams, Teammitglieder, Collaborators, Analyse der Zugriffsrechte                                                                                                          |
| **Gitea Actions**  | Workflows und deren YAML, Runs, Jobs, Logs, Fehleranalyse, erneut ausführen, starten, abbrechen, Artefakte                                                                                                      |
| **Releases**       | auflisten, erstellen (mit generierten Release Notes), bearbeiten, löschen, Assets hochladen/löschen, Release Notes erzeugen, Releases vergleichen                                                               |
| **Weiteres**       | Webhooks (Repository und Organisation), Benachrichtigungen, Repository-Analyse                                                                                                                                  |

Alle Tools: [docs/TOOLS.md](../TOOLS.md). Skills (Aufruf mit `/gitea:<name>` oder einfach in natürlicher Sprache): `setup`, `pr-from-changes`, `pr-review`, `issue-triage`, `ci-failures`, `release`, `repo-overview`.

## Voraussetzungen

- Claude Code 2.1 oder neuer
- **Node.js ≥ 22.19** im `PATH` (der MCP-Server ist eine einzelne gebündelte Datei – kein `npm install`, kein Build)
- Eine Gitea-Instanz mit aktivierter API und ein persönliches Zugriffstoken (getestet mit Gitea 28.2; ältere Versionen und Forgejo werden per Feature-Erkennung unterstützt)

## Installation

In Claude Code:

```text
/plugin marketplace add jtracht/claude-code-gitea
/plugin install gitea@jtracht-gitea
```

Oder im Terminal:

```bash
claude plugin marketplace add jtracht/claude-code-gitea
claude plugin install gitea@jtracht-gitea
```

Ohne SSH-Schlüssel für GitHub vorher `CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1` setzen.

## Verbindung zur eigenen Gitea-Instanz

1. In Gitea **Einstellungen → Anwendungen → Zugriffstoken verwalten** öffnen und ein Token erzeugen. Empfohlene Berechtigungen für die tägliche Arbeit: `write:repository`, `write:issue`, `write:user`, `read:organization`, `write:notification` (nur lesend: die jeweiligen `read:`-Varianten).
2. In Claude Code `/plugin` → **gitea** → **Configure** öffnen und eintragen:
   - **Gitea server URL**: z. B. `https://git.tracht-digital.de`
   - **Gitea API token**: das erzeugte Token – es wird im Schlüsselbund bzw. der Anmeldeinformationsverwaltung des Betriebssystems gespeichert, nicht in `settings.json`
3. `/reload-plugins` ausführen.
4. Claude bitten: _„Teste die Gitea-Verbindung.“_ – `connection_test` zeigt Version, Benutzer, Token-Berechtigungen, unterstützte Funktionen und freigegebene Operationsstufen.

**Eigene Zertifizierungsstelle:** Bei internen oder selbst signierten Zertifikaten unter _CA certificate file_ die PEM-Datei der CA angeben oder _Trust the operating system CA store_ aktivieren. Die TLS-Prüfung wird nie abgeschaltet.

## Optionen

| Option                              | Standard | Bedeutung                                                                                |
| ----------------------------------- | -------- | ---------------------------------------------------------------------------------------- |
| Gitea server URL                    | –        | Basis-URL, `https://` erforderlich                                                       |
| Gitea API token                     | –        | sicher im Betriebssystem gespeichert                                                     |
| Allow write operations              | an       | Anlegen/Bearbeiten von Repositories, Dateien, Branches, Issues, PRs, Releases            |
| Allow destructive operations        | **aus**  | Löschvorgänge – jeder einzelne erfordert zusätzlich Ihre Bestätigung                     |
| Allow administrative operations     | **aus**  | Organisationen, Teams, Collaborators, Schutzregeln, Webhooks – mit Bestätigung           |
| CA certificate file                 | –        | PEM-Datei einer eigenen CA                                                               |
| Trust the operating system CA store | aus      | Zertifikatsspeicher des Betriebssystems zusätzlich vertrauen                             |
| Profiles file                       | –        | JSON-Datei mit weiteren Gitea-Servern ([Beispiel](../../examples/profiles.example.json)) |
| Allow insecure HTTP                 | aus      | nur für lokale Testinstanzen                                                             |

Details, mehrere Server (Profile) und Umgebungsvariablen: [docs/CONFIGURATION.md](../CONFIGURATION.md).

## Beispiele

- „Zeige mir meine Gitea-Repositories.“
- „Erstelle ein neues privates Repository.“
- „Analysiere alle offenen Issues.“
- „Zeige die fehlgeschlagenen Gitea-Actions-Runs.“
- „Erstelle aus meinen Änderungen einen Pull Request.“
- „Analysiere den letzten Pull Request.“
- „Erstelle einen Release für dieses Repository.“
- „Vergleiche die letzten beiden Releases.“
- „Zeige mir alle offenen Aufgaben des Projekts.“

Arbeiten Sie in einem Klon, dessen Remote auf Ihren Gitea-Server zeigt, werden `owner` und `repo` automatisch erkannt.

## Sicherheit

- Das Token liegt im Credential-Store des Betriebssystems, wird nur an die konfigurierte Adresse gesendet und aus allen Logs, Fehlermeldungen und Tool-Ergebnissen entfernt.
- `http://` wird nur nach ausdrücklicher Freigabe verwendet; Weiterleitungen zu anderen Hosts werden nie mit Zugangsdaten verfolgt.
- Operationen sind in **lesend**, **schreibend**, **destruktiv** und **administrativ** unterteilt. Destruktive und administrative Tools werden erst nach Freigabe überhaupt registriert.
- Löschen, Mergen, Sichtbarkeits- und Berechtigungsänderungen erfordern eine **informierte Bestätigung**: Claude Code fragt Sie direkt (MCP-Elicitation), oder der Aufruf benötigt ein Bestätigungstoken, das Claude erst nach Ihrer Zustimmung senden darf.
- Lokale Git-Befehle laufen ohne Shell mit geprüften Argumenten; Datei-Uploads sind auf das Arbeitsverzeichnis beschränkt.

Siehe auch [SECURITY.md](../../SECURITY.md) und [docs/ARCHITECTURE.md](../ARCHITECTURE.md).

## Fehlerbehebung

| Meldung                  | Lösung                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------ |
| `NOT_CONFIGURED`         | URL und Token über `/plugin` → gitea → Configure setzen, dann `/reload-plugins`.                 |
| `UNAUTHORIZED`           | Token ungültig, abgelaufen oder widerrufen – neues Token erzeugen.                               |
| `FORBIDDEN … scope`      | Dem Token fehlt die genannte Berechtigung.                                                       |
| `TLS_ERROR`              | Eigene CA: _CA certificate file_ oder _Trust the operating system CA store_ setzen.              |
| `REDIRECT_BLOCKED`       | Die endgültige, kanonische URL eintragen (Schema, Host, Unterpfad).                              |
| `PERMISSION_DENIED`      | Die Operationsstufe ist in den Plugin-Optionen deaktiviert.                                      |
| `UNSUPPORTED`            | Die Gitea-Version bietet diese API nicht; `connection_test` listet die unterstützten Funktionen. |
| MCP-Server startet nicht | `node --version` prüfen (≥ 22.19) und `claude mcp list`; `GITEA_LOG_LEVEL=debug` für Details.    |

Ausführlich: [docs/INSTALLATION.md](../INSTALLATION.md#troubleshooting).

## Entwicklung

```bash
npm ci
npm run check            # Typprüfung, Linting, Formatierung, Unit- und MCP-Tests, Build, Smoke-Test
npm run gitea:up         # isolierte Gitea-Instanz + Actions-Runner in Docker (nur 127.0.0.1)
npm run test:integration # testet jedes Tool gegen diese Instanz und prüft jeden Request gegen die OpenAPI-Spezifikation
npm run gitea:down
```

Beiträge sind willkommen – siehe [CONTRIBUTING.md](../../CONTRIBUTING.md).

## Lizenz

[Apache License 2.0](../../LICENSE).
