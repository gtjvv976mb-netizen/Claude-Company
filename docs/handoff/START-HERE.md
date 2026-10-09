# Start here — the message that hands this work to a new Claude account

The owner pastes the block below as the **first message** of a new Claude Code session, on the
new account, with `gtjvv976mb-netizen/Claude-Company` selected as the session's repository.
Everything the new session needs is in this repository; the block only points at it and sets the
rules for the first hour.

Before pasting, two things on the new account (details in `HANDOFF.md` §2):

1. **GitHub.** Connect GitHub at https://claude.ai/connect-github. The repo is public, so reading
   always works. Pushing and opening PRs needs a GitHub user with write access: the owner's own
   user `gtjvv976mb-netizen` already has it; a different GitHub user must first be added under
   the repo's Settings → Collaborators. The Claude GitHub App must be installed on the repo.
2. **Network.** In the cloud environment's settings, allow at least
   `claude-company-api.onrender.com`, `frontend-api-v3.pump.fun`, `api.dexscreener.com` and a
   Solana RPC (`api.mainnet-beta.solana.com` works, slowly). Without them the session can read
   code and nothing live.

Fill in the burner wallet's public address where it says `<BURNER WALLET>`. It is deliberately
not written anywhere in this public repo; `HANDOFF.md` §5.3 says where to find it.

---

```text
You are taking over the Claude Co / HAWK-AI work from a Claude Code session on my other account.
Everything you need is in this repo — nothing lives only in the old conversation.

1. Read docs/handoff/HANDOFF.md on main, all of it, before doing anything else. Then read
   executor/README.md sections "Pause and hard stop" and "Arming HAWK-AI, the launch sniper,
   with real money".

2. Keep the standing rules in HANDOFF.md §3. The ones that matter most:
   - Never print or handle secrets (CC_SECRET, private keys, RPC/gRPC tokens, burner.json).
   - Any money action needs my explicit yes: funding, arming, raising a cap, selling,
     reclaiming rent, claiming fees, signing anything.
   - Develop on the branch this session gives you. I merge to main; don't merge unless I say so.
   - Never disable TLS verification or unset HTTPS_PROXY.

3. First hour, read-only:
   a. Check your network can reach https://claude-company-api.onrender.com/api/agent/50 and a
      Solana RPC. If it can't, tell me which host is blocked and stop there.
   b. Re-read the live state: GET /api/heartbeat, /api/agent/50 and /api/storage on
      claude-company-api.onrender.com.
   c. Run: node docs/handoff/tools/wallet-report.mjs <BURNER WALLET> --limit 40
   d. Report back in plain words, outcome first: is HAWK-AI up, is it buying, the wallet
      balance, any open positions, and what changed since HANDOFF.md §0 was written
      (2026-10-09). Then list the owner decisions in §7 that are still open.

4. Then wait for me to choose. If I say "continue" or "do it", start with HANDOFF.md §7
   "Engineering" item 1 (the trend lane's impossible 35x–259x peaks): reproduce it in a test
   first, fix it, run the full suite (node scripts/test-all.mjs), commit, push, and open a PR.
```

---

If the new session is started on a branch cut from an old commit, it may not see this file or
the current `HANDOFF.md`. Tell it to run `git fetch origin main && git show origin/main:docs/handoff/HANDOFF.md`.
