# Connecting Google accounts to Kairos

One Google Cloud project — created once, under any of your Google accounts — serves
**all** the accounts you'll ever connect. You do NOT repeat this per account. After
this one-time setup, connecting each account is a normal "Sign in with Google" in
your browser.

## One-time: create the OAuth client (~5 minutes)

1. **Open** [console.cloud.google.com](https://console.cloud.google.com) signed in
   with any of your Google accounts (whichever you want to "own" the project — it
   makes no difference for the others).

2. **Create the project**: project picker in the top bar → *New project* → name it
   `Kairos` → *Create*. Make sure it's selected afterwards.

3. **Enable the APIs** (*APIs & Services → Library*):
   - search **Gmail API** → *Enable*
   - search **Google Calendar API** → *Enable* (used by the upcoming calendar
     feature — enabling it now is free and saves a trip back here)

4. **Configure the consent screen** (*APIs & Services → OAuth consent screen* —
   newer consoles call this *Google Auth Platform*):
   - User type / audience: **External**
   - App name `Kairos`, pick your email for the support + developer contact fields
   - Skip optional branding, scopes, and test users — none of it is needed
   - **Publish the app**: on the consent screen / *Audience* page, change the
     publishing status from *Testing* to **In production** (button says *Publish
     app*). It warns about verification — ignore it. This step matters: in Testing
     mode Google expires refresh tokens after **7 days** and every account would
     demand reconnecting weekly.

5. **Create the client** (*APIs & Services → Credentials*):
   - *Create credentials → OAuth client ID*
   - Application type: **Desktop app**, name `Kairos` → *Create*
   - Copy the **Client ID** and **Client secret**

6. **Paste into Kairos**: Settings (sidebar gear) → Connections → *API credentials
   (one-time setup)* → Google fields. Saved on blur.

## Per account: connect (repeat for every Google account)

1. Settings → Connections → **+ Gmail**
2. Your browser opens Google's account chooser — pick the account.
3. Google shows **"Google hasn't verified this app"** — expected, since the app is
   yours and unverified. Click *Advanced* → *Go to Kairos (unsafe)*.
4. Approve the requested access (read + send mail). The tab says "Connected to
   Kairos" — close it. The account appears in Settings and starts backfilling the
   last 30 days.

Repeat *+ Gmail* for each additional account; the account chooser is forced every
time (`prompt=select_account`), so already-connected accounts never get in the way.

## Notes

- The client ID/secret in Kairos settings are **not sensitive** the way passwords
  are — Google's own docs treat installed-app client secrets as non-confidential.
  The actual per-account tokens are encrypted into the macOS Keychain
  (`safeStorage`) and never leave the app.
- When the calendar feature ships, it will request the calendar scope on top of
  Gmail's; each account will need a one-click reconnect to grant it. Same project,
  same client — nothing to redo in the console.
- To revoke an account later: Settings → Connections → *remove* (deletes local
  messages + tokens), and optionally
  [myaccount.google.com/permissions](https://myaccount.google.com/permissions) →
  Kairos → *Remove access*.
