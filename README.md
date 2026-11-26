# OpenSafe

Free home inventory and asset manager for Windows. Record what you own: photos, receipts, serial numbers, warranties, insurance and service history. Add items from your phone or tablet with OpenSafe Capture.

Everything stays on your PC. There's no account, no cloud and no subscription.

![Dashboard](docs/dashboard.png)

## Features

- **Items:** name, category, location, brand, model, serial number, condition, status (owned, lent out, in repair, sold, disposed, lost/stolen), purchase date and price, supplier, current value, warranty end date, insurer, policy number, insured value, tags and notes.
- **Photos and documents:** drag in photos, receipts, manuals and warranty cards (PDF, images, Office files). Choose a cover photo and click any photo to enlarge it.
- **Service log:** MOTs, services, repairs, batteries and inspections, with cost, mileage and a "next due" date.
- **Reminders:** warranty end dates and next-due service dates, looking ahead a number of days you choose, plus a Windows notification at start-up for anything due within 7 days.
- **Dashboard:** total value, amount paid, insured value, value by category, what's coming up, and gaps to fill (no serial number, no receipt, no insurer, no photo).
- **Reports:** a printable PDF inventory for your insurer, with photos, and a CSV export for Excel.
- **Password protection and vault:** AES-256 encryption of everything, a recovery key, and a PIN-protected vault for sensitive items and files.
- **Backups:** a copy of your item list every day, kept for 30 days, plus a full backup (with photos and documents) to any folder or USB stick, and restore.
- **OpenSafe Capture:** an offline phone and tablet app for adding items with photos, imported on the PC from one file.

## Password protection and the vault

**Settings → Password protection** encrypts everything OpenSafe stores: the item list, photos, documents and daily backups.

- **Encryption:** files are encrypted with AES-256-GCM using a random master key. The master key is stored only in wrapped form, encrypted with a key derived from your password (scrypt, N=2¹⁷).
- **Asking for the password:** OpenSafe asks for it every time it opens. **🔒 Lock OpenSafe** locks it straight away. Five wrong passwords in a row add a 30-second wait, which doubles each time.
- **Recovery key:** when you turn protection on, you get a 24-character recovery key, shown once. It resets a forgotten password or vault PIN. **If you lose both the password and the recovery key, the data can't be recovered.**
- **Turning it off:** protection can be turned off, which decrypts everything again, or the password changed. A new recovery key can be made at any time, and the old one then stops working.

**The vault** is a second layer, opened with a separate 4–8 digit PIN:

- **What goes in:** move a whole item into the vault, or put single photos and documents in it, such as an ID scan or a V5C logbook.
- **Separate key:** vault items and files are encrypted with their own key, which is unlocked by the PIN or the recovery key.
- **While locked:** vault items are hidden and left out of totals, reminders, reports and CSV exports. Vault files show only as "Vault file".
- **Locking:** the vault locks when OpenSafe locks or closes, or with **Lock vault**.

Notes:
- Photos are decrypted in memory to show them. A document you open is decrypted into a private temporary folder, which is deleted when OpenSafe locks or closes.
- PDF reports and CSV exports are saved unencrypted, because they're meant for sharing.
- A full backup to a folder stays encrypted. Restoring an encrypted backup needs the password that was in use when the backup was made.
- Protection guards against someone reading your files, for example from a stolen laptop or a copied backup. It can't protect against malware running on your PC while OpenSafe is unlocked.

## Adding items from your phone or tablet: OpenSafe Capture

OpenSafe Capture is a small app for your phone or tablet that works offline. You add items with photos, details and receipts, then export them all as one `.opensafe` file to import on the PC. It needs no Wi-Fi link, firewall changes or account, and nothing leaves the device until you export.

1. On your phone, open **https://guestymark-spr.github.io/OpenSafe/** in Chrome, or scan the QR code on OpenSafe's **Phone** screen. Tap **Install** (or ⋮ → **Add to Home screen**).
2. Add items. They're saved on the device.
3. Tap **Export to PC**. Send the file with Quick Share, Bluetooth, email, Google Drive or OneDrive, or save it to Downloads and copy it over USB.
4. On the PC, click **Import from phone…**, double-click the `.opensafe` file, or drag it into the OpenSafe window.

Importing the same file twice is safe. Items already imported are skipped, details you edited on the PC are kept, and only new photos or receipts are added.

The app is an installable web app (PWA) served from the `mobile/` folder through GitHub Pages. It stores items in the browser's IndexedDB on the device.

## Wi-Fi link (advanced)

![Phone link](docs/phone-link.png)

OpenSafe can also run a small web server on your home network, so a phone on the same Wi-Fi can add items straight to the PC. It's off until you switch it on under **Phone → Wi-Fi link**, and it needs the pairing code from the QR code. Some routers and phone browsers block this kind of connection. The Phone screen has a **Fix Windows Firewall** button and a connection log to help you sort it out.

## Install

Download `OpenSafe-Setup-x.y.z.exe` from [Releases](../../releases), or from the latest run under **Actions → Build Windows app → Artifacts**. The app isn't code-signed, so Windows SmartScreen may warn you: choose **More info → Run anyway**.

### Automatic updates

The installed version checks GitHub for a new release when it starts and every 4 hours. It downloads updates quietly in the background, then shows a **Restart now** bar. If you choose **Later**, the update installs the next time you close OpenSafe. Your items, photos and settings are kept. Check for updates yourself under **Settings → Updates**.

The portable exe and the zip can't update themselves, so use `OpenSafe-Setup` to get updates.

Your data is saved in `%APPDATA%\OpenSafe\data`. **Settings → Open data folder** opens it.

## Build it yourself

```bash
npm install
npm start          # run in development
npm test           # data and phone-link tests
npm run dist:win   # installer + portable exe (run on Windows)
```

Every push to `main` builds the Windows installer through GitHub Actions. If the `version` in `package.json` hasn't been released yet, the build is also published as a GitHub release (tag `v<version>`), and installed copies update themselves.

To release an update:

```bash
npm run release:patch   # 1.0.0 -> 1.0.1 (fixes)
npm run release:minor   # 1.0.1 -> 1.1.0 (new features)
```

Or just change `version` in `package.json` and push. The repo must be public for the app to see releases.

## Project layout

```
src/main.js         Electron main process: window, file dialogs, PDF/CSV export, IPC
src/preload.js      Safe bridge between the window and the main process
src/store.js        Data store (JSON file + attachments folder, daily backups, encryption, vault)
src/secure.js       Encryption primitives (AES-256-GCM, scrypt, recovery key, X25519)
src/phoneServer.js  Wi-Fi phone link (token-protected local web server)
src/report.js       Insurance/inventory PDF layout
src/renderer/       Desktop UI (plain HTML/CSS/JS)
src/phone/          Phone page for the Wi-Fi link
mobile/             OpenSafe Capture phone/tablet app (published to GitHub Pages)
test/               Unit tests and a screenshot smoke test
```

MIT licence.
