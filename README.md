# Dark Factory Worker

Der Worker der **Dark Factory**: ein Node-Prozess, der sich aktiv mit der [Dark-Factory-App](https://github.com/startwind/dark-factory-app) (privat) verbindet, Jobs entgegennimmt und sie auf dem eigenen Rechner ausführt: Repository klonen, Branch anlegen, KI-Agenten (`codex` / `claude`) die Workflow-Schritte abarbeiten lassen, Ergebnisse validieren, pushen und Pull Request erstellen.

> **Sicherheitshinweis:** Der Worker führt Agenten und Projekt-Befehle (Shell-Schritte, Build, Tests) **direkt auf diesem Rechner** aus, mit den Rechten des aktuellen Benutzers und ohne Container-Isolation. Nur auf Rechnern betreiben, auf denen das vertretbar ist, und nur mit einer App verbinden, der du vertraust.

## Voraussetzungen

* macOS oder Linux, Node ≥ 22, `git`
* SSH-Key mit Push-Rechten auf die Ziel-Repositories (`~/.ssh` bzw. ssh-agent)
* GitHub CLI, angemeldet: `gh auth login` (für Pull Requests)
* für echte Agenten: die installierten und angemeldeten CLIs `codex` und/oder `claude`

## Installation

```bash
git clone https://github.com/startwind/dark-factory-worker.git
cd dark-factory-worker
npm install
npm run worker -- doctor     # prüft git, SSH-Key, gh und sagt, was fehlt
```

## Einrichten

```bash
npm run worker -- init       # findet codex/claude, führt den READY-Test aus, schreibt worker.config.yaml
```

Optionen für `init`:

| Option | Bedeutung |
|---|---|
| `--server ws://host:3001` | URL der App (Standard `ws://localhost:3001`) |
| `--name <name>` | Name des Workers |
| `--max-jobs <n>` | Tickets, die gleichzeitig bearbeitet werden (Standard 1) |

Weitere Befehle: `discover` (Agenten erneut suchen), `test [agent]` (Agenten testen), `doctor` (Werkzeuge prüfen). Beispiel-Konfiguration: [worker.config.example.yaml](worker.config.example.yaml).

`source: auto`-Agenten werden bei `discover` aktualisiert, `source: manual`-Einträge nie überschrieben oder gelöscht.

## Starten

```bash
npm run worker -- start --config worker.config.yaml
```

Der Worker hält die Verbindung per Socket.IO (Reconnect + Heartbeat) und identifiziert sich mit einem dauerhaften ed25519-Schlüsselpaar unter `~/.nova-worker/identity.json`.

Beim ersten Verbinden erscheint er in der App unter **Workers** als *Pending*. Ein Admin klickt **Approve** und weist ihm Projekte zu; die Freigabe ist an den Fingerabdruck des Schlüssels gebunden, nicht an den Namen. Erst danach bekommt er Jobs. Projektzuordnung, Komponenten-Präferenzen und Log-Freigaben werden nur in der App gepflegt.

Prozess dauerhaft laufen lassen (z. B. in einem eigenen Terminal, `tmux` oder als Dienst). Nach Änderungen an git/gh/SSH den Worker neu starten.

## Konfiguration

`worker.config.yaml` enthält nur technische Einstellungen:

* `worker.name`, `worker.maxConcurrentJobs` (komplette Tickets parallel, je eigener Workspace und Branch)
* `worker.maxParallelSteps` (unabhängige Schritte eines Tickets parallel, Standard 2; parallele Schritte teilen sich dasselbe Checkout)
* `server.url`
* `agents.<key>`: `command`, `enabled`, optional `args` / `stdin` für eigene Agenten

Workspaces liegen unter `~/.nova-worker/workspaces` (änderbar über `NOVA_WORKER_HOME`).

## Entwicklung

```bash
npm run typecheck
npm test
```

Das Repository enthält den Worker (`apps/worker`) sowie die gemeinsamen Pakete `packages/shared` und `packages/workflow-engine`, die aus der App übernommen sind.

## Fehlerbehebung

| Symptom | Lösung |
|---|---|
| Worker bleibt *Pending* | In der App unter *Workers → Approve* freigeben |
| Keine Verbindung | `--server` bzw. `server.url` prüfen; App muss vom Worker-Rechner erreichbar sein |
| „Missing: …“-Badge in der App | `npm run worker -- doctor` ausführen, Hinweis befolgen, Worker neu starten |
| Agent: „authentication failed“ | CLI-Login (`codex` / `claude`) auf diesem Rechner durchführen |
