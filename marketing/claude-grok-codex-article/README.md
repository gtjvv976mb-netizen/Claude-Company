# Claude + Grok + Codex X Article kit

This kit publishes the article without Markdown cleanup. The header uses the preferred exact **5:2 ratio at 1500×600**; both inline figures are 1600×900.

## Publishing workflow

1. Open `x-paste.html`.
2. Click **Copy title** and paste it into X’s title field.
3. Click **Copy formatted article** and paste it into the body.
4. Upload the header and two figures using the adjacent checklist and copy their alt text with the provided buttons.

The clipboard payload contains only the formatted article. It excludes filenames, image-placement notes, alt text and publishing instructions.

## Image order

| File | Use |
|---|---|
| `claude-grok-codex-header.png` | X Articles header |
| `01-three-bounded-jobs.png` | After the opening thesis, before the Claude section |
| `02-integration-loop.png` | After “Not a committee—a system” |

## Factual boundaries

- Claude is the default reasoning layer across the trading pipeline, surrounded by deterministic screens and vetoes. It never signs or sends.
- Grok supplies native X evidence for shortlisted candidates, supports an X-first trend scan and may be selected as a tenant floor’s PM brain. It cannot bypass the same schemas, Red Team, Risk, Compliance or custody boundary.
- Codex is an isolated, manual, read-only Improvement Engineer. Its architecture is deployed, but its protected worker has not yet been activated or completed a review. Once activated it receives aggregate-only evidence and emits proposals for human review; it cannot edit, deploy, publish or trade.

## Rebuild

```bash
node scripts/render-claude-grok-codex-article.mjs
```
