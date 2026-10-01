---
name: optimize-for-tokens
description: Audits a project's file structure and documentation to suggest concrete refactorings that reduce context window (token) usage in AI-assisted development sessions.
---

# Skill: Optimize Project for Token Efficiency

When a user asks to "optimize tokens", "reduce context", "analyze file size", "otimizar tokens" or similar phrases, follow this protocol:

## Step 1: Audit the Codebase

Use `find_by_name` and `list_dir` to scan the project. Identify:
- **Files over 300 lines**: These are the primary token bottlenecks. List them sorted by size (largest first).
- **Monolithic documentation files**: `PRD.md`, `README.md`, or any single `docs/*.md` file that covers multiple unrelated topics.
- **Large shared state files**: Any file at the root of a feature that aggregates logic (e.g., a root component file that contains hooks, rendering, and API calls together).

## Step 2: Report and Categorize

Present findings in a table format:

| File | Lines | Type | Recommendation |
| :--- | :--- | :--- | :--- |
| `KanbanView.tsx` | 1724 | UI Monolith | Split into Header, Column, Card, Hook |
| `PRD.md` | 600 | Doc Monolith | Create `docs/architecture.md`, `docs/features.md` |

## Step 3: Apply the Rules

When executing the optimization, follow these rules:

### Code Files
- **The 300-Line Rule**: No single file should exceed 300 lines. Split into focused modules.
- **Separation of Concerns**:
  - UI components handle ONLY rendering.
  - Custom Hooks (e.g., `useFeatureData.ts`) handle state, effects, and API calls.
  - Modal/overlay components go in a dedicated `*Editors.tsx` or `*Modals.tsx` file.
  - Shared types go in `types.ts`.

### Documentation Files
- **PRD.md becomes an index**: Replace with a short overview and links to topic-based docs.
- **Topic-based docs**:
  - `docs/architecture.md`: System overview, infrastructure, data flow.
  - `docs/features/[feature-name].md`: Rules for each feature.
  - `docs/api.md`: Endpoint contracts and data types.

### Knowledge Items (KIs)
- Recommend creating a KI for any logic that:
  - Is queried frequently (e.g., DOM selectors, auth flows).
  - Is complex but rarely changes.
  - Would otherwise require re-reading hundreds of lines of stable code.

## Step 4: Estimate and Measure Savings

After refactoring, create or update a `token_savings_analysis.md` file in the project root with the following template:

```markdown
# Token Savings Analysis

## [Module Name]
| Metric | Before | After | Savings |
| :--- | :--- | :--- | :--- |
| File Size | ~X lines | ~Y lines | Z% |
| Token Cost | ~X tokens | ~Y tokens | Z% |
```

## Guiding Principles
- A good AI session is like a good function: **do one thing, do it well**.
- Token efficiency is not about being cheap — it's about giving the AI **laser focus**.
- Prefer many small, focused files over one large "smart" file.
