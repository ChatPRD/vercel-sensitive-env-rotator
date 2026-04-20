#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'

const API_BASE_URL = 'https://api.vercel.com'
const PHASES = ['production', 'preview']
const DEFAULT_TOKEN_ENV_NAMES = ['VERCEL_TOKEN', 'VERCEL_ACCESS_TOKEN']

function printHelp() {
  console.log(`
Rotate Vercel environment variables into per-target sensitive variables.

This tool always processes production first, then preview.
It defaults to plan-only mode. Pass --yes to perform writes.

Usage:
  vercel-sensitive-envs \\
    --scope project \\
    --project your-project-name \\
    --team-slug your-team-slug \\
    --manifest ./examples/vercel-sensitive-rotation.example.json

  vercel-sensitive-envs \\
    --scope project \\
    --project your-project-name \\
    --team-slug your-team-slug \\
    --dump-non-sensitive-manifest \\
    --output ./vercel-sensitive-rotation.generated.json

Required:
  --scope <project|shared>

Required for rotation:
  --manifest <path>

Project scope:
  --project <project-id-or-name>

Team context:
  --team-id <team-id>
  --team-slug <team-slug>

Optional:
  --include KEY1,KEY2
  --exclude KEY1,KEY2
  --allow-git-branch-vars
  --dump-non-sensitive-manifest
  --output <path>
  --yes

Manifest shape:
{
  "entries": [
    { "key": "PRIMARY_SERVICE_TOKEN", "production": "new-prod", "preview": "new-preview" },
    { "key": "NOTIFICATION_PROVIDER_SECRET", "all": "same-value-for-production-and-preview" },
    { "key": "INTERNAL_SIGNING_SECRET", "production": "prod-only-secret" }
  ]
}
`.trim())
}

function fail(message) {
  console.error(`ERROR: ${message}`)
  process.exit(1)
}

function warn(message) {
  console.warn(`WARN: ${message}`)
}

function info(message) {
  console.log(message)
}

function parseCommaList(value) {
  if (!value) {
    return new Set()
  }

  return new Set(
    value
      .split(',')
      .map(item => item.trim())
      .filter(Boolean),
  )
}

function normalizeTargets(target) {
  if (!target) {
    return []
  }

  return Array.isArray(target) ? [...target] : [target]
}

function appliesToTarget(envVar, target) {
  return normalizeTargets(envVar.target).includes(target)
}

function isGitBranchScoped(envVar) {
  return typeof envVar.gitBranch === 'string' && envVar.gitBranch.length > 0
}

function isRecordEmpty(value) {
  return value === undefined || value === null || value === ''
}

function looksLikeVercelCiphertext(value) {
  return typeof value === 'string' && value.startsWith('eyJ2IjoidjIi')
}

function hasReadablePlaintextValue(envVar) {
  return typeof envVar?.value === 'string'
    && envVar.value.length > 0
    && !looksLikeVercelCiphertext(envVar.value)
}

function buildPlaceholderValue({ key, phase }) {
  return `REPLACE_WITH_NEW_${key}_${phase.toUpperCase()}_VALUE`
}

function isGeneratedPlaceholder(value) {
  return typeof value === 'string' && value.startsWith('REPLACE_WITH_NEW_')
}

function buildUnresolvedOutputPath(outputPath) {
  const parsedPath = path.parse(outputPath)
  return path.join(parsedPath.dir, `${parsedPath.name}.unresolved.json`)
}

function getToken() {
  for (const envName of DEFAULT_TOKEN_ENV_NAMES) {
    const value = process.env[envName]

    if (value) {
      return value
    }
  }

  fail(`Missing Vercel token. Set one of: ${DEFAULT_TOKEN_ENV_NAMES.join(', ')}`)
}

function getTeamQuery(options) {
  const query = new URLSearchParams()

  if (options.teamId && options.teamSlug) {
    fail('Pass either --team-id or --team-slug, not both.')
  }

  if (options.teamId) {
    query.set('teamId', options.teamId)
  }

  if (options.teamSlug) {
    query.set('slug', options.teamSlug)
  }

  return query
}

async function vercelRequest({ method, path, token, query, body }) {
  const url = new URL(`${API_BASE_URL}${path}`)

  if (query) {
    const searchParams = query instanceof URLSearchParams
      ? query
      : new URLSearchParams(query)

    for (const [key, value] of searchParams.entries()) {
      url.searchParams.set(key, value)
    }
  }

  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })

  const text = await response.text()
  const payload = text ? safeJsonParse(text) : null

  if (!response.ok) {
    const details = typeof payload === 'object' && payload !== null
      ? JSON.stringify(payload)
      : text

    throw new Error(`${method} ${url.pathname} failed (${response.status}): ${details}`)
  }

  return payload
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

async function readManifest(manifestPath) {
  const raw = await readFile(manifestPath, 'utf8')
  const parsed = JSON.parse(raw)

  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) {
    fail(`Manifest at ${manifestPath} must contain an "entries" array.`)
  }

  const entries = new Map()

  for (const entry of parsed.entries) {
    if (!entry || typeof entry !== 'object') {
      fail('Each manifest entry must be an object.')
    }

    const key = typeof entry.key === 'string' ? entry.key.trim() : ''

    if (!key) {
      fail('Each manifest entry must include a non-empty "key".')
    }

    if (entries.has(key)) {
      fail(`Manifest contains duplicate key "${key}".`)
    }

    entries.set(key, {
      key,
      all: isRecordEmpty(entry.all) ? undefined : String(entry.all),
      production: isRecordEmpty(entry.production) ? undefined : String(entry.production),
      preview: isRecordEmpty(entry.preview) ? undefined : String(entry.preview),
      comment: isRecordEmpty(entry.comment) ? undefined : String(entry.comment),
    })
  }

  return entries
}

function collectEnvList(payload, key) {
  if (Array.isArray(payload)) {
    return payload
  }

  if (payload && Array.isArray(payload[key])) {
    return payload[key]
  }

  return []
}

async function listProjectEnvVars({ token, project, teamQuery }) {
  return listProjectEnvVarsInternal({
    token,
    project,
    teamQuery,
    decrypt: false,
  })
}

async function listProjectEnvVarsInternal({ token, project, teamQuery, decrypt }) {
  const query = new URLSearchParams(teamQuery)

  if (decrypt) {
    query.set('decrypt', 'true')
    // Vercel currently returns ciphertext blobs for many encrypted vars unless
    // the request mimics the CLI env-pull code path.
    query.set('source', 'vercel-cli:pull')
  }

  const payload = await vercelRequest({
    method: 'GET',
    path: `/v10/projects/${encodeURIComponent(project)}/env`,
    token,
    query,
  })

  return collectEnvList(payload, 'envs')
}

async function getProjectEnvVarById({ token, project, teamQuery, envVarId }) {
  return vercelRequest({
    method: 'GET',
    path: `/v1/projects/${encodeURIComponent(project)}/env/${encodeURIComponent(envVarId)}`,
    token,
    query: teamQuery,
  })
}

async function listSharedEnvVars({ token, teamQuery, project }) {
  const query = new URLSearchParams(teamQuery)

  if (project) {
    query.set('projectId', project)
  }

  const payload = await vercelRequest({
    method: 'GET',
    path: '/v1/env',
    token,
    query,
  })

  return collectEnvList(payload, 'data')
}

function buildRotationState(remoteEnvVars, options) {
  const byKey = new Map()

  for (const envVar of remoteEnvVars) {
    if (!envVar || typeof envVar.key !== 'string') {
      continue
    }

    if (!options.allowGitBranchVars && isGitBranchScoped(envVar)) {
      continue
    }

    if (!byKey.has(envVar.key)) {
      byKey.set(envVar.key, [])
    }

    byKey.get(envVar.key).push(envVar)
  }

  return byKey
}

function isExportableEnvVar(envVar) {
  return envVar.type !== 'sensitive' && envVar.type !== 'system'
}

async function hydrateProjectExportValues({ token, project, teamQuery, remoteEnvVars }) {
  return Promise.all(remoteEnvVars.map(async (envVar) => {
    if (!isExportableEnvVar(envVar) || hasReadablePlaintextValue(envVar) || !envVar.id) {
      return envVar
    }

    try {
      const byId = await getProjectEnvVarById({
        token,
        project,
        teamQuery,
        envVarId: envVar.id,
      })

      return {
        ...envVar,
        ...byId,
      }
    } catch (error) {
      warn(
        `Unable to fetch decrypted-by-id value for "${envVar.key}" (${envVar.id}): ` +
        `${error instanceof Error ? error.message : String(error)}`,
      )
      return envVar
    }
  }))
}

function buildPlan({ manifestEntries, remoteByKey, includeKeys, excludeKeys }) {
  const plan = []

  for (const [key, manifestEntry] of manifestEntries.entries()) {
    if (includeKeys.size > 0 && !includeKeys.has(key)) {
      continue
    }

    if (excludeKeys.has(key)) {
      continue
    }

    const currentEnvVars = remoteByKey.get(key) ?? []

    if (currentEnvVars.length === 0) {
      fail(`No current Vercel env vars found for "${key}".`)
    }

    const phases = []

    for (const phase of PHASES) {
      const matches = currentEnvVars.filter(envVar => appliesToTarget(envVar, phase))

      if (matches.length > 1) {
        fail(
          `Key "${key}" has ${matches.length} overlapping records for ${phase}. ` +
          'Clean that up manually first so rotation is deterministic.',
        )
      }

      if (matches.length === 0) {
        continue
      }

      const existing = matches[0]
      const replacementValue = manifestEntry[phase] ?? manifestEntry.all

      if (!replacementValue) {
        warn(`Skipping "${key}" for ${phase} because the manifest does not provide a replacement value.`)
        continue
      }

      if (looksLikeVercelCiphertext(replacementValue)) {
        fail(
          `Manifest entry "${key}" for ${phase} still contains a Vercel ciphertext blob. ` +
          'Replace it with the real new secret value before running rotation.',
        )
      }

      if (isGeneratedPlaceholder(replacementValue)) {
        fail(
          `Manifest entry "${key}" for ${phase} still contains a generated placeholder. ` +
          'Replace it with the real new secret value before running rotation.',
        )
      }

      phases.push({
        phase,
        existing,
        replacementValue,
      })
    }

    if (phases.length === 0) {
      warn(`Skipping "${key}" because it is not currently targeted to production or preview.`)
      continue
    }

    plan.push({
      key,
      manifestEntry,
      phases,
    })
  }

  if (plan.length === 0) {
    fail('No keys matched after applying include/exclude filters.')
  }

  return plan
}

function getRemainingTargets(existing, phase) {
  return normalizeTargets(existing.target).filter(target => target !== phase)
}

function buildNonSensitiveManifest({ remoteByKey, includeKeys, excludeKeys }) {
  const entries = []
  const unresolved = []

  for (const [key, envVars] of [...remoteByKey.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (includeKeys.size > 0 && !includeKeys.has(key)) {
      continue
    }

    if (excludeKeys.has(key)) {
      continue
    }

    const exportable = envVars.filter(isExportableEnvVar)

    if (exportable.length === 0) {
      continue
    }

    const phaseValues = {}
    const comments = new Set()

    for (const phase of PHASES) {
      const matches = exportable.filter(envVar => appliesToTarget(envVar, phase))

      if (matches.length > 1) {
        fail(
          `Key "${key}" has ${matches.length} non-sensitive records for ${phase}. ` +
          'Clean that up manually first so the exported manifest is deterministic.',
        )
      }

      const match = matches[0]

      if (!match) {
        continue
      }

      if (!hasReadablePlaintextValue(match)) {
        phaseValues[phase] = buildPlaceholderValue({ key, phase })
        unresolved.push({
          key,
          phase,
          id: match.id,
          type: match.type,
          reason: looksLikeVercelCiphertext(match.value)
            ? 'vercel_returned_ciphertext'
            : 'vercel_did_not_return_plaintext',
        })
      } else {
        phaseValues[phase] = match.value
      }

      if (match.comment) {
        comments.add(match.comment)
      }
    }

    if (!phaseValues.production && !phaseValues.preview) {
      continue
    }

    const entry = { key }

    if (phaseValues.production && phaseValues.preview && phaseValues.production === phaseValues.preview) {
      entry.all = phaseValues.production
    } else {
      if (phaseValues.production) {
        entry.production = phaseValues.production
      }

      if (phaseValues.preview) {
        entry.preview = phaseValues.preview
      }
    }

    if (comments.size === 1) {
      entry.comment = [...comments][0]
    }

    entries.push(entry)
  }

  return { entries, unresolved }
}

async function dumpNonSensitiveManifest({
  scope,
  token,
  project,
  teamQuery,
  includeKeys,
  excludeKeys,
  allowGitBranchVars,
  outputPath,
}) {
  info(`Loading current ${scope} environment variables from Vercel...`)

  const remoteEnvVars = scope === 'project'
    ? await listProjectEnvVarsInternal({
      token,
      project,
      teamQuery,
      decrypt: true,
    })
    : await listSharedEnvVars({
      token,
      teamQuery,
      project,
    })
  const hydratedRemoteEnvVars = scope === 'project'
    ? await hydrateProjectExportValues({
      token,
      project,
      teamQuery,
      remoteEnvVars,
    })
    : remoteEnvVars

  const remoteByKey = buildRotationState(hydratedRemoteEnvVars, {
    allowGitBranchVars,
  })
  const manifest = buildNonSensitiveManifest({
    remoteByKey,
    includeKeys,
    excludeKeys,
  })
  const manifestJson = `${JSON.stringify({ entries: manifest.entries }, null, 2)}\n`

  if (outputPath) {
    await writeFile(outputPath, manifestJson, 'utf8')
    info(`Wrote non-sensitive manifest to ${outputPath}`)
    if (manifest.unresolved.length > 0) {
      const unresolvedOutputPath = buildUnresolvedOutputPath(outputPath)
      await writeFile(
        unresolvedOutputPath,
        `${JSON.stringify({ unresolved: manifest.unresolved }, null, 2)}\n`,
        'utf8',
      )
      info(`Wrote unresolved export report to ${unresolvedOutputPath}`)
      warn(
        `${manifest.unresolved.length} values could not be exported as plaintext. ` +
        'The manifest contains REPLACE_WITH_NEW_* placeholders that must be filled in manually.',
      )
    }
    return
  }

  process.stdout.write(manifestJson)
  if (manifest.unresolved.length > 0) {
    warn(
      `${manifest.unresolved.length} values could not be exported as plaintext. ` +
      'Re-run with --output to also write a separate .unresolved.json report.',
    )
  }
}

function describePhaseAction({ key, phase, existing }) {
  const existingTargets = normalizeTargets(existing.target).join(',')
  const existingType = existing.type ?? 'unknown'
  const splitNote = normalizeTargets(existing.target).length > 1
    ? `split existing targets [${existingTargets}]`
    : `replace existing [${existingTargets}]`

  return `- ${key} (${phase}): ${splitNote}, recreate as sensitive (was ${existingType})`
}

async function patchProjectEnvTarget({ token, project, teamQuery, envVarId, target }) {
  await vercelRequest({
    method: 'PATCH',
    path: `/v9/projects/${encodeURIComponent(project)}/env/${encodeURIComponent(envVarId)}`,
    token,
    query: teamQuery,
    body: { target },
  })
}

async function deleteProjectEnv({ token, project, teamQuery, envVarId }) {
  await vercelRequest({
    method: 'DELETE',
    path: `/v9/projects/${encodeURIComponent(project)}/env/${encodeURIComponent(envVarId)}`,
    token,
    query: teamQuery,
  })
}

async function createProjectSensitiveEnv({
  token,
  project,
  teamQuery,
  key,
  value,
  phase,
  comment,
}) {
  await vercelRequest({
    method: 'POST',
    path: `/v10/projects/${encodeURIComponent(project)}/env`,
    token,
    query: teamQuery,
    body: [
      {
        key,
        value,
        type: 'sensitive',
        target: [phase],
        ...(comment ? { comment } : {}),
      },
    ],
  })
}

async function patchSharedEnvTarget({ token, teamQuery, envVarId, target }) {
  const payload = await vercelRequest({
    method: 'PATCH',
    path: '/v1/env',
    token,
    query: teamQuery,
    body: {
      updates: {
        [envVarId]: { target },
      },
    },
  })

  if (payload?.failed?.length) {
    throw new Error(`Shared env PATCH failed: ${JSON.stringify(payload.failed)}`)
  }
}

async function deleteSharedEnv({ token, teamQuery, envVarId }) {
  const payload = await vercelRequest({
    method: 'DELETE',
    path: '/v1/env',
    token,
    query: teamQuery,
    body: { ids: [envVarId] },
  })

  if (payload?.failed?.length) {
    throw new Error(`Shared env DELETE failed: ${JSON.stringify(payload.failed)}`)
  }
}

async function createSharedSensitiveEnv({
  token,
  teamQuery,
  key,
  value,
  phase,
  comment,
  projectIds,
}) {
  const payload = await vercelRequest({
    method: 'POST',
    path: '/v1/env',
    token,
    query: teamQuery,
    body: {
      evs: [
        {
          key,
          value,
          ...(comment ? { comment } : {}),
        },
      ],
      type: 'sensitive',
      target: [phase],
      ...(Array.isArray(projectIds) && projectIds.length > 0 ? { projectId: projectIds } : {}),
    },
  })

  if (payload?.failed?.length) {
    throw new Error(`Shared env CREATE failed: ${JSON.stringify(payload.failed)}`)
  }
}

async function rotatePhase({ scope, token, project, teamQuery, key, manifestEntry, phaseState }) {
  const { phase, existing, replacementValue } = phaseState
  const remainingTargets = getRemainingTargets(existing, phase)
  const comment = manifestEntry.comment ?? existing.comment

  info(`Rotating ${key} for ${phase}...`)

  if (scope === 'project') {
    if (remainingTargets.length > 0) {
      await patchProjectEnvTarget({
        token,
        project,
        teamQuery,
        envVarId: existing.id,
        target: remainingTargets,
      })
      existing.target = remainingTargets
    } else {
      await deleteProjectEnv({
        token,
        project,
        teamQuery,
        envVarId: existing.id,
      })
      existing.target = []
    }

    await createProjectSensitiveEnv({
      token,
      project,
      teamQuery,
      key,
      value: replacementValue,
      phase,
      comment,
    })

    return
  }

  if (remainingTargets.length > 0) {
    await patchSharedEnvTarget({
      token,
      teamQuery,
      envVarId: existing.id,
      target: remainingTargets,
    })
    existing.target = remainingTargets
  } else {
    await deleteSharedEnv({
      token,
      teamQuery,
      envVarId: existing.id,
    })
    existing.target = []
  }

  await createSharedSensitiveEnv({
    token,
    teamQuery,
    key,
    value: replacementValue,
    phase,
    comment,
    projectIds: existing.projectId,
  })
}

function verifyPlanAgainstRemote(plan, remoteByKey) {
  for (const item of plan) {
    const currentEnvVars = remoteByKey.get(item.key) ?? []

    for (const phaseState of item.phases) {
      const matches = currentEnvVars.filter(envVar => appliesToTarget(envVar, phaseState.phase))

      if (matches.length !== 1) {
        fail(`Verification failed for "${item.key}" in ${phaseState.phase}: expected exactly one record.`)
      }

      const match = matches[0]

      if (match.type !== 'sensitive') {
        fail(`Verification failed for "${item.key}" in ${phaseState.phase}: type is ${match.type}, expected sensitive.`)
      }
    }
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      help: { type: 'boolean', short: 'h' },
      scope: { type: 'string' },
      project: { type: 'string' },
      manifest: { type: 'string' },
      'team-id': { type: 'string' },
      'team-slug': { type: 'string' },
      include: { type: 'string' },
      exclude: { type: 'string' },
      yes: { type: 'boolean' },
      'allow-git-branch-vars': { type: 'boolean' },
      'dump-non-sensitive-manifest': { type: 'boolean' },
      output: { type: 'string' },
    },
    allowPositionals: false,
  })

  if (values.help) {
    printHelp()
    return
  }

  const scope = values.scope

  if (scope !== 'project' && scope !== 'shared') {
    fail('Pass --scope project or --scope shared.')
  }

  if (scope === 'project' && !values.project) {
    fail('Project scope requires --project <project-id-or-name>.')
  }

  const token = getToken()
  const teamQuery = getTeamQuery({
    teamId: values['team-id'],
    teamSlug: values['team-slug'],
  })
  const includeKeys = parseCommaList(values.include)
  const excludeKeys = parseCommaList(values.exclude)

  if (values['dump-non-sensitive-manifest']) {
    await dumpNonSensitiveManifest({
      scope,
      token,
      project: values.project,
      teamQuery,
      includeKeys,
      excludeKeys,
      allowGitBranchVars: Boolean(values['allow-git-branch-vars']),
      outputPath: values.output,
    })
    return
  }

  if (!values.manifest) {
    fail('Pass --manifest with a JSON manifest file.')
  }

  const manifestEntries = await readManifest(values.manifest)

  info(`Loading current ${scope} environment variables from Vercel...`)

  const remoteEnvVars = scope === 'project'
    ? await listProjectEnvVars({
      token,
      project: values.project,
      teamQuery,
    })
    : await listSharedEnvVars({
      token,
      teamQuery,
      project: values.project,
    })

  const remoteByKey = buildRotationState(remoteEnvVars, {
    allowGitBranchVars: Boolean(values['allow-git-branch-vars']),
  })
  const plan = buildPlan({
    manifestEntries,
    remoteByKey,
    includeKeys,
    excludeKeys,
  })

  info('')
  info('Planned rotation:')

  for (const item of plan) {
    for (const phaseState of item.phases) {
      info(describePhaseAction({
        key: item.key,
        phase: phaseState.phase,
        existing: phaseState.existing,
      }))
    }
  }

  if (!values.yes) {
    info('')
    info('Plan only. Re-run with --yes to perform the rotation.')
    return
  }

  info('')
  info('Applying rotation in order: production, then preview.')

  for (const phase of PHASES) {
    info('')
    info(`=== ${phase.toUpperCase()} ===`)

    for (const item of plan) {
      const phaseState = item.phases.find(candidate => candidate.phase === phase)

      if (!phaseState) {
        continue
      }

      await rotatePhase({
        scope,
        token,
        project: values.project,
        teamQuery,
        key: item.key,
        manifestEntry: item.manifestEntry,
        phaseState,
      })
    }
  }

  info('')
  info('Verifying final state...')

  const finalRemoteEnvVars = scope === 'project'
    ? await listProjectEnvVars({
      token,
      project: values.project,
      teamQuery,
    })
    : await listSharedEnvVars({
      token,
      teamQuery,
      project: values.project,
    })

  const finalRemoteByKey = buildRotationState(finalRemoteEnvVars, {
    allowGitBranchVars: Boolean(values['allow-git-branch-vars']),
  })

  verifyPlanAgainstRemote(plan, finalRemoteByKey)

  info('Rotation complete. All rotated production/preview variables now verify as sensitive.')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
