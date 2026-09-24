# Cat Intelligence Agency — brand kit

The agents are **pixel kittens on a 2D floor**. The agency itself is **3D**. Every character,
scene, texture and the 3D building were generated with Higgsfield: GPT Image 2.5 for the art,
with the Director kitten as the style reference for the other five, and Tripo H3.1 for the
image-to-3D building. Type was set over the art afterwards, so it is spelled exactly. The
first, non-pixel portrait set is in git history (commit 035de87).

The words are in [COPY.md](COPY.md): X profile, launch thread, agent dossiers, investigation
house rules, the pump.fun description, and the site copy.

## Where each file goes

| File | Size | Use |
|---|---|---|
| `logo/cia-token-1000.png` | 1000×1000 | The $CIA image on pump.fun (wallets crop it round; it is circle-safe) |
| `logo/cia-avatar-400.png` | 400×400 | X profile photo (circle-safe) |
| `banner/x-header-1500x500.jpg` | 1500×500 | X header. The title sits clear of the profile photo's overlap, lower left |
| `banner/og-1200x630.jpg` | 1200×630 | Link previews: the site's `og:image`, and the image to attach to launch posts |
| `banner/site-hero-2400x1029.jpg`, `-1200x514.jpg` | | The pixel roster scene; the left third is open sky for a title |
| `logo/cia-wordmark-1600x400.png` | 1600×400 | Horizontal lockup: the pixel Director and the name, on ink |
| `logo/favicon-32.png`, `favicon-64.png`, `apple-touch-180.png` | | Site icons |
| `sprites/<cat>.png` | about 145×207 | **The game sprites**: each kitten on a true 4 px grid, transparent, trimmed. Draw them with `image-rendering: pixelated` (or `NearestFilter` in three.js) at any whole multiple |
| `agents/<cat>-avatar-400.png` | 400×400 | Each kitten standing on the pixel floor, as a profile picture |
| `agents/<cat>-1024.png` | 1024×1024 | Each kitten as generated, transparent, for posts and reaction images |
| `3d/agency-hq.glb` | 1.4 MB | The agency headquarters, a textured 3D model (about 11,000 vertices, one 1024 JPEG texture), unit-sized and centred |
| `source/` | | The roster scene, the Director portrait, the seamless pixel floor tile, and the building concept image, as generated |

The cats: `director` (the logo), `coinmarketcat` (the sniper; the extension's icons are made
from this one), `crying-cat` (ruggers), `grumpy-cat` (fake hype), `cashcat` (whales and KOLs), `popcat` (emerging cat memecoins).

## Palette

| | Hex | Used for |
|---|---|---|
| Ink | `#0b0716` | Every background |
| Mint | `#14f195` | "INTELLIGENCE", CoinMarketCat, the floor's grout, the Director's ring |
| Violet | `#9945ff` | Glows, the Director |
| Gold | `#f5c542` | $CIA, CashCat |
| Tear blue | `#5ab8ff` | Crying Cat |
| Burnt orange | `#e8742c` | Grumpy Cat |
| Hot pink | `#ff4fd8` | Popcat |

## Type

Anton (titles), JetBrains Mono (labels), Archivo (body). All three are from Google Fonts under
the SIL Open Font License. A pixel face such as Press Start 2P (also OFL) suits small labels
next to the sprites.
