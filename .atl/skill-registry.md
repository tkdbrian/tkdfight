# Skill Registry — tkd-tournament-2026

**Generated**: 2026-04-08
**Project**: TKD Tournament System 2026
**Agent**: VS Code Copilot

## User Skills

| Skill | Trigger Context | File |
|-------|----------------|------|
| branch-pr | Creating PRs, preparing changes for review | `~/.copilot/skills/branch-pr/SKILL.md` |
| go-testing | Writing Go tests, Bubbletea TUI testing | `~/.copilot/skills/go-testing/SKILL.md` |
| issue-creation | Creating GitHub issues, reporting bugs | `~/.copilot/skills/issue-creation/SKILL.md` |
| judgment-day | "judgment day", "dual review", adversarial review | `~/.copilot/skills/judgment-day/SKILL.md` |
| playwright | Writing E2E tests, Page Objects | `~/.copilot/skills/playwright/SKILL.md` |
| react-19 | Writing React components (no useMemo/useCallback needed) | `~/.copilot/skills/react-19/SKILL.md` |
| skill-creator | Creating new AI skills, agent instructions | `~/.copilot/skills/skill-creator/SKILL.md` |
| tailwind-4 | Styling with Tailwind, cn(), theme variables | `~/.copilot/skills/tailwind-4/SKILL.md` |
| typescript | Writing TypeScript, types, interfaces, generics | `~/.copilot/skills/typescript/SKILL.md` |
| zod-4 | Using Zod for validation, breaking changes from v3 | `~/.copilot/skills/zod-4/SKILL.md` |
| zustand-5 | Managing React state with Zustand | `~/.copilot/skills/zustand-5/SKILL.md` |
| agent-customization | Creating .instructions.md, .prompt.md, SKILL.md files | `~/.vscode/extensions/github.copilot-chat-*/assets/prompts/skills/agent-customization/SKILL.md` |

## Compact Rules

### react-19
- No `useMemo`, `useCallback`, `memo` — React Compiler handles it
- Prefer Server Components when possible; `use client` only when needed
- Use `useActionState`, `useFormStatus`, `use()` for async

### typescript
- Strict mode always on (`"strict": true`)
- Prefer `interface` for objects, `type` for unions/intersections
- No `any` — use `unknown` + narrowing
- Explicit return types on exported functions

### tailwind-4
- Use `cn()` from `lib/utils` for conditional classes
- CSS variables via `@theme` in CSS, not `tailwind.config.js`
- No `var()` inside `className`

### zod-4
- `z.string().min(1)` not `z.string().nonempty()`
- `z.object({}).strict()` to reject unknown keys
- Use `.parse()` at boundaries, `.safeParse()` in handlers

### zustand-5
- One store per domain, not one global store
- Use `useShallow` for selector stability
- `immer` middleware for nested state updates

### playwright
- Page Object Model pattern always
- `data-testid` attributes for selectors
- `await expect(locator).toBeVisible()` not `.isVisible()`

## Project Conventions

No project-level AGENTS.md or convention files found. Uses:
- **Biome** for lint + format (2 spaces, 100 char lines, double quotes)
- **TypeScript strict** mode
- **ESM** modules (`"type": "module"`)
- Path alias `@/` → `./src/`

## Stack Context (for skill activation)

| File pattern | Skills to auto-load |
|-------------|---------------------|
| `src/**/*.tsx`, `src/**/*.ts` | react-19, typescript, tailwind-4 |
| `src/store/**` | zustand-5 |
| `server/**` | typescript |
| `e2e/**` | playwright |
| `src/**/*.zod.*`, validation code | zod-4 |
