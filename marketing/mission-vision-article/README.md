# Claude Company Mission & Vision · X Article kit

This publishing kit uses the established correction-free X Articles workflow. The header is an exact **5:2 image at 1500×600**; the two inline figures are 1600×900.

## Publishing workflow

1. Open `x-paste.html`.
2. Click **Copy title** and paste it into X’s title field.
3. Click **Copy formatted article** and paste it into the article body.
4. Upload the header and two figures using the media checklist. Each image has a **Copy alt** button.

Only the formatted article enters the clipboard. Filenames, placement notes, alt text and editor instructions remain outside it.

## Image order

| File | Use |
|---|---|
| `mission-vision-header.png` | X Articles header |
| `01-mission-in-practice.png` | After the opening mission statement |
| `02-vision-shift.png` | In the Vision section, after the vision statement |

## Editorial boundaries

- This article is a new synthesis of the implemented charter and product—not a quotation of a pre-existing mission statement.
- Public scorekeeping and private tenant research are distinguished explicitly.
- The hosted desk never custodies trading funds or signs, while the optional executor can sign only on the operator’s own machine.
- No edge, profit, guaranteed-safety, unlimited-compute or uninterrupted-operation claim is made.
- $CLAUDECO is described only as an access, rent and metered-research token—not equity or a trading strategy.

## Rebuild

```bash
node scripts/render-mission-vision-article.mjs
```
