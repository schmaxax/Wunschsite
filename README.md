# 🎁 Wunschsite – Deine persönliche Wunschliste im Web

**Wunschsite** ist eine moderne Web-App, mit der du deine Wünsche ganz einfach online speichern, organisieren und teilen kannst.  
Egal ob Geburtstagswünsche, Weihnachtsgeschenke oder kleine Herzenswünsche – Wunschsite hilft dir, den Überblick zu behalten und deine Liste mit Freunden oder Familie zu teilen. 💫

---

## ✨ Features

- 🧾 **Persönliche Wunschlisten** – Erstelle deine eigene Liste mit beliebig vielen Einträgen.  
- 🎨 **Modernes Design** – Einfach, übersichtlich und benutzerfreundlich gestaltet.  
- 🔗 **Teilen mit anderen** – Teile deine Wunschliste per Link oder QR-Code.  
- 🎯 **Reservierungen** – Wünsche können „reserviert“ werden, um doppelte Geschenke zu vermeiden.  
- 🪄 **Login & Profile** – Melde dich an, verwalte deine eigenen Listen und bearbeite sie jederzeit.  
- 📱 **Responsive Design** – Funktioniert auf Desktop, Tablet und Smartphone.  

---

## 🧰 Technischer Aufbau

| Bereich       | Technologie |
|----------------|-------------|
| **Frontend**   | HTML, CSS und JavaScript ohne Framework, Retro-Desktop-Look |
| **Backend**    | Node.js mit Express |
| **Datenbank**  | SQLite (in Node eingebaut, `node:sqlite`) |
| **Hosting**    | Eigener Webserver bzw. jeder Hoster, der Node.js ausführt |

**Wer braucht ein Konto?** Nur wer eine Liste anlegt. Gäste öffnen den geteilten Link,
reservieren mit ihrem Namen und können die Reservierung im selben Browser wieder aufheben.
Die Person, der die Liste gehört, sieht keine Reservierungen – damit die Überraschung bleibt.

```
public/          Webseiten, CSS, JavaScript und Pixel-Icons
  index.html     Startseite mit Anmeldung
  app.html       „Meine Listen“ (nur mit Konto)
  liste.html     Geteilte Liste für Gäste (/l/<code>)
server/          Express-Server, Datenbank, Login
data/            SQLite-Datenbank (wird automatisch angelegt, nicht in Git)
```

---

## 🚀 Ziel des Projekts

Das Ziel von **Wunschsite** ist es, eine **einfache, schöne und benutzerfreundliche Plattform** zu schaffen,  
die das Teilen von Wünschen und Geschenkideen so leicht wie möglich macht –  
ohne Werbung, ohne Kommerz, einfach mit Freude am Schenken und Beschenktwerden. 🎉

---

## 🛠️ Installation (lokal)

```bash
# Repository klonen
git clone https://github.com/schmaxax/Wunschsite.git

# In das Projektverzeichnis wechseln
cd Wunschsite

# Abhängigkeiten installieren
npm install

# Server starten (danach http://localhost:3000 öffnen)
npm start

# Oder mit automatischem Neustart bei Änderungen
npm run dev
```

Benötigt wird **Node.js 22.5 oder neuer**. Port und Speicherort der Datenbank lassen sich
über die Umgebungsvariablen `PORT` und `DATA_DIR` ändern.
