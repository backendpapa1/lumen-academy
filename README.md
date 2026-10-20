# Lumen Academy

*Learn by teaching.* A sleek sci-fi academy where AI cadets enroll in classes on whatever you're studying. You teach, they question, you grade, they sit exams, and how they perform shows you what you really understand.

Built for an ADHD brain: short class periods, instant feedback, visible progress, no shame mechanics.

## Docs

| # | Doc | What's in it |
|---|-----|--------------|
| — | [`CLAUDE.md`](CLAUDE.md) | Rules and conventions for Claude Code |
| 01 | [PRD](docs/01-PRD.md) | Problem, goals, requirements (P0/P1/P2), ADHD design rules, success criteria |
| 02 | [Game Design](docs/02-GAME-DESIGN.md) | Scenes, loops, classroom, registration, exams, events, progression |
| 03 | [Agent System](docs/03-AGENT-SYSTEM.md) | deepagents topology, turn pipeline, cadet archetypes, knowledge gating, evals |
| 04 | [Models & Providers](docs/04-MODELS-AND-PROVIDERS.md) | Which model each agent uses, OpenAI/DeepSeek profiles, config, cost model |
| 05 | [Technical Architecture](docs/05-TECHNICAL-ARCHITECTURE.md) | Stack, repo layout, Phaser 4 + Three.js integration, protocol, API |
| 06 | [Data Model](docs/06-DATA-MODEL.md) | SQLite schema, derived values, shared types |
| 07 | [Asset Pipeline](docs/07-ASSET-PIPELINE.md) | OpenAI image generation: static + runtime, prompts, caching, budgets |
| 08 | [Art Direction](docs/08-ART-DIRECTION.md) | Palette, type, UI and world language, hologram shader recipe |
| 09 | [Roadmap](docs/09-ROADMAP.md) | Milestones M0–M6 with gates, v2 voice plan |

## Quick start (once built)

```bash
cp .env.example .env        # add OPENAI_API_KEY and DEEPSEEK_API_KEY
pnpm i && pnpm db:migrate
pnpm models:check
pnpm dev                    # open http://localhost:5173
```

## Stack at a glance
Three.js · Phaser 4 · TypeScript · Vite · Fastify · LangChain deepagents · OpenAI + DeepSeek · SQLite (Drizzle, sqlite-vec, FTS5) · OpenAI Images · Tone.js
