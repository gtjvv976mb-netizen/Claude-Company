# WALL-ST-E X Articles visual kit

The article header is a 1500×600 PNG at an exact 5:2 aspect ratio, composed specifically for X’s wide Articles-header crop. The six inline figures are 1600×900 PNGs. X’s official Articles help documents header and inline-image support but does not publish a required Articles header dimension.

## Fastest workflow — no text cleanup

Open [x-paste.html](./x-paste.html), then:

1. Click **Copy title** and paste it into X’s title field.
2. Click **Copy formatted article** and paste it into X’s body.
3. Upload the cover and six figures using the adjacent image checklist. Each image has its own **Copy alt** button.

Only the article body is copied. Markdown characters, filenames, image placeholders, posting notes, alt-text instructions and this README never enter the clipboard payload. [article.md](./article.md) is the clean Markdown fallback; `x-paste.html` is the recommended publishing artifact.

## Posting order

| File | Use | Suggested X alt text |
|---|---|---|
| `wall-st-e-article-cover.png` | Article header | WALL-ST-E, a yellow 3D robot, beside two status rows. The research desk shows a green Live indicator, while WALL-ST-E telemetry is marked Self-Reported and sanitized with no controls. Text reads: Meet WALL-ST-E. The autotrader our servers cannot control. Paper by default. Key stays local. |
| `wall-st-e-article-cover-16x9.png` | Optional 16:9 social preview | The same WALL-ST-E cover thesis in a taller editorial composition. Do not use this as the X Articles header. |
| `01-custody-boundary.png` | After the introduction | Diagram separating Claude Company’s research server from an operator-controlled WALL-ST-E host. Calls and exits travel to the host; owner-authenticated sanitized status travels back. The burner key, local policy, journal, Jupiter key and private RPCs stay on the operator side. |
| `02-two-ways-to-trade.png` | “Two ways” section | Two-lane flow. Manual: offered call, Jupiter, user wallet approval. Autotrader: floor poll, local safety gates, burner signature. Both keep signing outside Claude Company. |
| `03-install-rehearse-arm-fund.png` | Setup section | Four-step WALL-ST-E activation runway: Install, Rehearse on paper, Arm through exact local wallet-and-values acknowledgement, then Fund Last. Default caps are 0.005 SOL per trade, 0.01 SOL rolling deployment and a 0.01 SOL realized-loss entry brake; reviewed supported maxima are 0.05, 0.5 and 0.15 SOL respectively. The pause remains after macOS cap arming. |
| `04-entry-gauntlet.png` | “How he decides” section | Six local gates: feed integrity, fresh entry, local risk size, executable costs, transaction binding, and sign-simulate-journal. Any failed gate means no submitted trade. |
| `05-position-policy.png` | Position-management section | Shared position policy: authored stop, breakeven at 1.35 times, a 25 percent trailing stop at 1.5 times, then target or time exit. Desk safety exits outrank price. |
| `06-local-brakes.png` | Brakes section | Pause Entries blocks new buys while managed exits continue. Hard Stop blocks every new submission, including exits, while already signed attempts reconcile and open positions require manual supervision. The owner dashboard can observe sanitized status but cannot change either local control. |

## Important cover semantics

The green **Live** row is the research desk connection. WALL-ST-E’s row intentionally says **Self-reported**, matching the product: an authenticated owner can see sanitized executor telemetry, readiness, active caps and read-only public-wallet funding state. That row is not a remote control or a guarantee that trading is healthy. The website still cannot start, stop, unpause or sign, and it cannot inspect local secrets.

The 3D WALL-ST-E hero is captured from the real `viewer/office3d.html` model. Its lamp is rendered amber for the paper-default studio pose rather than green.

## Rebuild

```bash
node scripts/render-wall-st-e-article.mjs
```

The renderer serves only the local repository on loopback, captures the exact 3D model from `dist/floor.html`, then screenshots the wide header, optional 16:9 cover and six code-native figures in `visuals.html` with bundled fonts.

## X references

- [X Help: About X Articles](https://help.x.com/en/using-x/articles)
- [X Help: How to make images accessible](https://help.x.com/en/using-x/add-image-descriptions)
