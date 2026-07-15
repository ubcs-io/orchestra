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
    details: 23 specialized "software-company" roles — from Bug Investigator to Security Reviewer — each inspecting your real codebase through a chain of reasoning steps.
  - icon: 🗺️
    title: Coverage Maps
    details: Every role declares which concerns it examined and which it skipped. Omissions are visible — you can see, for example, that privacy was never reviewed.
  - icon: 🎮
    title: Live Steering
    details: Pause, resume, inject roles mid-plan, deepen analysis, or add steer notes. Full control over the refinement loop in real time.
  - icon: 🌐
    title: Visual Agent Networks
    details: Build custom refinement graphs in a drag-and-drop editor. Replace the default linear flow with branching, parallel, or gated agent networks.
  - icon: 📦
    title: Git-Backed Artifacts
    details: Every refinement step produces version-controlled markdown artifacts in your repo. The planning history is reviewable, diffable, and PR-able.
  - icon: 🔌
    title: OpenAI-Compatible
    details: Works with any OpenAI-compatible endpoint — Ollama, LM Studio, vLLM, OpenWebUI, or cloud providers. Bring your own model.
---

## Status

Orchestra is in **alpha**. The full pipeline — ingest, planning, role execution, gating, coverage rollup, decomposition, and the React UI — is implemented and typechecks/builds. Successful LLM refinement depends on a reachable, tool-capable model.