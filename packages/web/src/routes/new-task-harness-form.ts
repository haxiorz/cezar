// Harness-only picker rules, apart from `new-task-form` so the Task tab's eager bundle never
// carries them: only the lazily loaded Multi-model surface imports this module (PR #925 review).
import type {
  HarnessCertification,
  HarnessModelRef,
  HarnessPreset,
  HarnessProbeResponse,
  HarnessProfile,
  HarnessRoles,
  HarnessSkillProfile,
  HarnessStatusResponse,
  Runner,
  RunnerModelCatalogResponse,
} from '@open-mercato/cezar-api-client'
import { modelsForRunner } from './new-task-form'

export interface HarnessProfileOption {
  id: HarnessProfile
  label: string
  desc: string
}

/**
 * The five operating profiles of the repo's `agentHarness.profiles`, in escalation order.
 * `id` is the om-config wire name and never changes; `label`/`desc` are the human surface.
 *
 * DISPLAY ONLY since 2026-07-27 (user feedback): the composer no longer offers a profile —
 * every Multi-model run is a custom lineup. This list survives as the label map for
 * Settings → Harness, which reports which profiles the repo config declares.
 */
export const HARNESS_PROFILE_OPTIONS: readonly HarnessProfileOption[] = [
  { id: 'standard', label: 'Claude solo', desc: 'Claude writes the code; a second, fresh Claude context reviews it. Works with zero setup.' },
  { id: 'optimized', label: 'Worker offload', desc: 'A sandboxed worker model (e.g. Codex) writes the code; Claude directs and reviews.' },
  { id: 'multi', label: 'Review council', desc: 'Several independent models (DeepSeek, Kimi, GLM…) each review the diff; findings are merged.' },
  { id: 'multi-optimized', label: 'Council + worker', desc: 'The worker writes the code and the full multi-model council reviews it.' },
]

export interface HarnessMode {
  id: 'fix-issue' | 'implement-feature'
  workflow: string
  label: string
  desc: string
}

/** The two things the multi-model tab can run — plain names over the workflow ids. Built for
 *  long, one-shot builds (a whole module) and end-to-end issue fixes, always staged-only. */
export const HARNESS_MODES: readonly HarnessMode[] = [
  {
    id: 'fix-issue',
    workflow: 'harness-fix-issue',
    label: 'Fix an issue',
    desc: 'Qualify, diagnose, fix, validate, and review a tracker issue end to end.',
  },
  {
    id: 'implement-feature',
    workflow: 'harness-implement-feature',
    label: 'Build a feature',
    desc: 'Spec first, then implement — sized for big one-shot builds like a whole module.',
  },
]

/* ---- role-based selection (user feedback 2026-07-24) ---------------------------------- */

/** One pickable model for a harness role, with its provider family precomputed. */
export interface HarnessModelOption extends HarnessModelRef {
  label: string
  family: string
  /** The catalog's description, e.g. "Opus 5.5 with 1M context". An alias like `opus` names no
   *  version on its own, and the picker showing only "Opus" read as "Opus 5.5 is missing". */
  desc?: string
  /** Recorded eval-gate evidence (spec 2026-08-06-eval-gated-model-routing), carried from
   *  `/harness/status`. Absent on runner options — only configured bindings are certified. */
  certification?: HarnessCertification
}

/** The runners a harness role can name (the contract's `harnessRunnerSchema`). */
const HARNESS_RUNNERS = ['claude', 'codex', 'opencode'] as const satisfies readonly Runner[]

export function isHarnessRunner(runner: Runner): runner is (typeof HARNESS_RUNNERS)[number] {
  return (HARNESS_RUNNERS as readonly Runner[]).includes(runner)
}

const GATEWAY_PREFIXES: ReadonlySet<string> = new Set(['opencode', 'openrouter', 'zen'])

const FAMILY_BY_NAME: ReadonlyArray<[RegExp, string]> = [
  [/^glm/i, 'zhipu'],
  [/^kimi/i, 'moonshot'],
  [/^deepseek/i, 'deepseek'],
  [/^mimo/i, 'xiaomi'],
  [/^qwen/i, 'alibaba'],
  [/^gpt|^o[0-9]|^codex/i, 'openai'],
  [/^claude/i, 'anthropic'],
  [/^gemini/i, 'google'],
  [/^grok/i, 'xai'],
  [/^llama/i, 'meta'],
  [/^mistral|^magistral/i, 'mistral'],
  [/^nemotron/i, 'nvidia'],
  [/^ling|^ring/i, 'inclusionai'],
]

const FAMILY_BY_VENDOR: Readonly<Record<string, string>> = {
  moonshotai: 'moonshot',
  'z-ai': 'zhipu',
  'x-ai': 'xai',
  'meta-llama': 'meta',
  mistralai: 'mistral',
  qwen: 'alibaba',
}

/**
 * The provider family a (runner, model) pair belongs to — the diversity axis of the
 * multi-model rule.
 *
 * BYTE-FAITHFUL MIRROR of `providerFamilyOf` in `src/harness/model-family.ts`
 * (the browser cannot import server code). The two must change together: when
 * they disagreed, the composer admitted a lineup the driver's quorum then counted
 * differently — `claude/sonnet` + `opencode/claude-sonnet-4-5` passed as two
 * families while being one vendor (review 2026-07-27).
 */
export function modelFamilyOf(ref: HarnessModelRef): string {
  // Advisor refs (spec 2026-07-24-advisor-reviewers) carry their provider
  // family from /harness/status — kimi→moonshot, glm→zhipu.
  if (ref.runner === 'harness') return ref.family ?? 'harness'

  const slash = ref.model.indexOf('/')
  const prefix = slash > 0 ? ref.model.slice(0, slash).toLowerCase() : ''

  const runnerFallback =
    ref.runner === 'claude' ? 'anthropic'
    : ref.runner === 'codex' ? 'openai'
    : (GATEWAY_PREFIXES.has(prefix) ? prefix : '') || ref.runner

  const segments = ref.model.split('/')
  let at = 0
  while (at < segments.length - 1 && GATEWAY_PREFIXES.has(segments[at]!.toLowerCase())) at += 1
  const vendor = at < segments.length - 1 ? segments[at]!.toLowerCase() : ''
  const name = segments.slice(vendor ? at + 1 : at).join('/')
  for (const [pattern, family] of FAMILY_BY_NAME) if (pattern.test(name)) return family
  return vendor ? (FAMILY_BY_VENDOR[vendor] ?? vendor) : runnerFallback
}

/** Reviewer options from the configured `agentHarness` bindings (`/harness/status`):
 *  DeepSeek via API, kimi via its subscription CLI, Zen presets — executed by the
 *  runtime's review council, not a runner session (spec 2026-07-24-advisor-reviewers).
 *  Reviewer-only: the other roles filter these out. */
export function advisorHarnessOptions(
  status?: HarnessStatusResponse,
  runnerOptions: readonly HarnessModelOption[] = [],
): HarnessModelOption[] {
  // One row per model (2026-09-29). A binding the server reports as `sameAs` a runner-backed
  // reviewer makes that reviewer's exact call, so it is dropped when that reviewer is already
  // listed — and kept when it is not (OpenCode missing, a model its catalog lacks), so no
  // route disappears.
  const listed = (ref: { runner: string; model: string }) =>
    runnerOptions.some((option) => option.runner === ref.runner && option.model === ref.model)
  return (status?.models ?? [])
    .filter((m) => m.adapter !== undefined && m.adapter !== 'host' && m.roles.includes('reviewer'))
    .filter((m) => !(m.sameAs && listed(m.sameAs)))
    .map((m) => ({
      runner: 'harness' as const,
      model: m.id,
      label: m.model ? `${m.id} · ${m.model}` : m.id,
      family: m.family ?? 'harness',
      ...(m.certification ? { certification: m.certification } : {}),
    }))
}

const sameRef = (a: HarnessModelRef, b: HarnessModelRef) => a.runner === b.runner && a.model === b.model

/**
 * Why a role selection cannot run, or null when it is sound. The tab is STRICTLY
 * multi-model: 2–5 reviewers, all unique, spanning at least two model families — a
 * single-voice council is exactly what this surface exists to prevent.
 */
export function harnessRolesIssue(roles: HarnessRoles): string | null {
  // The seating rule the server enforces, said here instead of as a 409. The picker no
  // longer OFFERS OpenCode for a session role, but a saved preset or a draft from before
  // this rule can still carry one, and "Start" answering 409 is a worse way to learn it.
  for (const [role, ref] of [
    ['Orchestrator', roles.orchestrator],
    ['Implementer', roles.implementer],
  ] as const) {
    if (ref.runner === 'opencode') {
      return `${role}: OpenCode runs as an agent session and cezar cannot hold it to stage-only. Pick a Claude or Codex model — OpenCode can still review.`
    }
  }
  if (roles.reviewers.length < 2) return 'Pick at least 2 reviewers — multi-model means more than one voice.'
  if (roles.reviewers.length > 5) return 'Pick at most 5 reviewers.'
  for (let i = 0; i < roles.reviewers.length; i += 1) {
    for (let j = i + 1; j < roles.reviewers.length; j += 1) {
      if (sameRef(roles.reviewers[i]!, roles.reviewers[j]!)) return 'Reviewers must be unique models.'
    }
  }
  const families = new Set(roles.reviewers.map(modelFamilyOf))
  if (families.size < 2) {
    return 'Reviewers must span at least two different model families (e.g. Anthropic + OpenAI).'
  }
  return null
}

/** One provider-family group of the model picker (user feedback 2026-07-24: the flat list
 *  does not scale — group by provider, searchable). Anthropic and OpenAI lead (the two
 *  backends every setup starts from); the rest follow alphabetically. */
export interface HarnessOptionGroup {
  family: string
  options: HarnessModelOption[]
}

export function groupHarnessOptions(options: readonly HarnessModelOption[]): HarnessOptionGroup[] {
  const byFamily = new Map<string, HarnessModelOption[]>()
  for (const option of options) {
    const list = byFamily.get(option.family) ?? []
    list.push(option)
    byFamily.set(option.family, list)
  }
  const LEAD = ['anthropic', 'openai']
  const families = [...byFamily.keys()].sort((a, b) => {
    const la = LEAD.indexOf(a)
    const lb = LEAD.indexOf(b)
    if (la !== -1 || lb !== -1) return (la === -1 ? LEAD.length : la) - (lb === -1 ? LEAD.length : lb)
    return a.localeCompare(b)
  })
  return families.map((family) => ({ family, options: byFamily.get(family)! }))
}

const sameSelection = (a: HarnessModelRef, b: HarnessModelRef) =>
  sameRef(a, b) && a.effort === b.effort

export function rolesEqual(a: HarnessRoles, b: HarnessRoles): boolean {
  return (
    sameSelection(a.orchestrator, b.orchestrator) &&
    sameSelection(a.implementer, b.implementer) &&
    a.reviewers.length === b.reviewers.length &&
    a.reviewers.every((r, i) => sameSelection(r, b.reviewers[i]!))
  )
}

/** Saved role lineups from loose ui-state data (the store is passthrough by design):
 *  malformed entries drop, the list caps at 12. The cap is EXPLICIT — saving past it is
 *  refused with guidance (see `canSaveHarnessPreset`), never a silent eviction: presets are
 *  quick-switch chips, and past a dozen they stop being quick. */
export const HARNESS_PRESETS_MAX = 12

/** How many preset chips render inline in the lineup header; the rest live in the
 *  "+N more" overflow menu so the header keeps one stable row at any count. */
export const HARNESS_PRESETS_VISIBLE = 3

/** Whether a save is allowed: under the cap, or replacing an existing name (no growth). */
export function canSaveHarnessPreset(
  presets: readonly HarnessPreset[],
  name: string,
): { ok: true } | { ok: false; reason: string } {
  const replaces = presets.some((p) => p.name === name)
  if (replaces || presets.length < HARNESS_PRESETS_MAX) return { ok: true }
  return {
    ok: false,
    reason: `${HARNESS_PRESETS_MAX} presets max — delete one first, or reuse an existing name to replace it.`,
  }
}

/** The header's chip split: the first few presets inline, everything else in the overflow —
 *  and the ACTIVE preset (the one matching `roles`) always stays visible, pulled out of the
 *  overflow when needed so "which lineup am I on" never hides behind a menu. */
export function visibleHarnessPresets(
  presets: readonly HarnessPreset[],
  roles: HarnessRoles | null,
): { visible: HarnessPreset[]; overflow: HarnessPreset[] } {
  const visible = presets.slice(0, HARNESS_PRESETS_VISIBLE)
  const rest = presets.slice(HARNESS_PRESETS_VISIBLE)
  if (roles !== null) {
    const active = rest.find((p) => rolesEqual(p.roles, roles))
    if (active !== undefined) {
      return { visible: [...visible, active], overflow: rest.filter((p) => p.id !== active.id) }
    }
  }
  return { visible, overflow: rest }
}

export function normalizeHarnessPresets(raw: unknown): HarnessPreset[] {
  if (!Array.isArray(raw)) return []
  const out: HarnessPreset[] = []
  for (const entry of raw) {
    if (out.length >= HARNESS_PRESETS_MAX) break
    if (!entry || typeof entry !== 'object') continue
    const preset = entry as HarnessPreset
    if (typeof preset.id !== 'string' || typeof preset.name !== 'string' || preset.name === '') continue
    const roles = preset.roles as HarnessRoles | undefined
    if (
      !roles ||
      !isRunnerRefShape(roles.orchestrator) ||
      !isRunnerRefShape(roles.implementer) ||
      !Array.isArray(roles.reviewers) ||
      !roles.reviewers.every(isModelRefShape)
    ) {
      continue
    }
    out.push({
      id: preset.id,
      name: preset.name,
      roles: {
        orchestrator: sanitizeRunnerRef(roles.orchestrator),
        implementer: sanitizeRunnerRef(roles.implementer),
        reviewers: roles.reviewers.map(sanitizeRef),
      },
    })
  }
  return out
}

const HARNESS_EFFORTS: readonly string[] = ['low', 'medium', 'high', 'max']

function sanitizeRef(ref: HarnessModelRef): HarnessModelRef {
  const effort = typeof ref.effort === 'string' && HARNESS_EFFORTS.includes(ref.effort) ? ref.effort : undefined
  return {
    runner: ref.runner,
    model: ref.model,
    ...(ref.runner === 'harness' && typeof ref.family === 'string' ? { family: ref.family } : {}),
    ...(effort ? { effort } : {}),
  }
}

type HarnessRunnerRef = HarnessRoles['orchestrator']

function sanitizeRunnerRef(ref: HarnessRunnerRef): HarnessRunnerRef {
  const effort =
    typeof ref.effort === 'string' && HARNESS_EFFORTS.includes(ref.effort)
      ? ref.effort
      : undefined
  return {
    runner: ref.runner,
    model: ref.model,
    ...(effort ? { effort } : {}),
  }
}

/**
 * Every runner a saved lineup may name — INCLUDING `harness`, the configured
 * advisor reviewers (deepseek-api, kimi-subscription…).
 *
 * Omitting it silently destroyed data (review 2026-07-27): saving a preset whose
 * council contained an advisor wrote it to ui-state, the refetch ran this
 * normaliser, the whole preset failed the shape check, and the chip vanished a
 * moment after the user named it — with no error, because the write path
 * swallows failures. `new-task-draft.ts` already accepted all four runners, so
 * the draft kept the very lineup the preset could not.
 */
function isModelRefShape(raw: unknown): raw is HarnessModelRef {
  if (!raw || typeof raw !== 'object') return false
  const ref = raw as HarnessModelRef
  if (typeof ref.model !== 'string') return false
  if (ref.runner === 'harness') {
    return typeof ref.family === 'string' && ref.family !== ''
  }
  return ['claude', 'codex', 'opencode'].includes(ref.runner)
}

function isRunnerRefShape(raw: unknown): raw is HarnessRunnerRef {
  return isModelRefShape(raw) && raw.runner !== 'harness'
}

/**
 * Warn when a free-tier gateway model is bound to a reviewer slot.
 *
 * Free tiers are throughput-limited and routinely cannot finish a full review
 * inside its budget — observed live: `mimo-v2.5-free` burned two consecutive
 * 60-minute budgets on one spec review without ever producing a result, and the
 * council lost that voice. The run now survives it (quorum), but the user is
 * better off knowing before they spend the tokens. Returns null when nothing
 * needs saying.
 */
export function freeTierReviewerWarning(roles: HarnessRoles | null): string | null {
  if (!roles) return null
  const free = roles.reviewers.filter((r) => /-free$/.test(r.model))
  if (free.length === 0) return null
  const names = [...new Set(free.map((r) => r.model))].join(', ')
  return `${names} ${free.length > 1 ? 'are free-tier models' : 'is a free-tier model'} — free tiers often cannot finish a full review in time. The council continues without a reviewer that fails, but you lose its perspective.`
}

/**
 * The options a SESSION role — orchestrator or implementer — may take.
 *
 * Two exclusions, for two different reasons. An advisor has no session at all
 * (reviewer-only by construction). OpenCode has one, but cezar has no seam to
 * hold it to stage-only — a `PreToolUse` hook and sandboxed Bash for claude, the
 * workspace-write sandbox for codex, nothing for OpenCode — so the server
 * refuses those two roles on it. Offering them anyway is how the picker came to
 * DEFAULT the orchestrator to `opencode/claude-fable-5`, probe it green, and
 * enable Start on a lineup that always answered 409.
 *
 * Reviewers deliberately keep OpenCode: a reviewer resolves to one structured
 * gateway call (`reviewer-binding.ts`), never a session, so nothing about
 * stage-only applies to it.
 */
export function sessionRoleOptions(
  allOptions: readonly HarnessModelOption[],
): Array<HarnessModelOption & { runner: HarnessRunnerRef['runner'] }> {
  return allOptions.filter(
    (option): option is HarnessModelOption & { runner: HarnessRunnerRef['runner'] } =>
      option.runner !== 'harness' && option.runner !== 'opencode',
  )
}

/**
 * The OpenCode providers a reviewer can be routed through — the keys of `GATEWAYS` in
 * `packages/cezar/src/harness/reviewer-binding.ts` (a test there holds the two lists equal). An
 * OpenCode reviewer becomes one structured call to its gateway; any other provider prefix
 * (`openai/…` through OpenCode's own login, the bare `auto`) has no such call, and the server
 * refuses the start with "no structured review path".
 */
export const REVIEWER_GATEWAYS: readonly string[] = ['opencode', 'deepseek']

/** What each reviewer gateway IS, for the picker. An `opencode/…` or `deepseek/…` reviewer is one
 *  HTTPS call to that provider with your key — OpenCode only stores the key — so labelling the
 *  row `opencode ·` read as "through OpenCode" (2026-09-30: "I want DeepSeek via my API, not
 *  through opencode" — it already was). Keys match {@link REVIEWER_GATEWAYS}. */
const GATEWAY_NAMES: Readonly<Record<string, string>> = { opencode: 'Zen', deepseek: 'DeepSeek API' }

/** One lineup ref as the picker shows it: `Zen · glm-5.3`, `DeepSeek API · deepseek-v4-pro`,
 *  `claude · Opus`. `label` is the catalog's display name when there is one. */
export function harnessRefDisplay(ref: HarnessModelRef, label?: string): string {
  if (ref.runner === 'opencode') {
    const slash = ref.model.indexOf('/')
    const name = slash > 0 ? GATEWAY_NAMES[ref.model.slice(0, slash)] : undefined
    if (name) return `${name} · ${ref.model.slice(slash + 1)}`
  }
  return `${ref.runner} · ${label ?? (ref.model || 'auto')}`
}

/**
 * The models a REVIEWER seat can hold: everything except OpenCode models no gateway can
 * reach. Offering those only let the user build a council that could never start (2026-09-29).
 */
export function reviewerOptions(options: readonly HarnessModelOption[]): HarnessModelOption[] {
  return options.filter((option) => {
    if (option.runner !== 'opencode') return true
    const slash = option.model.indexOf('/')
    return slash > 0 && REVIEWER_GATEWAYS.includes(option.model.slice(0, slash))
  })
}

export function defaultHarnessRoles(allOptions: readonly HarnessModelOption[]): HarnessRoles | null {
  const options = sessionRoleOptions(allOptions)
  const families = [...new Set(options.map((o) => o.family))]
  if (families.length < 2 || options.length < 2) return null
  // Named models first. `auto` (model '') is whatever the CLI picks on its own, and for a Codex
  // ChatGPT login that is a model the account refuses — the zero-config lineup opened blocked
  // on a red implementer (2026-09-28). `auto` stays the fallback for a family with no catalog.
  const byFamily = (family: string) => {
    const members = options.filter((o) => o.family === family)
    return [...members.filter((o) => o.model !== ''), ...members.filter((o) => o.model === '')]
  }
  const anthropic = byFamily('anthropic')
  const orchestrator = anthropic.find((o) => o.model === 'sonnet') ?? anthropic[0] ?? options[0]!
  const otherFamily = families.find((f) => f !== orchestrator.family)!
  const implementer = byFamily(otherFamily)[0]!
  const reviewers = [
    byFamily(orchestrator.family).find((o) => !sameRef(o, orchestrator)) ?? orchestrator,
    implementer,
  ]
  return {
    orchestrator: { runner: orchestrator.runner, model: orchestrator.model },
    implementer: { runner: implementer.runner, model: implementer.model },
    reviewers: reviewers.map((r) => ({ runner: r.runner, model: r.model })),
  }
}

/* ---- eval-gate certification (spec 2026-08-06-eval-gated-model-routing) ---------------- */

/** The role slice of an option's recorded certification, or null when there is none. */
export function certifiedRoleRate(
  option: HarnessModelOption,
  role: 'orchestrator' | 'implementer' | 'reviewer',
): { cases: number; passed: number; status: 'certified' | 'stale' } | null {
  const cert = option.certification
  const rate = cert?.roles?.[role]
  if (!cert || !rate || cert.status === 'uncertified') return null
  return { ...rate, status: cert.status }
}

const asReviewerRef = (option: HarnessModelOption): HarnessModelRef =>
  option.runner === 'harness'
    ? { runner: 'harness', model: option.model, family: option.family }
    : { runner: option.runner, model: option.model }

/**
 * The best CERTIFIED lineup the workspace can field, or null when there are no
 * receipts to pick by — then the button that applies this does not exist, and
 * the passive `defaultHarnessRoles` heuristic stays the only pre-fill.
 *
 * Deliberately an EXPLICIT action, not the passive default: advisors never
 * auto-seed ("advisors are an explicit choice"), and applying a recorded-score
 * lineup is exactly such a choice. Rules preserved from the manual path: 2–5
 * unique reviewers spanning ≥2 families; orchestrator/implementer stay runner
 * sessions (advisor bindings are reviewer-only by construction). A certified
 * option beats a stale one beats an unscored one; ties break on pass rate.
 */
export function bestCertifiedRoles(allOptions: readonly HarnessModelOption[]): HarnessRoles | null {
  const base = defaultHarnessRoles(allOptions)
  if (!base) return null
  const reviewerScore = (option: HarnessModelOption): number => {
    const rate = certifiedRoleRate(option, 'reviewer')
    if (!rate || rate.cases === 0) return -1
    return (rate.status === 'certified' ? 2 : 1) + rate.passed / rate.cases
  }
  const ranked = [...allOptions]
    .filter((option) => reviewerScore(option) >= 0)
    .sort((a, b) => reviewerScore(b) - reviewerScore(a))
  const certified = ranked.filter((o) => certifiedRoleRate(o, 'reviewer')?.status === 'certified')
  if (certified.length === 0) return null

  const seats: HarnessModelOption[] = certified.slice(0, 5)
  const used = () => new Set(seats.map(refKeyOf))
  const fill = (candidates: readonly HarnessModelOption[], wantOtherFamily: boolean) =>
    candidates.find(
      (o) =>
        !used().has(refKeyOf(o)) &&
        (!wantOtherFamily || o.family !== seats[0]!.family),
    )
  // Family diversity + the 2-seat floor, from the best remaining evidence: first
  // stale-certified options, then the heuristic default's own reviewers.
  const fallbackPool = [...ranked, ...allOptions.filter((o) => reviewerScore(o) < 0)]
  if (new Set(seats.map((o) => o.family)).size < 2) {
    const other = fill(fallbackPool, true)
    if (!other) return null
    if (seats.length === 5) seats.pop()
    seats.push(other)
  }
  if (seats.length < 2) {
    const extra = fill(fallbackPool, new Set(seats.map((o) => o.family)).size < 2)
    if (!extra) return null
    seats.push(extra)
  }

  const roleScore = (
    option: HarnessModelOption,
    role: 'orchestrator' | 'implementer',
  ): number => {
    const rate = certifiedRoleRate(option, role)
    if (!rate || rate.status !== 'certified' || rate.cases === 0) return -1
    return rate.passed / rate.cases
  }
  const runners = allOptions.filter((o) => o.runner !== 'harness')
  const bestFor = (role: 'orchestrator' | 'implementer') =>
    runners.filter((o) => roleScore(o, role) >= 0).sort((a, b) => roleScore(b, role) - roleScore(a, role))[0]
  const orchestrator = bestFor('orchestrator')
  const implementer = bestFor('implementer')
  return {
    orchestrator: orchestrator
      ? { runner: orchestrator.runner as HarnessRunnerRef['runner'], model: orchestrator.model }
      : base.orchestrator,
    implementer: implementer
      ? { runner: implementer.runner as HarnessRunnerRef['runner'], model: implementer.model }
      : base.implementer,
    reviewers: seats.map(asReviewerRef),
  }
}

const refKeyOf = (ref: HarnessModelRef | HarnessModelOption) => `${ref.runner}/${ref.model}`

/**
 * The certification advisory for a picked lineup, or null when nothing needs
 * saying. Silent while the workspace has NO recorded certifications at all —
 * before the first certify run, "uncertified" is every model's state and the
 * line would be noise. Once receipts exist, an unscored or stale reviewer is
 * worth a sentence: runs are unaffected, the results are simply unverified.
 */
export function certificationAdvisory(
  roles: HarnessRoles | null,
  options: readonly HarnessModelOption[],
): string | null {
  if (!roles) return null
  if (!options.some((o) => certifiedRoleRate(o, 'reviewer'))) return null
  const byKey = new Map(options.map((o) => [refKeyOf(o), o]))
  const flagged = roles.reviewers
    .map((ref) => {
      const option = byKey.get(refKeyOf(ref))
      const rate = option ? certifiedRoleRate(option, 'reviewer') : null
      const label = option?.label ?? ref.model
      if (!rate) return { label, why: 'not certified for review' }
      if (rate.status === 'stale') return { label, why: 'certification is stale' }
      return null
    })
    .filter((entry): entry is { label: string; why: string } => entry !== null)
  if (flagged.length === 0) return null
  const parts = flagged.map((f) => `${f.label} — ${f.why}`).join('; ')
  return `${parts}. Runs are unaffected; their review results are simply unverified by the eval suite.`
}

/**
 * The probe's verdict for one lineup seat. The probe ids a ref `runner/model`, with `auto` for
 * the CLI default — except Claude's default, which it ids `claude` to match the status roster's
 * host row. Looking up only `claude/auto` left that chip with no dot at all.
 */
export function probeReadinessFor(
  probe: HarnessProbeResponse | undefined,
  ref: HarnessModelRef,
): HarnessProbeResponse['models'][number]['readiness'] | undefined {
  const ids = [`${ref.runner}/${ref.model || 'auto'}`]
  if (ref.runner === 'claude' && !ref.model) ids.push('claude')
  return probe?.models.find((model) => ids.includes(model.id))?.readiness
}

/**
 * Why the Start button must hold, from the profile's probe — or null to allow.
 * Loading, errors, and missing evidence all block. The server repeats the exact
 * probe before creating a worktree; this client gate keeps the start surface
 * truthful while that fail-closed check is pending.
 */
export function harnessStartBlock(
  probe: HarnessProbeResponse | undefined,
  pending = false,
  failed = false,
): string | null {
  if (pending) return 'Checking every selected model binding…'
  if (failed) return 'Model readiness could not be verified.'
  if (!probe) return 'Model readiness has not been verified yet.'
  if (probe.ready) return null
  return probe.reason ?? `profile "${probe.profile}" is not ready`
}

