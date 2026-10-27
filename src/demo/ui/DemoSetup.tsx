import { useEffect, useMemo, useRef, useState } from "react";
import { buildCategoryName, GUP_GRADE_OPTIONS } from "@/lib/category-name";
import { availableCategoryFormats, defaultCategoryFormat } from "@/lib/category-mode";
import { generateDoubleBracket, generateEliminationBracket, generateGroupsTournament, getGroupDistribution } from "@/lib/bracket";
import { AGE_DIVISIONS, ageDivisionForRange, validateDanRange, yusanConfigPatch } from "@/lib/yusan-profile";
import { ageSelectionFromPreset } from "@/lib/category-age";
import { COPA_DANES_26, getPresetForCategoryFormat } from "@/lib/tournament-presets";
import baseline from "@/rules/rules/rules_sparring_itf_baseline.json";
import type { RuleSetSparring } from "@/engine/types";
import type { CompetitorEntry, TournamentConfig } from "@/store/tournament";
import type { DemoDeskCommand, DemoDeskState } from "../runtime/types";
import { parseDemoSpreadsheet, type DemoImportedCategory } from "./DemoSpreadsheet";
import { DemoCategoryTools } from "./DemoCategoryTools";

const BASE = baseline as RuleSetSparring;
const WEIGHTS = ["Liviano A", "Liviano B", "Mediano A", "Mediano B", "Pesado A", "Pesado B", "Pesado C"];
const SEXES = ["Masculino", "Femenino", "Mixto"] as const;
type Step = "age" | "grade" | "range" | "gender" | "discipline" | "weight" | "format";
const STEP_LABEL: Record<Step, string> = {
  age: "Edad", grade: "Sistema de grado", range: "Rango de grado", gender: "Género",
  discipline: "Disciplina", weight: "Peso", format: "Formato",
};
const surface = "rounded-2xl border border-slate-700 bg-slate-900 p-4 sm:p-5";
const control = "min-h-11 rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-base text-slate-50 hover:border-cyan-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 disabled:cursor-not-allowed disabled:opacity-50";
const selectedControl = "border-cyan-300 bg-cyan-950 font-semibold";
const input = "min-h-11 w-full rounded-lg border border-slate-600 bg-slate-950 px-3 py-2 text-base text-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300";
const weightStash = new Map<string, string>();

function steps(config: TournamentConfig): Step[] {
  return ["age", "grade", ...(config.gradeSystem ? ["range" as const] : []), "gender", "discipline",
    ...(config.matchType === "tul" ? [] : ["weight" as const]), "format"];
}

function initialStep(config: TournamentConfig, phase: string): Step | null {
  return phase === "setup" && !config.categoryName.trim() ? "age" : null;
}

function readProgress(config: TournamentConfig, phase: string): { active: Step | null; completed: Step[] } {
  const applicable = steps(config);
  if (phase !== "setup") return { active: null, completed: applicable };
  try {
    const raw = sessionStorage.getItem(`tkd-demo-guided-v1:${config.id}`);
    if (raw) {
      const value: unknown = JSON.parse(raw);
      if (value && typeof value === "object" && "active" in value && "completed" in value) {
        const progress = value as { active: unknown; completed: unknown };
        if ((progress.active === null || applicable.includes(progress.active as Step)) && Array.isArray(progress.completed)) {
          return { active: progress.active as Step | null,
            completed: progress.completed.filter((step): step is Step => applicable.includes(step as Step)) };
        }
      }
    }
  } catch { /* Session UI state is optional; canonical category data stays in IndexedDB. */ }
  const active = initialStep(config, phase);
  return { active, completed: active ? [] : applicable };
}

function writeProgress(categoryId: string, active: Step | null, completed: Step[]): void {
  try { sessionStorage.setItem(`tkd-demo-guided-v1:${categoryId}`, JSON.stringify({ active, completed })); }
  catch { /* Safari private browsing may deny session storage. */ }
}

function categoryName(config: TournamentConfig): string {
  return buildCategoryName({
    weight: config.matchType === "tul" ? "" : config.weightLabel ?? "",
    gradeSystem: config.gradeSystem ?? "",
    beltFrom: config.danFrom?.toString() ?? "", beltTo: config.danTo?.toString() ?? "",
    gupBand: config.gupBand ?? "", gender: config.sexDivision ?? "",
    ageFrom: config.categoryAgeFrom ?? "", ageTo: config.categoryAgeTo ?? "",
    ageOpenEnded: config.categoryAgeOpenEnded,
  });
}

function selectedRules(config: TournamentConfig): RuleSetSparring {
  const rules = config.ruleSet?.mode === "sparring" ? config.ruleSet : BASE;
  return { ...rules, judgesCount: config.judgesCount ?? rules.judgesCount };
}

const fixedWeight = /\b(?:peso\s+)?(?:liviano|mediano|pesado)\s+[abc]\b/gi;
const measuredWeight = /\b(?:peso\s+(?:de\s+)?)?(?:(?:hasta|menos\s+de|m[aá]s\s+de)\s+)?[+-]?\d+(?:[.,]\d+)?\s*(?:kg|kilos?|kilogramos?)\b/gi;
const namedWeight = /\bpeso\s+(?:libre|abierto|sin\s+l[ií]mite)\b/gi;

function withoutWeight(name: string): string {
  const knownRemoved = name.replace(fixedWeight, "").replace(measuredWeight, "").replace(namedWeight, "");
  // Preserve an imported/manual caption even if the weight vocabulary is unfamiliar.
  // Unknown "Peso ..." phrases are removed only through the next explicit title separator.
  const unknownRemoved = knownRemoved.replace(/\bpeso\b[^·|;,–—]*?(?=\s+-\s+|[·|;,–—]|$)/gi, "");
  return unknownRemoved.replace(/(?:\s*[·|;,]\s*|\s+[-–—]\s+){2,}/g, " · ")
    .replace(/^[\s·|;,–—-]+|[\s·|;,–—-]+$/g, "").replace(/\s{2,}/g, " ").trim();
}

function hasWeightMention(name: string): boolean {
  return /\bpeso\b/i.test(name) || /\b(?:liviano|mediano|pesado)\s+[abc]\b/i.test(name)
    || /\b\d+(?:[.,]\d+)?\s*(?:kg|kilos?|kilogramos?)\b/i.test(name);
}

function summary(step: Step, config: TournamentConfig): string {
  if (step === "age") {
    if (config.ageDivision) {
      const value = AGE_DIVISIONS.find((item) => item.id === config.ageDivision);
      if (value) return `${value.label} (${value.from}${value.to === undefined ? "+" : `-${value.to}`})`;
    }
    if (config.categoryAgeFrom) return `${config.categoryAgeFrom}-${config.categoryAgeTo || "?"} años`;
  }
  if (step === "grade") return config.gradeSystem === "DAN" ? "DANES" : config.gradeSystem ?? "No especificar";
  if (step === "range") return config.gradeSystem === "DAN"
    ? config.danFrom && config.danTo ? `${config.danFrom}-${config.danTo} Dan` : "No especificar"
    : config.gupBand ?? "No especificar";
  if (step === "gender") return config.sexDivision ?? "No especificar";
  if (step === "discipline") return config.matchType === "tul" ? "Tul / Formas" : "Lucha";
  if (step === "weight") return config.weightLabel ?? "No especificar";
  if (step === "format") return config.mode === "round-robin" ? "Round Robin" : "Eliminación";
  return "No especificar";
}

function Choice({ label, selected, disabled, onClick }: Readonly<{
  label: string; selected: boolean; disabled?: boolean; onClick: () => void;
}>) {
  return <button type="button" disabled={disabled} aria-pressed={selected} onClick={onClick}
    className={`${control} ${selected ? selectedControl : ""}`}>{label}</button>;
}

const PENDING_DRAFT_PREFIX = "tkd-demo-pending-v1:";
interface PendingDraft { value: string; base: string; sent: string[]; token: string }

/** Called only after a confirmed reset/import generation change, including while Setup is unmounted. */
export function purgeDemoPendingDrafts(keepGeneration?: number): void {
  try {
    for (let index = sessionStorage.length - 1; index >= 0; index--) {
      const key = sessionStorage.key(index);
      if (key?.startsWith(PENDING_DRAFT_PREFIX)
        && (keepGeneration === undefined || !key.startsWith(`${PENDING_DRAFT_PREFIX}${keepGeneration}:`)))
        sessionStorage.removeItem(key);
    }
  } catch { /* Browser privacy settings may make session storage unavailable. */ }
}

/** Session-only write-ahead hint, not the canonical tournament state. */
function readPendingDraft(identity: string, external: string): { draft: PendingDraft | null; conflict: boolean } {
  try {
    const raw = sessionStorage.getItem(`${PENDING_DRAFT_PREFIX}${identity}`);
    if (!raw) return { draft: null, conflict: false };
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") throw new Error("Invalid pending draft");
    const record = value as Record<string, unknown>;
    if (typeof record.value !== "string" || typeof record.base !== "string"
      || typeof record.token !== "string" || record.value.length > 10_000
      || !Array.isArray(record.sent) || record.sent.length > 500
      || !record.sent.every((item) => typeof item === "string" && item.length <= 10_000))
      throw new Error("Invalid pending draft");
    const draft = record as unknown as PendingDraft;
    if (draft.value === external) {
      sessionStorage.removeItem(`${PENDING_DRAFT_PREFIX}${identity}`);
      return { draft: null, conflict: false };
    }
    if (external === draft.base || draft.sent.includes(external)) return { draft, conflict: false };
    // Another writer changed this field: never overwrite its newer value with a stale tab draft.
    sessionStorage.removeItem(`${PENDING_DRAFT_PREFIX}${identity}`);
    return { draft: null, conflict: true };
  } catch {
    try { sessionStorage.removeItem(`${PENDING_DRAFT_PREFIX}${identity}`); } catch { /* unavailable */ }
    return { draft: null, conflict: false };
  }
}

function writePendingDraft(identity: string, draft: PendingDraft): boolean {
  try { sessionStorage.setItem(`${PENDING_DRAFT_PREFIX}${identity}`, JSON.stringify(draft)); return true; }
  catch { return false; }
}

function clearPendingDraft(identity: string, token?: string): void {
  try {
    if (token) {
      const raw = sessionStorage.getItem(`${PENDING_DRAFT_PREFIX}${identity}`);
      if (!raw || (JSON.parse(raw) as { token?: string }).token !== token) return;
    }
    sessionStorage.removeItem(`${PENDING_DRAFT_PREFIX}${identity}`);
  } catch { /* Session storage can be disabled; IndexedDB remains canonical. */ }
}

/** Local control + generation-scoped session journal bridge asynchronous IndexedDB navigation races. */
function useBufferedInput(identity: string, externalValue: string, enabled: boolean,
  save: (value: string) => Promise<boolean>, validate: (value: string) => string | null = () => null) {
  const initial = useRef<{ identity: string; draft: PendingDraft | null; conflict: boolean } | null>(null);
  if (!initial.current || initial.current.identity !== identity)
    initial.current = { identity, ...(enabled ? readPendingDraft(identity, externalValue)
      : { draft: null, conflict: false }) };
  const [draft, setDraft] = useState({ identity, value: initial.current.draft?.value ?? externalValue });
  const [error, setError] = useState(initial.current.conflict
    ? "Se descartó un cambio pendiente porque esta categoría cambió en otra pestaña." : "");
  const current = useRef({ identity, value: initial.current.draft?.value ?? externalValue,
    saved: externalValue, queued: externalValue, base: initial.current.draft?.base ?? externalValue,
    sent: initial.current.draft?.sent ?? [] as string[], token: initial.current.draft?.token ?? "",
    dirty: Boolean(initial.current.draft), needsReplay: Boolean(initial.current.draft), enabled,
    inFlight: null as Promise<boolean> | null, save, validate });
  if (current.current.identity === identity) { current.current.save = save; current.current.validate = validate; }

  const flush = (): Promise<boolean> => {
    const field = current.current;
    if (!field.enabled) return Promise.resolve(false);
    if (!field.dirty || field.value === field.queued) return field.inFlight ?? Promise.resolve(true);
    if (field.validate(field.value)) return Promise.resolve(false);
    const submitted = field.value;
    const submittedIdentity = field.identity;
    const submittedToken = field.token;
    field.queued = submitted;
    field.sent = [...field.sent, submitted].slice(-500);
    const saving = field.save(submitted).then((ok) => {
      if (current.current.identity !== submittedIdentity) return ok;
      if (ok && current.current.token === submittedToken) clearPendingDraft(submittedIdentity, submittedToken);
      if (!ok && current.current.queued === submitted) {
        current.current.queued = current.current.saved;
        setError("No se pudo guardar este campo. Volvé a intentarlo.");
      }
      return ok;
    }, () => {
      if (current.current.identity === submittedIdentity && current.current.queued === submitted) {
        current.current.queued = current.current.saved;
        setError("No se pudo guardar este campo. Volvé a intentarlo.");
      }
      return false;
    }).finally(() => {
      if (current.current.identity === submittedIdentity && current.current.inFlight === saving)
        current.current.inFlight = null;
    });
    field.inFlight = saving;
    return saving;
  };
  const flushRef = useRef(flush);
  flushRef.current = flush;

  useEffect(() => {
    const field = current.current;
    if (field.identity !== identity) {
      const recovered = enabled ? readPendingDraft(identity, externalValue) : { draft: null, conflict: false };
      current.current = { identity, value: recovered.draft?.value ?? externalValue,
        saved: externalValue, queued: externalValue, base: recovered.draft?.base ?? externalValue,
        sent: recovered.draft?.sent ?? [], token: recovered.draft?.token ?? "",
        dirty: Boolean(recovered.draft), needsReplay: Boolean(recovered.draft), enabled,
        inFlight: null, save, validate };
      setDraft({ identity, value: current.current.value });
      setError(recovered.conflict ? "Se descartó un cambio pendiente porque esta categoría cambió en otra pestaña." : "");
      return;
    }
    if (!enabled) {
      field.enabled = false;
      field.dirty = false;
      field.value = externalValue;
      // A read-only tab must not replay its abandoned draft after another tab takes over.
      clearPendingDraft(identity);
      setDraft((previous) => previous.identity === identity && previous.value === externalValue
        ? previous : { identity, value: externalValue });
      return;
    }
    if (!field.enabled) {
      field.enabled = true;
      const recovered = readPendingDraft(identity, externalValue);
      if (recovered.draft) {
        field.value = recovered.draft.value; field.base = recovered.draft.base;
        field.sent = recovered.draft.sent; field.token = recovered.draft.token;
        field.dirty = true; field.queued = externalValue; field.needsReplay = true;
        setDraft({ identity, value: field.value });
      } else if (recovered.conflict) setError("Se descartó un cambio pendiente porque esta categoría cambió en otra pestaña.");
    }
    field.saved = externalValue;
    if (!field.dirty || field.value === externalValue) {
      field.dirty = false; field.queued = externalValue; field.value = externalValue;
      setDraft((previous) => previous.identity === identity && previous.value === externalValue
        ? previous : { identity, value: externalValue });
    }
  }, [identity, externalValue, enabled, save, validate]);

  useEffect(() => {
    const field = current.current;
    if (enabled && field.identity === identity && field.needsReplay) {
      field.needsReplay = false;
      void flushRef.current();
    }
  }, [identity, enabled]);

  const change = (value: string) => {
    const field = current.current;
    if (!field.dirty) { field.base = field.saved; field.sent = []; }
    field.value = value; field.dirty = true;
    setDraft({ identity: field.identity, value });
    setError("");
    if (!field.validate(value)) {
      field.token = crypto.randomUUID();
      if (!writePendingDraft(field.identity, { value, base: field.base, sent: field.sent, token: field.token }))
        setError("El navegador no pudo conservar este cambio pendiente; exportá un respaldo.");
      void flushRef.current();
    } else clearPendingDraft(field.identity);
  };
  const blur = () => {
    const field = current.current;
    const invalid = field.validate(field.value);
    if (invalid) {
      field.value = field.saved; field.queued = field.saved; field.dirty = false;
      clearPendingDraft(field.identity);
      setDraft({ identity: field.identity, value: field.saved });
      setError(invalid);
    } else void flush();
  };
  return { value: draft.identity === identity ? draft.value : externalValue, change, blur, flush, error };
}

type Dispatch = (command: DemoDeskCommand) => Promise<unknown>;
type ConfigUpdate = Partial<TournamentConfig> | ((current: TournamentConfig) => Partial<TournamentConfig>);
export interface DemoSetupProps {
  state: DemoDeskState;
  generation: number;
  readOnly: boolean;
  dispatch: Dispatch;
  onFight: () => void;
}

export function DemoSetup({ state, generation, readOnly, dispatch, onFight }: Readonly<DemoSetupProps>) {
  const categoryId = state.selectedCategoryId;
  const category = categoryId ? state.categories[categoryId] : undefined;
  const config = category?.config;
  const [active, setActive] = useState<Step | null>(null);
  const [completed, setCompleted] = useState<Step[]>([]);
  const [editorOpen, setEditorOpen] = useState(true);
  const [ageCustom, setAgeCustom] = useState(false);
  const [ageFrom, setAgeFrom] = useState("");
  const [ageTo, setAgeTo] = useState("");
  const [danFrom, setDanFrom] = useState("");
  const [danTo, setDanTo] = useState("");
  const [fieldError, setFieldError] = useState("");
  const [name, setName] = useState("");
  const [team, setTeam] = useState("");
  const [editId, setEditId] = useState<string | null>(null);
  const [importPreview, setImportPreview] = useState<Array<{ name: string; team: string }> | null>(null);
  const [importCategories, setImportCategories] = useState<DemoImportedCategory[]>([]);
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState("");
  const headingRef = useRef<HTMLHeadingElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const focusHeading = useRef(false);
  const initializedCategory = useRef<string | null>(null);
  const workingConfig = useRef<{ categoryId: string; value: TournamentConfig } | null>(null);
  if (config && categoryId && workingConfig.current?.categoryId !== categoryId)
    workingConfig.current = { categoryId, value: config };

  const patch = async (update: ConfigUpdate): Promise<boolean> => {
    if (!config || !categoryId) return false;
    const base = workingConfig.current?.categoryId === categoryId ? workingConfig.current.value : config;
    const changes = typeof update === "function" ? update(base) : update;
    const next = { ...base, ...changes };
    const profilePatch = base.profileId === "yusan-2026" && base.profileApplied && changes.profileApplied !== false
      ? yusanConfigPatch(next, next, next.mode, { ...BASE, judgesCount: next.judgesCount }) : null;
    const auto = changes.categoryName === undefined && (!base.categoryName.trim() || base.nameGenerated === true);
    const merged = { ...changes, ...profilePatch };
    const finalPatch = auto ? { ...merged, categoryName: categoryName({ ...next, ...profilePatch }), nameGenerated: true } : merged;
    const optimistic = { ...base, ...finalPatch };
    workingConfig.current = { categoryId, value: optimistic };
    const saved = Boolean(await dispatch({ type: "category/configure", categoryId, patch: finalPatch }));
    if (!saved && workingConfig.current?.categoryId === categoryId && workingConfig.current.value === optimistic)
      workingConfig.current = { categoryId, value: config };
    return saved;
  };
  const journalIdentity = `${generation}:${state.eventId}:${categoryId ?? ""}`;
  const editable = !readOnly && category?.phase === "setup";
  const categoryNameField = useBufferedInput(`${journalIdentity}:categoryName`, config?.categoryName ?? "", editable,
    (value) => patch({ categoryName: value, nameGenerated: false }));
  const tableChiefField = useBufferedInput(`${journalIdentity}:tableChief`, config?.tableChief ?? "", editable,
    (value) => patch({ tableChief: value }));

  useEffect(() => {
    if (!category || !config || !categoryId || initializedCategory.current === categoryId) return;
    initializedCategory.current = categoryId;
    const progress = readProgress(config, category.phase);
    setActive(progress.active);
    setCompleted(progress.completed);
    setEditorOpen(!!progress.active);
    setFieldError("");
    setImportPreview(null);
    setImportCategories([]);
  }, [categoryId, category, config]); // Autosaves do not restart a guided editor.

  // biome-ignore lint/correctness/useExhaustiveDependencies: focus is intentionally scheduled when the active answer changes.
  useEffect(() => {
    if (!focusHeading.current) return;
    focusHeading.current = false;
    headingRef.current?.focus({ preventScroll: true });
    headingRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [active]);

  const preview = useMemo(() => {
    if (!category || !config) return [];
    if (category.phase !== "setup") return category.fights.map((fight) => ({
      id: fight.id, red: fight.red.name, blue: fight.blue.name, group: fight.groupId,
      completed: fight.completed,
    }));
    if (config.mode === "round-robin") {
      if (category.competitors.length < 3 || category.competitors.length > 12) return [];
      return generateGroupsTournament(category.competitors, "SERPENTINE", config.rrOrderMode ?? "rest-optimized")
        .fights.map((fight) => ({ id: fight.id, red: fight.red.name, blue: fight.blue.name, group: fight.groupId, completed: false }));
    }
    if (category.competitors.length < 2) return [];
    const fixture = category.competitors.length > 16
      ? generateDoubleBracket(category.competitors) : generateEliminationBracket(category.competitors);
    return fixture.matches
      .filter((match) => match.round > 0 || Boolean(match.red.competitor && match.blue.competitor))
      .map((match) => ({ id: match.id, red: match.red.competitor?.name ?? "Por definir",
        blue: match.blue.competitor?.name ?? "Por definir",
        group: `${match.bracketGroup ? `Grilla ${match.bracketGroup} · ` : ""}Ronda ${match.round + 1}`,
        completed: match.completed }));
  }, [category, config]);

  if (!category || !config || !categoryId) return <section className={surface}>
    <h2 className="text-xl font-bold">Categorías</h2>
    <p className="mt-2 text-slate-300">Creá una categoría para comenzar una prueba individual.</p>
    <button type="button" disabled={readOnly} className={`${control} mt-4 border-cyan-400 font-bold`}
      onClick={() => void dispatch({ type: "category/create" })}>Crear categoría</button>
  </section>;

  const flow = steps(config);
  const currentStep = active;
  const generated = categoryName(config);
  const staleWeight = config.matchType === "tul" && !config.nameGenerated && hasWeightMention(categoryNameField.value);
  const nameWithoutWeight = staleWeight ? withoutWeight(categoryNameField.value) : "";
  const ruleSet = selectedRules(config);
  const choose = async (step: Step, changes: Partial<TournamentConfig>, nextGrade = config.gradeSystem,
    nextDiscipline = config.matchType) => {
    if (!await patch(changes)) return;
    const done = new Set(completed);
    done.add(step);
    if (step === "grade") done.delete("range");
    const nextFlow = steps({ ...config, ...changes, gradeSystem: nextGrade, matchType: nextDiscipline });
    const nextActive = nextFlow.find((item) => !done.has(item)) ?? null;
    const nextCompleted = [...done];
    setCompleted(nextCompleted);
    setActive(nextActive);
    writeProgress(categoryId, nextActive, nextCompleted);
    setFieldError("");
    focusHeading.current = true;
  };
  const edit = (step: Step) => {
    setEditorOpen(true); setActive(step); writeProgress(categoryId, step, completed);
    setFieldError(""); focusHeading.current = true;
  };
  const start = async () => {
    if (!await categoryNameField.flush() || !await tableChiefField.flush()) return;
    if (await dispatch({ type: "category/start", categoryId })) onFight();
  };
  const saveCompetitor = async () => {
    const trimmed = name.trim();
    if (!trimmed) { setFieldError("Ingresá el nombre del competidor."); return; }
    const saved = editId ? await dispatch({ type: "category/updateCompetitor", categoryId, competitorId: editId,
      patch: { name: trimmed, team: team.trim() } })
      : await dispatch({ type: "category/addCompetitor", categoryId, competitor: { name: trimmed, team: team.trim() } });
    if (!saved) return;
    setName(""); setTeam(""); setEditId(null); setFieldError(""); nameRef.current?.focus();
  };
  const importSpreadsheet = async (file: File) => {
    setImportError(""); setImportCategories([]);
    try {
      const parsed = await parseDemoSpreadsheet(file);
      setImportPreview(parsed.simpleCompetitors.length ? parsed.simpleCompetitors : null);
      setImportCategories(parsed.categories);
    } catch (error) { setImportError(error instanceof Error ? error.message : "No se pudo leer la planilla."); }
  };
  const importCategory = async (entry: DemoImportedCategory) => {
    setImportBusy(true);
    const newId = crypto.randomUUID();
    try {
      if (!await categoryNameField.flush() || !await tableChiefField.flush()) return;
      if (!await dispatch({ type: "category/create", categoryId: newId })) return;
      if (!await dispatch({ type: "category/configure", categoryId: newId, patch: {
        categoryName: entry.name, nameGenerated: false, matchType: entry.matchType,
        mode: defaultCategoryFormat(entry.matchType), weightLabel: undefined,
      } })) return;
      for (const name of entry.competitors) {
        if (!await dispatch({ type: "category/addCompetitor", categoryId: newId, competitor: { name } })) return;
      }
      setImportCategories([]);
    } finally { setImportBusy(false); }
  };

  return <div className="space-y-4">
    <section className={surface} aria-label="Categorías de la demo">
      <div className="flex flex-wrap items-end gap-3">
        <label className="min-w-56 flex-1 text-sm font-semibold text-slate-200">Categoría actual
          <select className={`${input} mt-1`} value={categoryId} disabled={readOnly}
            onChange={(event) => { const nextId = event.target.value; void (async () => {
              if (!await categoryNameField.flush() || !await tableChiefField.flush()) return;
              await dispatch({ type: "category/select", categoryId: nextId });
            })(); }}>
            {state.categoryOrder.map((id, index) => <option key={id} value={id}>
              {state.categories[id]?.config.categoryName || `Categoría ${index + 1}`}
            </option>)}
          </select>
        </label>
        <button type="button" disabled={readOnly} className={control}
          onClick={() => void (async () => {
            if (!await categoryNameField.flush() || !await tableChiefField.flush()) return;
            await dispatch({ type: "category/create" });
          })()}>+ Nueva categoría</button>
      </div>
    </section>

    <section className={surface} aria-label="Editor de categoría">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div><h2 className="text-xl font-bold">Categoría</h2><p className="text-sm text-slate-300">Las respuestas se guardan automáticamente en este navegador.</p></div>
        <button type="button" className={control} onClick={() => setEditorOpen(!editorOpen)}
          aria-expanded={editorOpen}>{editorOpen ? "Ocultar editor" : "Editar categoría"}</button>
      </div>
      {editorOpen && <div className="mt-4 space-y-4">
        <fieldset className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3"><legend className="sr-only">Respuestas de la categoría</legend>
          {flow.filter((step) => completed.includes(step) && active !== step).map((step) =>
            <button key={step} type="button" disabled={readOnly || category.phase !== "setup"}
              onClick={() => edit(step)} aria-label={`Editar ${STEP_LABEL[step]}: ${summary(step, config)}`}
              className={`${control} flex min-h-16 flex-col items-start text-left`}>
              <span className="text-sm text-slate-300">{STEP_LABEL[step]} · Editar</span><span className="font-semibold">{summary(step, config)}</span>
            </button>)}
        </fieldset>
        {currentStep && category.phase === "setup" && <div className="rounded-xl border border-slate-600 bg-slate-950 p-4">
          <h3 ref={headingRef} tabIndex={-1} className="text-lg font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300">
            Paso {flow.indexOf(currentStep) + 1} de {flow.length}: {currentStep === "range" && config.gradeSystem === "DAN" ? "Grado Dan" : STEP_LABEL[currentStep]}
          </h3>
          <p className="mt-1 text-sm text-slate-300">Elegí una opción para avanzar; podés volver y cambiarla.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {currentStep === "age" && <>
              {AGE_DIVISIONS.map((age) => <Choice key={age.id} disabled={readOnly}
                label={`${age.label} (${age.from}${age.to === undefined ? "+" : `-${age.to}`})`}
                selected={config.ageDivision === age.id} onClick={() => void choose("age", {
                  ageDivision: age.id, categoryAgeFrom: String(age.from), categoryAgeTo: age.to?.toString(),
                  categoryAgeOpenEnded: age.to === undefined,
                })} />)}
              <button type="button" className={control} disabled={readOnly} onClick={() => setAgeCustom(!ageCustom)}>Edad personalizada</button>
              {ageCustom && <div className="flex w-full flex-wrap items-end gap-2">
                <label className="flex-1 text-sm">Desde<input type="number" min="1" className={`${input} mt-1`} value={ageFrom}
                  onChange={(event) => setAgeFrom(event.target.value)} /></label>
                <label className="flex-1 text-sm">Hasta<input type="number" min="1" className={`${input} mt-1`} value={ageTo}
                  onChange={(event) => setAgeTo(event.target.value)} /></label>
                <button type="button" className={control} disabled={readOnly} onClick={() => {
                  const from = Number(ageFrom); const to = Number(ageTo);
                  if (!/^\d+$/.test(ageFrom) || !/^\d+$/.test(ageTo) || from < 1 || from > to) {
                    setFieldError("Ingresá dos edades válidas; la inicial no puede superar la final."); return;
                  }
                  void choose("age", { ageDivision: ageDivisionForRange(ageFrom, ageTo, false),
                    categoryAgeFrom: ageFrom, categoryAgeTo: ageTo, categoryAgeOpenEnded: false });
                }}>Aplicar edad</button>
              </div>}
              <Choice disabled={readOnly} label="No especificar" selected={!config.categoryAgeFrom}
                onClick={() => void choose("age", { ageDivision: undefined, categoryAgeFrom: undefined,
                  categoryAgeTo: undefined, categoryAgeOpenEnded: false })} />
            </>}
            {currentStep === "grade" && <>
              <Choice disabled={readOnly} label="GUPS" selected={config.gradeSystem === "GUPS"}
                onClick={() => void choose("grade", { gradeSystem: "GUPS", gupBand: undefined, danFrom: undefined, danTo: undefined }, "GUPS")} />
              <Choice disabled={readOnly} label="DANES" selected={config.gradeSystem === "DAN"}
                onClick={() => void choose("grade", { gradeSystem: "DAN", gupBand: undefined, danFrom: undefined, danTo: undefined }, "DAN")} />
              <Choice disabled={readOnly} label="No especificar" selected={!config.gradeSystem}
                onClick={() => void choose("grade", { gradeSystem: undefined, gupBand: undefined,
                  danFrom: undefined, danTo: undefined, requiresGradeSelection: false }, undefined)} />
            </>}
            {currentStep === "range" && config.gradeSystem === "GUPS" && <>
              {GUP_GRADE_OPTIONS.map((value) => <Choice key={value} disabled={readOnly} label={value}
                selected={config.gupBand === value} onClick={() => void choose("range", { gupBand: value })} />)}
            </>}
            {currentStep === "range" && config.gradeSystem === "DAN" && <div className="flex w-full flex-wrap items-end gap-2">
              <label className="flex-1 text-sm">Dan desde<input type="number" min="1" className={`${input} mt-1`}
                value={danFrom} onChange={(event) => setDanFrom(event.target.value)} /></label>
              <label className="flex-1 text-sm">Dan hasta<input type="number" min="1" className={`${input} mt-1`}
                value={danTo} onChange={(event) => setDanTo(event.target.value)} /></label>
              <button type="button" className={control} disabled={readOnly} onClick={() => {
                const error = validateDanRange(danFrom, danTo);
                if (error) { setFieldError(error); return; }
                void choose("range", { danFrom: Number(danFrom), danTo: Number(danTo) });
              }}>Aplicar grados</button>
            </div>}
            {currentStep === "gender" && <>
              {SEXES.map((value) => <Choice key={value} disabled={readOnly} label={value}
                selected={config.sexDivision === value} onClick={() => void choose("gender", { sexDivision: value })} />)}
              <Choice disabled={readOnly} label="No especificar" selected={!config.sexDivision}
                onClick={() => void choose("gender", { sexDivision: undefined })} />
            </>}
            {currentStep === "discipline" && <>
              {(["sparring", "tul"] as const).map((value) => <Choice key={value} disabled={readOnly}
                label={value === "tul" ? "Tul / Formas" : "Lucha"} selected={config.matchType === value}
                onClick={() => {
                  if (value === "tul" && config.weightLabel) weightStash.set(categoryId, config.weightLabel);
                  const restored = value === "sparring" ? weightStash.get(categoryId) : undefined;
                  void choose("discipline", { matchType: value, mode: defaultCategoryFormat(value),
                    weightLabel: value === "tul" ? undefined : restored ?? config.weightLabel }, config.gradeSystem, value);
                }} />)}
            </>}
            {currentStep === "weight" && <>
              {WEIGHTS.map((value) => <Choice key={value} disabled={readOnly} label={value}
                selected={config.weightLabel === value} onClick={() => void choose("weight", { weightLabel: value })} />)}
              <Choice disabled={readOnly} label="No especificar" selected={!config.weightLabel}
                onClick={() => void choose("weight", { weightLabel: undefined })} />
            </>}
            {currentStep === "format" && availableCategoryFormats(config.matchType).map((value) =>
              <Choice key={value} disabled={readOnly} label={value === "round-robin" ? "Round Robin" : "Eliminación"}
                selected={config.mode === value} onClick={() => {
                  const rules = config.ruleSet?.mode === "sparring" ? config.ruleSet : BASE;
                  const adjusted = value === "round-robin" ? { ...rules, rounds: { ...rules.rounds, count: 1, duration_seconds: 60 } } : rules;
                  void choose("format", { mode: value, ruleSet: adjusted });
                }} />)}
          </div>
          {fieldError && <p role="alert" className="mt-2 text-amber-200">{fieldError}</p>}
        </div>}
        {!currentStep && <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-3 rounded-xl border border-slate-700 p-4">
            <h3 className="font-bold">Combate y tiempos</h3>
            <p className="text-slate-200">{ruleSet.judgesCount} jueces · {ruleSet.rounds.count} round(s) × {ruleSet.rounds.duration_seconds} s · Desempate {config.tiebreakerSeconds ?? 30} s · Perfil: {config.profileId === "yusan-2026" && config.profileApplied ? "Yusan 2026" : "Personalizado"}</p>
            {config.mode === "round-robin" && (getGroupDistribution(category.competitors.length)?.length ?? 0) > 1 && <fieldset className="space-y-2">
              <legend className="font-semibold">Orden de combates</legend>
              <div className="flex flex-wrap gap-2">
                <Choice disabled={readOnly || category.phase !== "setup"} label="Optimizar descanso (un tatami)"
                  selected={config.rrOrderMode !== "group-blocks"} onClick={() => void patch({ rrOrderMode: "rest-optimized" })} />
                <Choice disabled={readOnly || category.phase !== "setup"} label="Grupos juntos (varios tatamis)"
                  selected={config.rrOrderMode === "group-blocks"} onClick={() => void patch({ rrOrderMode: "group-blocks" })} />
              </div>
            </fieldset>}
            <details><summary className={`${control} cursor-pointer`}>Ajustes avanzados: tiempos y perfil</summary>
              <div className="mt-3 space-y-3">
                <button type="button" disabled={readOnly || category.phase !== "setup"} className={control}
                  onClick={() => {
                    const change = yusanConfigPatch(config, config, config.mode, { ...BASE, judgesCount: config.judgesCount });
                    if (!change) { setFieldError("Para aplicar Yusan 2026, elegí una edad y un rango GUP/DAN válidos."); return; }
                    void patch(change);
                  }}>Aplicar perfil Yusan 2026</button>
                <fieldset className="space-y-2"><legend className="font-semibold">Preset de tiempo</legend>
                  <div className="flex flex-wrap gap-2">{COPA_DANES_26.map((preset) => <button key={preset.name} type="button"
                    disabled={readOnly || category.phase !== "setup"} className={control} onClick={() => {
                      const selected = getPresetForCategoryFormat(preset, config.mode === "round-robin" ? "round-robin" : "elimination");
                      const age = ageSelectionFromPreset(preset);
                      const agePatch: Partial<TournamentConfig> = age ? {
                        ageDivision: ageDivisionForRange(age.ageFrom, age.ageTo, age.ageOpenEnded),
                        categoryAgeFrom: age.ageFrom, categoryAgeTo: age.ageTo || undefined,
                        categoryAgeOpenEnded: age.ageOpenEnded,
                      } : {};
                      const finalPatch: Partial<TournamentConfig> = config.mode === "round-robin" ? {} : {
                        finalRounds: preset.finalRounds, finalSeconds: preset.finalSeconds,
                        tiebreakerSeconds: preset.tiebreakerSeconds, maxTiebreakers: preset.maxTiebreakers,
                      };
                      void patch({ ...agePatch, ruleSet: { ...ruleSet, rounds: { ...ruleSet.rounds,
                        count: selected.roundCount, duration_seconds: selected.durationSeconds } },
                        ...finalPatch, profileApplied: false });
                    }}>{preset.name}</button>)}</div>
                </fieldset>
                <TimingFields config={config} journalIdentity={journalIdentity}
                  disabled={readOnly || category.phase !== "setup"} patch={patch} />
              </div>
            </details>
          </div>
          <details className="rounded-xl border border-slate-700 p-4"><summary className="min-h-11 cursor-pointer font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300">Mesa (opcional)</summary>
            <label className="mt-3 block text-sm">Jefe de mesa<input className={`${input} mt-1`} disabled={readOnly || category.phase !== "setup"}
              value={tableChiefField.value} onChange={(event) => tableChiefField.change(event.target.value)}
              onBlur={tableChiefField.blur} /></label>
            {tableChiefField.error && <p role="alert" className="mt-2 text-amber-200">{tableChiefField.error}</p>}
          </details>
        </div>}
        {!currentStep && <div className="space-y-2">
          <label className="block text-sm font-semibold">Nombre de la categoría<input className={`${input} mt-1`} disabled={readOnly || category.phase !== "setup"}
            value={categoryNameField.value} onChange={(event) => categoryNameField.change(event.target.value)}
            onBlur={categoryNameField.blur} /></label>
          {categoryNameField.error && <p role="alert" className="text-amber-200">{categoryNameField.error}</p>}
          {staleWeight && <div role="status" className="text-amber-200">
            <p>El nombre manual menciona un peso, pero Tul no utiliza peso.</p>
            {nameWithoutWeight ? <button type="button" disabled={readOnly || category.phase !== "setup"}
              className={`${control} mt-2`} onClick={() => void patch({ categoryName: nameWithoutWeight, nameGenerated: false })}>
              Quitar peso del nombre</button>
              : <p>Editá el nombre manualmente para no dejarlo vacío.</p>}
          </div>}
          {!config.nameGenerated && generated && <button type="button" disabled={readOnly || category.phase !== "setup"}
            className={control} onClick={() => void patch({ categoryName: generated, nameGenerated: true })}>
              Actualizar nombre con los datos seleccionados</button>}
          <div><button type="button" className={`${control} border-cyan-400 bg-cyan-950 font-bold`}
            onClick={() => void (async () => {
              if (!await categoryNameField.flush() || !await tableChiefField.flush()) return;
              setEditorOpen(false); nameRef.current?.focus(); nameRef.current?.scrollIntoView?.({ block: "nearest" });
            })()}>
              Continuar con competidores →</button></div>
        </div>}
      </div>}
    </section>

    <DemoCategoryTools state={state} categoryId={categoryId} readOnly={readOnly} dispatch={dispatch} />

    <div className="grid gap-4 xl:grid-cols-2">
      <section className={surface} aria-label="Competidores">
        <h2 className="text-xl font-bold">Competidores <span className="text-cyan-300">{category.competitors.length}</span></h2>
        {category.phase === "setup" && <>
          <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,11rem)_auto]">
            <input ref={nameRef} className={input} aria-label="Nombre del competidor" placeholder="Nombre del competidor"
              disabled={readOnly} value={name} onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") void saveCompetitor(); }} />
            <input className={input} aria-label="Club opcional" placeholder="Club (opcional)" disabled={readOnly}
              value={team} onChange={(event) => setTeam(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") void saveCompetitor(); }} />
            <button type="button" disabled={readOnly || !name.trim()} className={`${control} font-bold`}
              onClick={() => void saveCompetitor()}>{editId ? "Guardar" : "Agregar"}</button>
          </div>
          {editId && <button type="button" className={`${control} mt-2`} onClick={() => { setEditId(null); setName(""); setTeam(""); }}>Cancelar edición</button>}
          <label className="mt-3 block text-sm font-semibold">Importar Excel o TXT de categorías; también admite lista simple (nombre y club)
            <input type="file" accept=".xlsx,.xls,.csv,.txt" disabled={readOnly || importBusy} className={`${input} mt-1 file:mr-2 file:rounded file:border-0 file:bg-slate-700 file:p-1 file:text-slate-50`}
              onChange={(event) => { const file = event.target.files?.[0]; if (file) void importSpreadsheet(file); event.target.value = ""; }} />
          </label>
          {importError && <p role="alert" className="mt-2 text-amber-200">{importError}</p>}
          {importCategories.length > 0 && <div className="mt-3 rounded-lg border border-cyan-600 p-3">
            <h3 className="font-semibold">Categorías encontradas: {importCategories.length}</h3>
            <p className="text-sm text-slate-300">Cada opción crea un borrador nuevo, sin modificar la categoría actual ni iniciar peleas.</p>
            <ul className="mt-2 space-y-2">{importCategories.map((entry) => <li key={`${entry.name}-${entry.matchType}-${entry.competitors.join("|")}`}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-700 p-2">
              <span className="min-w-0 break-words">{entry.name} · {entry.matchType === "tul" ? "Tul" : "Lucha"} · {entry.competitors.length} competidores</span>
              <button type="button" disabled={readOnly || importBusy} className={control}
                onClick={() => void importCategory(entry)}>Crear borrador</button></li>)}</ul>
            <button type="button" className={`${control} mt-2`} onClick={() => setImportCategories([])}>Cancelar importación</button>
          </div>}
          {importPreview && <div className="mt-3 rounded-lg border border-cyan-600 p-3">
            <p className="font-semibold">Vista previa: {importPreview.length} competidores</p>
            <p className="text-sm text-slate-300">{importPreview.slice(0, 5).map((person) => person.name).join(", ")}{importPreview.length > 5 ? "…" : ""}</p>
            <div className="mt-2 flex gap-2"><button type="button" disabled={readOnly || importBusy} className={control} onClick={async () => {
              setImportBusy(true);
              try {
                for (const person of importPreview) {
                  if (!await dispatch({ type: "category/addCompetitor", categoryId, competitor: person })) return;
                }
                setImportPreview(null);
              } finally { setImportBusy(false); }
            }}>Agregar a la categoría</button><button type="button" className={control} onClick={() => setImportPreview(null)}>Cancelar</button></div>
          </div>}
        </>}
        {fieldError && !currentStep && <p role="alert" className="mt-2 text-amber-200">{fieldError}</p>}
        <ol className="mt-3 max-h-[30rem] space-y-2 overflow-y-auto">
          {category.competitors.map((person: CompetitorEntry, index) => <li key={person.id} className="flex min-h-14 items-center gap-2 rounded-lg border border-slate-700 p-2">
            <span className="w-8 shrink-0 text-center text-slate-400">{index + 1}</span>
            <span className="min-w-0 flex-1 break-words text-lg font-semibold">{person.name}{person.team && <small className="block text-sm font-normal text-slate-300">{person.team}</small>}</span>
            {category.phase === "setup" && <><button type="button" disabled={readOnly} className={control}
              aria-label={`Editar a ${person.name}`} onClick={() => { setEditId(person.id); setName(person.name); setTeam(person.team ?? ""); nameRef.current?.focus(); }}>Editar</button>
              <button type="button" disabled={readOnly} className={control} aria-label={`Eliminar a ${person.name}`}
                onClick={() => void dispatch({ type: "category/removeCompetitor", categoryId, competitorId: person.id })}>Quitar</button></>}
          </li>)}
        </ol>
        {category.competitors.length === 0 && <p className="mt-3 text-slate-300">Ingresá el primer competidor para ver la llave.</p>}
        {category.phase === "setup" && <div className="mt-4">
          <button type="button" disabled={readOnly || !categoryNameField.value.trim() || preview.length === 0}
            className={`${control} border-cyan-400 bg-cyan-800 font-bold`} onClick={() => void start()}>Iniciar categoría</button>
          {!categoryNameField.value.trim() && <p className="mt-2 text-sm text-amber-200">Poné un nombre a la categoría antes de iniciarla.</p>}
          {config.mode === "round-robin" && category.competitors.length > 0 && !getGroupDistribution(category.competitors.length) &&
            <p className="mt-2 text-sm text-amber-200">Round Robin admite de 3 a 12 competidores.</p>}
        </div>}
        {category.phase !== "setup" && <button type="button" className={`${control} mt-4 border-cyan-400`} onClick={onFight}>Ir al combate</button>}
      </section>
      <section className={surface} aria-label="Vista previa de la llave">
        <h2 className="text-xl font-bold">{category.phase === "setup" ? "Llave (vista previa)" : "Llave guardada"} · {preview.length} combates</h2>
        <ol className="mt-3 max-h-[35rem] space-y-2 overflow-y-auto">
          {preview.map((fight, index) => <li key={fight.id} className="flex min-h-14 items-center gap-2 rounded-lg border border-slate-700 p-3 text-base sm:text-lg">
            <span className="w-7 shrink-0 text-sm text-slate-400">{index + 1}.</span>
            <span className="min-w-0 flex-1 break-words text-right font-bold text-red-400">{fight.red}</span>
            <span className="shrink-0 text-sm text-slate-400">vs</span>
            <span className="min-w-0 flex-1 break-words font-bold text-blue-400">{fight.blue}</span>
            {fight.group && <span className="hidden shrink-0 text-xs text-slate-400 sm:block">{fight.group}</span>}
            {fight.completed && <span className="sr-only">Completado</span>}
          </li>)}
        </ol>
        {preview.length === 0 && <p className="mt-3 text-slate-300">La vista previa aparece al agregar suficientes competidores.</p>}
      </section>
    </div>
  </div>;
}

function BufferedTimingInput({ journalIdentity, label, value, min, disabled, save }: Readonly<{
  journalIdentity: string; label: string; value: number; min: number; disabled: boolean;
  save: (value: number) => Promise<boolean>;
}>) {
  const validate = (raw: string): string | null => {
    const parsed = Number(raw);
    return /^\d+$/.test(raw) && Number.isSafeInteger(parsed) && parsed >= min && parsed <= 3600
      ? null : `Ingresá un número entero entre ${min} y 3600 para ${label.toLowerCase()}.`;
  };
  const field = useBufferedInput(`${journalIdentity}:timing:${label}`, String(value), !disabled,
    (raw) => save(Number(raw)), validate);
  return <label className="text-sm">{label}
    <input type="number" min={min} max="3600" disabled={disabled} className={`${input} mt-1`}
      value={field.value} onChange={(event) => field.change(event.target.value)} onBlur={field.blur} />
    {field.error && <span role="alert" className="mt-1 block text-amber-200">{field.error}</span>}
  </label>;
}

function TimingFields({ config, journalIdentity, disabled, patch }: Readonly<{
  config: TournamentConfig; journalIdentity: string; disabled: boolean;
  patch: (changes: ConfigUpdate) => Promise<boolean>;
}>) {
  const rules = selectedRules(config);
  const fields: Array<{ label: string; value: number; min: number;
    update: (n: number, current: TournamentConfig) => Partial<TournamentConfig> }> = [
    { label: "Rounds", value: rules.rounds.count, min: 1, update: (n, current) => {
      const active = selectedRules(current);
      return { ruleSet: { ...active, rounds: { ...active.rounds, count: n } }, profileApplied: false };
    } },
    { label: "Segundos por round", value: rules.rounds.duration_seconds, min: 1, update: (n, current) => {
      const active = selectedRules(current);
      return { ruleSet: { ...active, rounds: { ...active.rounds, duration_seconds: n } }, profileApplied: false };
    } },
    { label: "Descanso (segundos)", value: rules.rounds.rest_seconds, min: 0, update: (n, current) => {
      const active = selectedRules(current);
      return { ruleSet: { ...active, rounds: { ...active.rounds, rest_seconds: n } }, profileApplied: false };
    } },
    { label: "Segundos de desempate", value: config.tiebreakerSeconds ?? 30, min: 1,
      update: (n) => ({ tiebreakerSeconds: n, profileApplied: false }) },
  ];
  const choiceGroup = (label: string, choices: Array<{ label: string; value: number }>, selected: number,
    update: (value: number) => ConfigUpdate) => <fieldset className="space-y-2">
    <legend className="font-semibold">{label}</legend>
    <div className="flex flex-wrap gap-2">{choices.map((choice) => <Choice key={choice.value} disabled={disabled}
      label={choice.label} selected={selected === choice.value} onClick={() => void patch(update(choice.value))} />)}</div>
  </fieldset>;
  return <div className="space-y-4">
    {choiceGroup("Jueces", [1, 3, 4, 5].map((value) => ({ label: String(value), value })),
      config.judgesCount, (judgesCount) => (current) => ({ judgesCount,
        ruleSet: { ...selectedRules(current), judgesCount } }))}
    <div className="grid gap-2 sm:grid-cols-2">{fields.map((field) => <BufferedTimingInput
      key={`${journalIdentity}:${field.label}`} journalIdentity={journalIdentity} label={field.label} min={field.min}
      value={field.value} disabled={disabled}
      save={(next) => patch((current) => field.update(next, current))} />)}</div>
    {choiceGroup("Rounds en la final", [1, 2, 3].map((value) => ({ label: `${value} round${value === 1 ? "" : "s"}`, value })),
      config.finalRounds ?? rules.rounds.count, (finalRounds) => ({ finalRounds, profileApplied: false }))}
    {choiceGroup("Duración del round final", [60, 90, 120, 180].map((value) => ({
      label: value === 90 ? "1:30" : `${value / 60} min`, value,
    })), config.finalSeconds ?? rules.rounds.duration_seconds,
    (finalSeconds) => ({ finalSeconds, profileApplied: false }))}
    <p className="text-sm text-slate-300">Si persiste el empate tras un desempate cronometrado, sigue Punto de Oro sin reloj.</p>
  </div>;
}
