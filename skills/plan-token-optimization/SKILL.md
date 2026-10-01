---
name: plan-token-optimization
description: Analyzes a project's file structure and documentation to identify token bottlenecks, generating a report and an implementation plan for improvements without applying the changes directly.
---

# Skill: Plan Project Token Optimization

When a user asks to "plan token optimization", "analyze token usage", "gerar relatório de tokens", "plan context reduction" or similar phrases, follow this protocol. **Do NOT apply the changes directly**; your goal is only to audit and plan.

## Step 1: Audit the Codebase

Use `find_by_name` and `list_dir` to scan the project. Identify:
- **Files over 300 lines**: These are the primary token bottlenecks. List them sorted by size (largest first).
- **Monolithic documentation files**: `PRD.md`, `README.md`, or any single `docs/*.md` file that covers multiple unrelated topics.
- **Large shared state files**: Any file at the root of a feature that aggregates logic (e.g., a root component file that contains hooks, rendering, and API calls together).

## Step 2: Generate an Analysis Report

Create a comprehensive report detailing the current state of the codebase regarding token efficiency. Present findings in a clear table format:

| File | Lines | Type | Recommendation |
| :--- | :--- | :--- | :--- |
| `KanbanView.tsx` | 1724 | UI Monolith | Split into Header, Column, Card, Hook |
| `PRD.md` | 600 | Doc Monolith | Create `docs/architecture.md`, `docs/features.md` |

Include an analysis of why these files are problematic (e.g., mixing UI and business logic, monolithic documentation).

## Step 3: Create an Implementation Plan

Generate an `implementation_plan.md` artifact detailing the specific steps required to execute the optimization. The plan MUST BE HIGHLY DETAILED and include:
- **Exact File Operations**: List each file to be modified, created, or deleted.
- **Line Count Impact**: For every file being split, explicitly state its current line count and the *estimated line counts* for each of the new target files. Clearly show the before/after details.

The plan should also be based on these rules:

### Code Files
- **The 300-Line Rule**: No single file should exceed 300 lines. Plan to split into focused modules.
- **Separation of Concerns**:
  - UI components handle ONLY rendering.
  - Custom Hooks (e.g., `useFeatureData.ts`) handle state, effects, and API calls.
  - Modal/overlay components go in a dedicated `*Editors.tsx` or `*Modals.tsx` file.
  - Shared types go in `types.ts`.

### Documentation Files
- **PRD.md becomes an index**: Plan to replace with a short overview and links to topic-based docs.
- **Topic-based docs**:
  - `docs/architecture.md`: System overview, infrastructure, data flow.
  - `docs/features/[feature-name].md`: Rules for each feature.
  - `docs/api.md`: Endpoint contracts and data types.

### Knowledge Items (KIs)
- Suggest creating KIs for logic that is queried frequently, complex but stable, or requires reading hundreds of lines of code.

## Step 4: Generate a Presentation Screen (For Video)

Create a visually appealing, highly professional HTML file (e.g., `optimization_summary.html`) designed specifically to be recorded in a video. 
**CRITICAL LAYOUT & CSS REQUIREMENTS**: 
- **Prevent Clipping**: Ensure the layout is not broken at the top. Use a full HTML5 boilerplate with `<meta name="viewport" content="width=device-width, initial-scale=1.0">`.
- **CSS Reset**: Include `* { margin: 0; padding: 0; box-sizing: border-box; }` to prevent browser default margins from breaking the layout.
- **Centering & Spacing**: Use Flexbox or CSS Grid on the body (e.g., `min-height: 100vh; display: flex; flex-direction: column; justify-content: center; align-items: center; padding: 40px;`) so the content is perfectly centered and never cut off.
- **Premium Aesthetics**: It must use a premium modern dark-mode design (e.g., curated color palettes, subtle gradients, glassmorphism, proper shadows, and rounded corners) with **massive, bold numbers**.
The screen MUST highlight the real expected results calculated from the audit in Step 1. Do NOT use generic placeholder numbers; analyze the total lines of the bottlenecks versus the total size of the project to calculate genuine estimated savings:
- **Token Economy**: Calculate the % reduction in context size (e.g., if splitting a 2000-line file into smaller modules reduces the active context needed per task by 70%, show "📉 70% Less Tokens"). Use massive fonts.
- **Speed Increase**: Estimate the multiplier for faster AI response times based on the token reduction (e.g., "⚡ 3x Faster Responses").
- **Cost Reduction**: Correlate cost directly to the token reduction percentage (e.g., "💰 70% Cheaper Sessions").

**CRITICAL EXECUTABLE STEP**: Ao finalizar a geração do arquivo HTML, você DEVE explicitamente abri-lo no navegador padrão do usuário para exibição da tela de sumário. Use a ferramenta `run_command` executando o comando `open optimization_summary.html` (para macOS) para que o sumário seja exibido automaticamente e imediatamente em uma nova aba do navegador.

## Step 5: Present the Plan to the User

Present the generated report, the `implementation_plan.md`, and explicitly state that you have just opened the visual presentation screen in their browser. Clearly state that no changes have been made yet, and ask for their review and approval.
