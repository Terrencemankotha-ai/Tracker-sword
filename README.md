# Abraham Tracker Sword: phone app

This is a live inflation tracker for USD, EUR, JPY, GBP and AUD. You install it on your phone's home screen, it opens full-screen like a native app, and it still works offline using the last figures it saved.

## How the live updates work

```
Official sources ──(every 30 min)──> GitHub Actions updater ──> data/inflation.json ──> your phone
BLS · ECB · ONS · ABS · OECD          scripts/fetch_inflation.py      (GitHub Pages)       (checks every minute while open)
```

* **Updater:** every 30 minutes, `scripts/fetch_inflation.py` pulls the newest figures from the official sources. It saves them to the repo only when something has changed.
* **App:** while the app is open, it checks for new data every minute. It also checks when you switch back to it and when you tap ↻.
* **New figures:** when a new release lands, that currency's card glows with a **NEW** badge, the phone vibrates, and you get a notification if alerts are on.
* **Background checks (Android, installed app):** Chrome also checks about once an hour in the background and notifies you.
* **Failures:** each source can fail without affecting the others. If one source is down, the app keeps the last good figures for that currency. The problem is listed under `problems` in `data/inflation.json` and in the Actions log.

| Currency | Source | Core measure |
|---|---|---|
| USD | BLS API (CPI-U) | ex food & energy |
| EUR | ECB Data Portal (Eurostat HICP, includes flash estimates) | ex energy, food, alcohol & tobacco |
| GBP | ONS series D7G7 / DKO8 | ex energy, food, alcohol & tobacco |
| AUD | ABS Data API, monthly CPI | trimmed mean |
| JPY | OECD (a few days after the Statistics Bureau release) | not available from this source, shown as — |

OECD is also the fallback for any other currency whose main source fails.

## Set it up (about 10 minutes, free)

1. **Create a GitHub repo.** Make it **public**, because free GitHub Pages needs that. The data is all public anyway. Name it something like `tracker-sword`.
2. **Upload everything in this folder** to the repo, including the hidden `.github` folder. The simplest way is drag-and-drop on github.com: *Add file → Upload files*. If the `.github` folder doesn't upload, create `.github/workflows/update.yml` by hand and paste in its contents.
3. **Turn on Pages:** *Settings → Pages → Build and deployment → Source: **GitHub Actions***.
4. **Allow the updater to save data:** *Settings → Actions → General → Workflow permissions → **Read and write permissions*** → Save.
5. **Run it once:** *Actions → "Update CPI data and publish app" → Run workflow*. When it goes green, your app is live at `https://<your-username>.github.io/<repo-name>/`.
6. **Check the first run's log.** If any source printed a `WARN` line, that currency is staying on its last figures. Copy the line and send it to me so I can adjust the parser.

### Optional: US Bureau of Labor Statistics key
Register free at <https://data.bls.gov/registrationEngine/>. Then add the key as a repository secret named `BLS_API_KEY` (*Settings → Secrets and variables → Actions*). This lifts the daily request limit and uses BLS's own published 12-month change.

## Put it on your phone

**Android (Chrome):** open your app's URL, then tap **Install app** in the app (or ⋮ → *Install app / Add to Home screen*). Open it from the home screen and tap **Turn on alerts**.

**iPhone (Safari):** open the URL, tap **Share → Add to Home Screen**, then open it *from the home screen icon* and tap **Turn on alerts**. iOS 16.4 or later is needed for notifications.

## Native Android and iPhone apps

The same tracker is also built as real Android and iOS apps with Capacitor. GitHub compiles them on its own machines, so you don't need Android Studio or a Mac. The apps read live figures from your Pages site and send native notifications when a new figure lands.

**Build them:** first finish "Set it up" above. Then go to *Actions → "Build phone apps" → Run workflow*. Android takes about 5 minutes and iPhone about 10. When both are done, open your repo's **Releases → "Phone apps (latest build)"**.

### Android: install it today
1. On your phone, open the release page and download **AbrahamTrackerSword.apk**.
2. Open it. If asked, allow your browser to *install unknown apps*, then tap **Install**.
3. Open the app and tap **Turn on alerts**.

**Google Play (optional):** add these four repository secrets, run the build again, and you also get **AbrahamTrackerSword-play.aab** to upload in the Play Console:
* `ANDROID_KEYSTORE_BASE64`
* `ANDROID_KEYSTORE_PASSWORD`
* `ANDROID_KEY_ALIAS`
* `ANDROID_KEY_PASSWORD`

To make the keystore once (keep the file and passwords safe, because Play needs the same key for every update):
```
keytool -genkey -v -keystore release.jks -alias tracker -keyalg RSA -keysize 2048 -validity 10000
base64 -i release.jks | pbcopy        # macOS; on Linux: base64 -w0 release.jks
```
A Google Play developer account costs $25 once.

### iPhone: choose one
Apple only lets signed apps onto an iPhone, so there are two routes.

**A. TestFlight (recommended, needs the Apple Developer Program at $99/year)**
1. In App Store Connect, create an app with bundle ID **com.abrahamsword.tracker**.
2. Under *Users and Access → Integrations → App Store Connect API*, create a key with **App Manager** access.
3. Add these repository secrets:
   * `ASC_KEY_ID` (the key ID)
   * `ASC_ISSUER_ID` (the issuer ID)
   * `ASC_KEY_P8` (the full text of the downloaded .p8 file)
   * `APPLE_TEAM_ID` (from developer.apple.com → Membership)
4. Run *Build phone apps* with **"Also upload the iPhone app to TestFlight"** ticked, or push a tag like `v1.0.1`.
5. Install **TestFlight** from the App Store on your iPhone. The app appears there after Apple's processing, usually 10–30 minutes. When you're ready, you can submit the same build to the App Store from App Store Connect.

**B. Sideload for free (no developer account)**
Download **AbrahamTrackerSword-unsigned.ipa** from the release. Install it with **Sideloadly** or **AltStore** on your computer, using your normal Apple ID. With a free Apple ID the app has to be re-installed every 7 days.

### Things to know about the phone apps
* **Updates:** figures update live without reinstalling, because the apps read `data/inflation.json` from your Pages site. You only rebuild when the app's design or code changes. If you use a custom domain, set a repository *variable* named `DATA_URL` to the full address of that file.
* **When it checks:** the apps check every minute while open and again whenever you switch back to them. When a new figure arrives you get a native notification.
* **Closed apps:** while an app is fully closed, iOS and Android don't let it check by itself. Instant alerts to a closed app would need a push service, which could be added later.
* **App ID:** both apps use `com.abrahamsword.tracker`. To use your own, change `appId` in `capacitor.config.json` before your first store upload. It can't change after that.

## Features

* **Currency cards:** headline and core CPI, distance from target, policy rate and real rate.
* **Pair view:** pick any of the 10 pairs (EUR/USD, GBP/JPY…) to see a live TradingView price chart, a bar chart comparing the two currencies (CPI, core, policy rate, real rate) and the inflation spread over 12 months.
* **Pressure scoreboard:** ranks the currencies by inflation pressure (gap to target for headline and core, plus the latest move) and names the pair with the widest gap.
* **Real interest rates:** policy rate minus CPI for each currency, ranked.
* **Countdown:** live countdown to every CPI release and rate decision, shown in your local time.
* **Alerts:** choose which currencies alert you, plus an optional reminder 15 min, 1 hour or 1 day before a release or rate decision. The phone apps schedule reminders so they arrive even when the app is closed.
* **Market news:** inflation and central-bank headlines from BBC, CNBC, MarketWatch, The Guardian, FT, FXStreet, Yahoo Finance, Nikkei Asia and ABC. They're tagged by currency, refreshed every 30 minutes, and link to the full story.
* **Looks:** five built-in styles (Midnight Blade, Ember Forge, Signal Desk, Ivory Ledger, Aurora Glass).

### Keeping policy rates current
Policy rates are kept in `data/policy_rates.json`. After a central bank decision, change `rate`, `last_decision`, `last_move` and `next_meeting` for that currency (for the Fed, also `low` and `high`). The app picks up the change within 30 minutes.

## Good to know

* **CPI comes out once a month per country.** "Real time" here means a new figure reaches your phone within about 30 minutes of the statistics office publishing it. Between releases the numbers don't change, but the green **Live** dot shows the sources are still being checked.
* **Notifications when the app is fully closed:** Android gets the hourly background check. iPhone only checks when the app is opened. Instant pushes to a closed app would need a small push server. That can be added later.
* **Release dates:** `data/calendar.json` holds upcoming release dates. Add future dates there to keep the calendar exact. Otherwise the updater estimates one month ahead and the app marks the date *est.*
* **Keeping the updater running:** GitHub pauses scheduled workflows in repos with no activity for 60 days. If the Live dot turns amber, re-enable the workflow under *Actions*.
* **Running the updater on your computer:** `python scripts/fetch_inflation.py` works with Python 3.9+ and needs no packages.
