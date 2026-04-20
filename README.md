# Vercel Sensitive Env Rotator

`vercel-sensitive-envs` is a local CLI for teams that need to rotate Vercel environment variables safely and deliberately.

It is designed for a common incident-response workflow:

1. inventory current env vars
2. prepare a replacement manifest
3. rotate `production` first
4. rotate `preview` second
5. recreate those vars as `sensitive`

The tool is intentionally conservative. It defaults to plan-only mode, preserves existing scope metadata where possible, and refuses to rotate if your manifest still contains Vercel ciphertext blobs or generated placeholders.

## Why this exists

Vercel supports `sensitive` environment variables, but migrating existing values into that format is awkward in practice:

- sensitive vars cannot simply be toggled in place
- some existing vars target both `production` and `preview`
- bulk export APIs do not consistently return plaintext for all non-sensitive values
- incident response often requires careful sequencing, especially if production must be updated before preview

This CLI automates the parts that are easy to get wrong.

## Features

- Supports project-scoped env vars and shared team env vars
- Rotates `production` before `preview`
- Safely splits multi-target env vars during rotation
- Exports a JSON manifest you can review and edit before making changes
- Preserves comments where possible
- Detects Vercel ciphertext blobs and converts unreadable exports into explicit placeholders
- Refuses to perform writes when manifest values are clearly unresolved

## Requirements

- Node.js `>=18`
- A Vercel token with access to the relevant team or project

Create a token here:

- [vercel.com/account/tokens](https://vercel.com/account/tokens)

## Install

Clone the repo and install:

```bash
npm install
```

For local CLI use without publishing:

```bash
npm link
vercel-sensitive-envs --help
```

## Quick Start

### 1. Export a manifest

```bash
VERCEL_TOKEN=... vercel-sensitive-envs \
  --scope project \
  --project your-project-name \
  --team-slug your-team-slug \
  --dump-non-sensitive-manifest \
  --output ./vercel-sensitive-rotation.generated.json
```

If Vercel refuses to return plaintext for a value, the generated file will include:

- a `REPLACE_WITH_NEW_*` placeholder in `entries`
- a separate `.unresolved.json` report next to the exported manifest describing which keys still need manual values

### 2. Replace unresolved values

Edit the generated manifest and replace every placeholder with the real new value you want Vercel to store.

This matters: Vercel stores exactly what you send. A placeholder or ciphertext blob is not a valid replacement secret.

### 3. Preview the rotation plan

```bash
VERCEL_TOKEN=... vercel-sensitive-envs \
  --scope project \
  --project your-project-name \
  --team-slug your-team-slug \
  --manifest ./vercel-sensitive-rotation.generated.json
```

### 4. Apply the rotation

```bash
VERCEL_TOKEN=... vercel-sensitive-envs \
  --scope project \
  --project your-project-name \
  --team-slug your-team-slug \
  --manifest ./vercel-sensitive-rotation.generated.json \
  --yes
```

### 5. Redeploy affected environments

After rotating environment variables, you will usually want to trigger fresh deployments in Vercel so new builds and runtime instances pick up the updated values.

In practice that often means:

- redeploying production after the production rotation completes
- redeploying preview after the preview rotation completes

If your application reads the secret only at runtime, a restart may be enough. If the value is used at build time, you should expect a full redeploy to be necessary.

## Manifest Format

```json
{
  "entries": [
    {
      "key": "PRIMARY_SERVICE_TOKEN",
      "production": "new-production-value",
      "preview": "new-preview-value"
    },
    {
      "key": "NOTIFICATION_PROVIDER_SECRET",
      "all": "same-value-for-production-and-preview"
    },
    {
      "key": "INTERNAL_SIGNING_SECRET",
      "production": "prod-only-value"
    }
  ]
}
```

`all` means the same value should be used for both `production` and `preview`.

## Common Commands

Show help:

```bash
npm run help
```

Export a manifest:

```bash
npm run export -- \
  --scope project \
  --project your-project-name \
  --team-slug your-team-slug \
  --output ./vercel-sensitive-rotation.generated.json
```

Run a plan-only rotation:

```bash
npm run rotate -- \
  --scope project \
  --project your-project-name \
  --team-slug your-team-slug \
  --manifest ./vercel-sensitive-rotation.generated.json
```

## Scope Modes

### Project env vars

Use `--scope project` with:

- `--project <project-id-or-name>`
- `--team-id <team-id>` or `--team-slug <team-slug>` when needed

### Shared team env vars

Use `--scope shared` with:

- `--team-id <team-id>` or `--team-slug <team-slug>`
- optionally `--project <project-id>` to filter shared env vars associated with a specific project

## Important Limitations

- `sensitive` vars are intentionally unreadable from the API.
- Some Vercel `encrypted` vars do not come back as plaintext even when using bulk export with `decrypt=true`.
- Even the per-ID decrypted endpoint may still refuse to return plaintext for some `encrypted` vars.
- Shared env var export is more limited than project env export.
- Branch-scoped preview vars are skipped by default. Pass `--allow-git-branch-vars` if you explicitly want them.

Because of those API limitations, this tool treats unreadable values as unresolved inputs, not reusable outputs.

## Security

This tool is intended to be run locally and is relatively safe for that use case, with the usual secret-handling precautions:

- It runs on your machine and talks directly to the Vercel API.
- It does not send secrets to any third-party service beyond Vercel.
- It does not persist your Vercel token unless you choose to do that yourself.
- Generated manifest files can contain real plaintext secrets and should be treated as sensitive files.

Recommended practices:

- use `export VERCEL_TOKEN=...` in your current shell instead of storing the token in a tracked file
- never commit generated manifests
- delete manifest files once rotation is complete
- use a temporary working directory if you want stricter local hygiene

## How rotation works

For each targeted key:

1. the tool inspects current scope and target metadata
2. if a single env var currently targets both `production` and `preview`, it narrows the old record first
3. it recreates the current phase as a new `sensitive` env var
4. it processes `production` before `preview`
5. it verifies that the final records for the rotated targets are `sensitive`

That sequencing reduces the chance of clobbering the wrong target during a migration.

## Development

Run the standalone CLI directly:

```bash
node ./bin/vercel-sensitive-envs.mjs --help
```

## Future Work

The current implementation focuses on Vercel. If you want support for another provider later, the clean path is to add a provider abstraction rather than bolting unrelated API logic directly into the current command flow.

If you want to reduce risk further, the best next improvements would be:

- add a prominent warning banner in the README that generated manifests may contain plaintext secrets
- add a `--require-confirmation <project-name>` style guard before writes
- add an optional `--backup-metadata-only` export that never writes values, only keys, targets, and comments
- add a disclaimer that users are responsible for supplying valid replacement secrets and verifying redeploys

If you want, I can add those safety improvements to both the local copy and the public repo.
