# Claude Company for iPhone

The desk on a phone, two ways. Both open on the tower, because a tenant's first tap is
"which floor is mine".

## 1 · Today, with no Apple account: Add to Home Screen

The site declares itself an installable web app (`dist/manifest.webmanifest`, written by
`scripts/build-viewer.mjs`, plus the Apple head tags on every page). On an iPhone:

1. Open https://solana.claudedotcompany.com/tower.html in Safari.
2. Share → **Add to Home Screen** → Add.

You get a full-screen app with the Claude Company icon, no Safari chrome, the tower's
night ground behind the launch, and the same live floor. The Buy path hands off to
Phantom's in-app browser exactly as it does in Safari (the "Open this floor in Phantom"
button on the Calls tab).

## 2 · The native shell: `ios/`

A SwiftUI app whose one screen is a `WKWebView` on the same pages. It is deliberately a
shell and not a rewrite: the floor is a three.js world with sixteen analysts walking in
it, and the site is the product. What the shell adds is what a web view cannot get from
Safari:

- **Wallet handoff that works.** Any link that leaves the desk — `phantom://`,
  `solflare://`, `wc:` pairing links, Phantom's `https://phantom.app/ul/browse/…`
  universal link, pump.fun, dexscreener — is handed to iOS, so the wallet app opens
  instead of its website loading inside the shell. Our own hosts stay inside.
- `claudeco://floor/12` and `claudeco://tower` deep links (declared in `project.yml`), so
  a floor can be linked from a message and open straight in the app.
- Swipe-back navigation, pull-to-refresh, inline playback for the Guide's video, a thin
  load bar, and an "out of reach" card with a retry button when the desk cannot be
  fetched, instead of a blank white view.
- JavaScript `alert`/`confirm` rendered as native sheets. A bare `WKWebView` answers
  every `confirm()` with **false**, which would silently refuse the floor's own
  confirmation dialogs.
- The user agent carries `ClaudeCompany-iOS/1.0`, so the site can tell the shell from
  Safari if it ever needs to.

**The bot does not run on the phone.** WALL-ST-E and HAWK-AI run on the Mac (or Linux
box) the floor's operator installed them on; the phone is the window onto them, the
same window the site is. Nothing in this app holds a key.

### Building it

You need a Mac with Xcode 15 or newer. The project file is generated from
`project.yml` by [XcodeGen](https://github.com/yonaskolb/XcodeGen) so the repo does not
carry a hand-edited `.pbxproj`:

```
cd ios
./make.sh          # installs xcodegen via Homebrew if missing, generates, opens Xcode
```

Then in Xcode: select the `ClaudeCompany` target → Signing & Capabilities → pick your
team. A free Apple ID is enough to run it on your own iPhone (plug it in, choose it as
the run destination, press Run). The bundle id in `project.yml` is
`com.claudedotcompany.app`; change it if that prefix is not yours.

This shell was written on Linux, where Xcode does not exist, so it has been checked for
shape by `test-ios-shell.mjs` but **not compiled here**. The first build on a Mac is the
proof; the code uses only `WebKit`, `SwiftUI` and `UIKit` APIs that have been stable
since iOS 16.

### Shipping it to the floors

- **TestFlight** is the honest path for "all floors": a paid Apple Developer account
  ($99/yr), Product → Archive in Xcode, upload, add testers by email or a public link.
  Up to 10,000 external testers, builds live 90 days, no review beyond a light first
  pass.
- **App Store** review is a real risk for this app as it stands, and worth knowing
  before spending the time: guideline 4.2 (minimum functionality) is applied to apps
  that are a web site in a wrapper, and 3.1.5 covers cryptocurrency. An app that
  facilitates trading is reviewed as one. If the store is the goal, the shell needs
  native surface of its own — push notifications for a floor's fills and the sniper's
  state, a native floor picker, the house book as a widget — and the review notes
  should say plainly that the app holds no keys and executes nothing.

### Files

| file | what it is |
| --- | --- |
| `project.yml` | the XcodeGen spec: target, bundle id, Info.plist keys, URL scheme, wallet schemes |
| `make.sh` | generate the project and open it |
| `ClaudeCompany/ClaudeCompanyApp.swift` | the app entry |
| `ClaudeCompany/Desk.swift` | where the desk lives: home URL, own hosts, deep-link routing |
| `ClaudeCompany/DeskView.swift` | the screen: web view, load bar, out-of-reach card |
| `ClaudeCompany/DeskWebView.swift` | the `WKWebView` and its navigation, wallet handoff and dialogs |
| `ClaudeCompany/Assets.xcassets` | the app icon (the 1024 mark, no alpha, as the store requires) |
