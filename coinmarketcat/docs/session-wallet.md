# The session wallet

*A key the extension makes, funded once from Phantom, that signs on its own and is swept back when you are done.*

A private key in a browser is a bigger attack surface than one on a server. Read that
sentence first; everything below is what the extension does about it and what it cannot.

## Why it exists

Phantom cannot sign for a bot. The lane as shipped asks Phantom for one approval per
trade, and the README says what that costs: a stop that needs a click is a weaker stop
than a key's, a window that sits is abandoned, a declined sell is asked again. The
executor's record says the clicks come late.

The session wallet is the other answer. The extension generates a keypair, you fund it
from Phantom with **one** approved transfer equal to your budget, the lane signs its
buys and sells from that wallet without asking, and when the session is over the
balance is swept back to Phantom.

The budget becomes the balance. A wallet holding 0.5 SOL cannot spend 0.6 SOL whatever
the lane's arithmetic says, whatever a bug says, whatever a tampered config says — the
chain refuses. That is the hardest cap there is, harder than any check in the engine.

## How it works

Everything lives in `src/lib/session-wallet.mjs`, the one file under `src/` allowed to
touch a secret key. `test-hawk-no-key.mjs` scans every other file for a Keypair, a
secret, a derivation or a signer on every run, and refuses any file but the background
host importing this one.

**At rest.** The 64-byte secret key is AES-GCM-256 ciphertext. The key is derived from
your passphrase by PBKDF2-SHA256, 600,000 iterations, over a 16-byte random salt, with a
12-byte random nonce; both are fresh every time the blob is written. The blob —
`{ v, publicKey, kdf, cipher, ct, createdAt }` — is stored under
`coinmarketcat:session-wallet` in `chrome.storage.local`. It carries the public key in the
clear so the popup can show the address without asking for the passphrase, and nothing a
reader without the passphrase can spend. **The passphrase is never stored**, in any form.
A passphrase must be at least 12 characters.

**Unlocked.** `unlock` decrypts the secret into `chrome.storage.session` — memory only,
extension-private, gone when the browser closes — with an expiry, eight hours by
default. Every read checks the expiry; an expired entry is removed on sight and the
wallet reports locked. `lock` removes it now. Plaintext bytes the module holds are
zeroed after use.

**Signing.** `createSessionSigner` is the same bridge shape the engine already speaks to
Phantom through: `isReady()`, `wallet()`, `signTransaction({ txBase64, wallet })`. A
locked wallet answers `no_wallet`; a transaction for a different wallet than the one the
lane armed on answers `wallet_mismatch`; a transaction that does not name the session
wallet as a signer is refused. The engine's own checks are unchanged: the signed bytes
must carry the message it asked for, the transaction was simulated with a spend ceiling
before it was signed, the day cap and the ticket cap still apply. The wallet's balance is
a cap on top of those, enforced by the chain.

**Replacing.** An existing keystore is never overwritten unless `replace` is asked for
**and** the current passphrase is given. A wallet with funds in it cannot be lost to a
mis-click.

## The ceremony

1. **Create** — choose a passphrase of 12 characters or more. The extension generates the
   keypair and stores it encrypted. Write the passphrase down somewhere that is not the
   browser; there is no reset.
2. **Fund from Phantom** — one transfer, from your Phantom wallet to the session wallet,
   for exactly the budget you are willing to have at risk. One Phantom window
   (`buildFundTransaction`). That transfer *is* the budget.
3. **Unlock** — type the passphrase; the wallet is unlocked for the session (eight hours
   by default, shorter if you say so).
4. **Arm** — the lane's arming sentence is typed for the session wallet's address, as it
   is for Phantom's. Every buy and sell is now signed without a window. The lane's
   caps still hold; the balance holds harder.
5. **Sweep** — when the session ends, sweep the SOL back to Phantom
   (`buildSweepTransaction`). The sweep leaves the rent-exempt minimum for an empty
   account, 890,880 lamports, and the fee; if the balance is at rent there is nothing to
   sweep and the builder says so. A token the wallet still holds — a curve that graduated,
   a sell that never landed — is swept with `buildTokenSweepTransaction`, which creates
   your Phantom's token account if it is missing and moves the whole amount. A Token-2022
   mint with a transfer hook is refused by that builder; sell it by hand from the
   exported key.
6. **Lock** — when you are done. A locked wallet is ciphertext on disk and a passphrase
   in your head.

## The threat model

What protects against what:

| threat | outcome |
|---|---|
| someone reads `chrome.storage.local` (a backup, a synced profile, a copied disk) | they hold AES-GCM ciphertext; without the passphrase, 600,000 PBKDF2 rounds stand between them and each guess |
| the extension's own bug tries to spend more than the budget | the chain refuses: the wallet does not hold it |
| the lane is armed for one wallet and the session wallet is another | `wallet_mismatch`; nothing is signed |
| the browser closes | the unlocked secret is gone with session storage; the ciphertext remains |
| the session runs past its expiry | the secret is removed on the next read; the lane loses its signer and says so |
| the passphrase is forgotten | the funds are recoverable only if the key was exported; **there is no reset** |

What does **not** protect, said plainly:

- **A compromised browser profile.** Anything that can read the extension's session
  storage while the wallet is unlocked — malware on the machine, a debugger attached to
  the service worker, an extension with the wrong permissions — can read the secret and
  spend everything in the wallet. A keylogger has the passphrase.
- **A malicious build.** You load this extension unpacked from a repository you cloned.
  A modified build can do anything with the key. Build it yourself, from a commit you
  read.
- **The rest of the lane.** The session wallet changes who signs, not what is signed.
  The record the README prints still loses.

Hence the rules: fund it with what you are willing to lose, sweep when the session
ends, lock when done, and never leave a wallet unlocked and funded on a machine you have
walked away from.

## Recovery

Funds are never stranded in a wallet the extension made. `exportSecret` — the popup's
**Export key** — asks for the passphrase and returns the secret key in base58, the form
Phantom and Solflare import (Phantom: *Add / Connect Wallet → Import Private Key*).
Once imported, the wallet is an ordinary wallet in Phantom and you can move anything in
it.

Use it to recover, not to routinely move the key around: a key that is routinely
exported is a key that is routinely exposed. If you export it, treat the session wallet
as burned — sweep it and create a new one.

## The API, for the host

All of it is in `src/lib/session-wallet.mjs`; nothing in it touches `chrome.*`.

```
createKeystore({ storage, session, subtle?, random?, clock? })
  .exists() .publicKey() .create({ passphrase, replace?, currentPassphrase? })
  .unlock({ passphrase, ttlMs? }) .lock() .isUnlocked()
  .changePassphrase({ current, next }) .exportSecret({ passphrase })
  .snapshot() .refresh()
createSessionSigner({ keystore, clock? })      → { isReady(), wallet(), signTransaction(), refresh() }
buildFundTransaction({ from, to, lamports, blockhash, computeUnitLimit?, priorityFeeLamports? })
buildSweepTransaction({ from, to, lamports, blockhash, ... })
sweepableLamports({ balanceLamports, feeLamports?, priorityFeeLamports? })
buildTokenSweepTransaction({ from, to, mint, amountRaw, tokenProgram, blockhash, ..., transferHook? })
SYSTEM_ACCOUNT_RENT_EXEMPT_LAMPORTS = 890880
```

`storage` wraps `chrome.storage.local` and `session` wraps `chrome.storage.session`, each
as `{ get(key) → value | undefined, set(key, value), remove(key) }`. The engine reads
`isReady()` and `wallet()` synchronously, so the signer answers from the keystore's last
read: call `await signer.refresh()` when the worker starts and after every keystore call.
`test-hawk-session-wallet.mjs` runs all of it in Node against a Map.
