# Claude Company — long-form X post

---

🏢 **I built a 50-floor AI trading firm. It has researched 170 coins and refused to recommend a single one.**

That's not a bug. That's the whole product.

Every number below is live from the running system. You can check them yourself at claudedotcompany.com — the counters are public.

---

## 🧐 The problem I actually wanted to fix

Crypto calls are broken in a boring way: **nobody shows you the work.**

You get "$WIF looking strong 🚀" and a chart. You never see what was checked, what was found, or what would have stopped the call. And you never see the coins they *rejected* — which is where all the useful information lives.

So I built the opposite. A firm where the research is the product and the refusals are public.

---

## 📊 The receipts, right now

- 🔍 **167 coins** seen
- 🧾 **170** full workups run
- 🗣️ **355** agent verdicts written
- ❌ **141 killed** — investigated, then rejected
- 👀 **7** on the watch board, re-checked every 5 minutes
- ✅ **0** calls published

Read that last line again. **Zero.** 170 investigations, not one recommendation.

Most "AI trading" accounts would be embarrassed by that number. I think it's the most honest thing on the timeline. A desk that calls everything is a desk that has never said no — and saying no is the job.

---

## 🏢 So what is it, actually?

A building. Literally — you can walk through it in 3D.

**Floor 50** is the house desk: 16 AI agents, each with a name, a desk, a chair, and a written charter saying exactly where their authority stops.

**Floors 1–49** are for rent. Lease one and you get your own copy of the team, tuned to *your* risk appetite.

You can watch them work. Agents walk to the printer. They argue in the meeting room. When a coin gets killed, you see which seat killed it and why.

---

## 👔 The sixteen seats

Every seat is one job with one power, and a hard line it cannot cross.

**🎩 The corner office**
- **BIG M** — signs off. Nothing publishes without him.
- **JUDGE DREAD** — compliance. He's not even an AI: he's a regex. Deterministic, unarguable, and his veto outranks everyone. A vetoed idea never reaches the boss at all.

**🔬 The Pit — the ones who dig**
- **AUSTIN POWERZ** — sweeps the market for anything new
- **MAXWELL SMORT** — the first screen, kills the obvious junk
- **STERLING ARCHOR** — reads the actual contract (mint authority, freeze, LP locks)
- **ETHAN HUNTED** — *can you get out?* Simulates a buy AND a sell. A coin you can't exit isn't an opportunity, it's a trap.
- **SAM FISHY** — watches real wallet flow in the dark
- **JASON BURN** — the chart
- **BLACK WIDOWER** — the story. Is the hype real people, or one script pasted 400 times?
- **MURDOCK** — the weather. Is the whole market risk-on or bleeding?

**⚖️ The judges**
- **JAMES BOUND** — the PM. Writes the actual call.
- **AGENT 48** — Red Team. His default answer is *no*. He tries to destroy every idea before it ships, and the PM isn't allowed to propose until he's answered him. Standing record: 9 refuted, 0 survived.
- **MINI-MEH** — risk. Makes your size smaller. Always.
- **JOHN QUICK** — execution
- **COLONEL DEBRIEF** — grades every closed trade afterward
- **AGENT P** — says nothing, files everything

---

## 🤖 Where Grok comes in

Two jobs, and only two.

**1. Reading X properly 🐦**
Claude can search the web. It cannot read X the way a trader does. Grok can — natively, first-party. So on every workup, Grok reads the actual conversation and reports back: is attention *rising or fading*? Are these real accounts in their own words, or one copy-pasted script? Where did the story actually start? Does it smell paid?

That closed the desk's single biggest blind spot.

**2. Being your boss (optional) 🧠**
On your own floor you can swap the Managing Director's brain from Claude to Grok with one click. Grok then makes every publish-or-pass decision on that floor.

He even gets his own office — black glass, a white X on the floor, and his own board tracking your open positions. 😎

What Grok does **not** do: hold your money. Ever.

---

## 💸 The part everyone asks about: does it trade for me?

Yes — and your keys never leave your machine.

Two clicks on your floor:
1. **Create my bot wallet** → a burner wallet is generated *in your browser*. We never see the key.
2. **Start the bot** → it trades your floor's calls.

It starts in **dry run**, so it shows you what it *would* do and spends nothing. Going live takes a deliberate confirm. You can withdraw everything at any time, and export the key so you always control the funds.

Prefer 24/7? One command puts the same bot on a $4/month server.

---

## 🛡️ The bot has its own brakes

The desk says "buy" and "sell" — but between those two messages, a naive bot is naked. If the coin rugs at 3am, nothing saves you.

So the bot enforces its own risk, every 20 seconds:
- 🛑 a **hard stop**, priced on what you could actually sell for right now — not a fake mid-price
- 🔒 once the target is hit, the stop moves to **breakeven** — the trade can no longer lose
- 📈 then it **trails** behind the high, so a rare 10x is allowed to run
- 🧯 a **daily loss limit** and a **max positions** cap — the two brakes that decide whether a bot survives a bad week

---

## 🧪 And I tuned it by simulation, not by vibes

I set the defaults by feel first: sell half at target, tight trail. Sounded prudent.

Then I actually simulated it — and it was **wrong**. Memecoin returns are fat-tailed: the rare runners are the entire profit. Selling half at target quietly destroys the thing you're being paid for. **Every** scale-out setting reduced returns.

So the shipped default is now: don't cut winners, trail wide. 📊

You can run this yourself, in the site, right now — no wallet, no install. **"Test the bot on paper"** on your floor: pick an assumed hit rate, run 200 paper trades, watch the real engine work.

---

## 🧮 The honest math (please read this part)

I'm not going to tell you this makes money. Here's the actual arithmetic:

With realistic trading costs, **the desk has to hit about 18%** for the bot to break even.

| Desk hit rate | Result |
|---|---|
| 10% | 📉 loses |
| 15% | 📉 loses |
| ~18% | ⚖️ break-even |
| 28% | 📈 profits |
| 40% | 🚀 profits well |

And the honest part: **the desk has published zero calls, so its real hit rate is unknown.** Nobody — including me — can tell you which row you'd land on yet.

That's exactly why the paper test makes *you* choose the assumption instead of handing you one number to trust. And it's why my advice is: **run it in dry-run first.** Let the desk build a real record. Fund it after, or not at all.

Anyone promising you a profitable memecoin bot is selling something. 🙃

---

## 🚪 Try it

- 🏢 Walk the building: **claudedotcompany.com**
- 🧪 Paper-test the bot on your floor — free, no wallet
- 🔑 Lease a floor to get your own 16-agent team

The scoreboard is public and it currently reads **0 calls**. When the first one lands, you'll see the entire file that produced it — including the seat that tried to kill it.

A desk that shows you its refusals is worth more than one that shows you its winners. 🧾

---

### Notes for posting
- Screenshot suggestions: the floor in 3D, the Kill Board (141 rejections), Grok's office + board, the paper-test panel with a losing run *and* a winning run side by side.
- Every figure here was pulled live from `/api/stats/overview`. Re-check before posting — the counters move.
- Deliberately contains **no** profit claim and **no** invented track record.
