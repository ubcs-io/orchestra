---
layout: home

hero:
  name: Orchestra
  text: Refinement utility for code planning
  tagline: Connect a git repo, drop in a raw error log or research prompt, and watch specialized role agents transform it into an actionable spec — with live visibility and full steering control.
  actions:
    - theme: brand
      text: Get Started
      link: /guide/quick-start
    - theme: alt
      text: How It Works
      link: /guide/how-it-works

features:
  - icon: 🧩
    title: Role-Based Refinement
    details: 25 specialized "software-company" roles — from Bug Investigator to Security Reviewer to an adversarial per-step Critic — each inspecting your real codebase through a chain of reasoning steps.
  - icon: 🗺️
    title: Coverage Maps
    details: Every role declares which concerns it examined and which it skipped. Omissions are visible — you can see, for example, that privacy was never reviewed.
  - icon: 🎮
    title: Live Steering
    details: Pause, resume, inject roles mid-plan, deepen analysis, add steer notes, or spin an open question off into its own child Question Flow subtask. Full control over the refinement loop in real time.
  - icon: 🩺
    title: Built for Local Models
    details: Reports stream to disk as they're written, verdicts arrive by constrained decoding where the endpoint supports it, and every run carries a health record — so a truncated response costs a verdict, not the analysis.
  - icon: 🔬
    title: Self-Calibrating Models
    details: Probe an endpoint and Orchestra measures what it can actually do — tool calling, structured output, thinking dialect — then picks the run shape itself and keeps adjusting as real runs accumulate.
  - icon: 🛠️
    title: From Plan to Patch
    details: Opt roles into editing source and running your allowlisted test command inside the task's own worktree. Verdicts carry harness-recorded evidence, and code changes wait at an explicit merge gate.
  - icon: 🌙
    title: Works While You Don't
    details: Watchers scan for failing tests, decayed TODOs, lint and doc drift during idle windows, propose candidates under hard budgets, and leave a morning report of what actually happened.
  - icon: 🌐
    title: Visual Agent Networks
    details: Build custom refinement graphs in a drag-and-drop editor. Replace the default linear flow with branching, parallel, or gated agent networks.
  - icon: 🔌
    title: OpenAI-Compatible
    details: Works with any OpenAI-compatible endpoint — Ollama, LM Studio, vLLM, OpenWebUI, or cloud providers. Bring your own model.
---

## Status

Orchestra is in **alpha**, and developed in phases:

- **Reliability** — artifact-first output, constrained decoding with per-endpoint probing, repair-and-resume instead of full reruns, and a run-health record that feeds the gates.
- **Trust** — an allowlisted command runner inside the task worktree, so verdicts carry executed evidence rather than opinion; and measured model capability profiles that replace hand-tuned compatibility flags.
- **Autonomy** — per-run context budgeting for small windows, plus watchers that generate their own work under idle-window budgets and report each morning.
- **Transport** — a read-only MCP surface so an external agent can read task context and the candidate queue.

All of the above is implemented and typechecks/builds, alongside the original pipeline: ingest, planning, concurrent role execution across per-task git worktrees, per-step adversarial critique, gating with optional LLM routing advisors, checkpoint restore, answer reincorporation, coverage rollup, decomposition, intake review, and the React UI. Successful LLM refinement still depends on a reachable, tool-capable endpoint.

Operational guardrails: encryption at rest for stored tokens (AES-256-GCM), per-project rolling-window spend ceilings that actually stop dispatch, and role versioning with per-version outcome scoring.
