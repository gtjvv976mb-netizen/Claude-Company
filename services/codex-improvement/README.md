# Codex Improvement Worker

This is deliberately a separate package from the production API. Its only supported
runtime is the manually dispatched **Codex improvement review** GitHub Actions workflow;
it is not a local service or a Render process. The worker fetches the token-protected live
review bundle, verifies its digest, manifests, and `sourceCommit` against the exact
checked-out `GITHUB_SHA`, then lets Codex inspect that checkout in a read-only sandbox
with approvals and agent networking disabled.

The worker emits structured JSON and Markdown proposals only. It cannot trade, edit,
apply, commit, push, merge, or deploy, and its output is never accepted automatically.
Any proposed change must go through a human-owned branch, tests, review, and explicit
merge.

## Activation

Configure these credentials before dispatching the workflow:

- Render `CODEX_REVIEW_TOKEN`: a dedicated high-entropy read-only bearer token.
- GitHub Actions `CODEX_REVIEW_TOKEN`: the exact same value as Render.
- GitHub Actions `OPENAI_API_KEY`: a project-scoped credential for the isolated worker.
- GitHub Actions `CODEX_ARTIFACT_KEY`: a separate random passphrase at least 32 characters
  long.

After Render redeploys, check the public `/api/improvements/status` response. It must show
`bundleAuthConfigured: true`, and `sourceCommit` must equal the exact 40-character commit
SHA that the workflow will check out. The full `/api/improvements/review-bundle` is not
public: it requires `Authorization: Bearer <CODEX_REVIEW_TOKEN>`. The worker fails closed
if the bearer token, source commit, digest, decision manifest, test manifest, or bundle
freshness does not match.

## Reviewing the result

The workflow uploads `codex-improvement-review.tar.gz.gpg`, not plaintext. GitHub retains
the encrypted artifact for seven days. After downloading it, decrypt and unpack it with:

```bash
read -rs CODEX_ARTIFACT_KEY
printf '%s' "$CODEX_ARTIFACT_KEY" | gpg --batch --yes --pinentry-mode loopback \
  --passphrase-fd 0 --output codex-improvement-review.tar.gz \
  --decrypt codex-improvement-review.tar.gz.gpg
unset CODEX_ARTIFACT_KEY
mkdir codex-improvement-review
tar -xzf codex-improvement-review.tar.gz -C codex-improvement-review
```

Store the artifact key outside the repository. Rotate it periodically and immediately
after suspected exposure; retain an old key securely only while an artifact encrypted
with it is still needed within the seven-day retention period.
