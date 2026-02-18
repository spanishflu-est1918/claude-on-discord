# Documentation

This directory holds project docs that are too detailed for the top-level `README.md`.

## Docs Index

- `ARCHITECTURE.md`: system design, data model, and message flow
- `TROUBLESHOOTING.md`: common failures, diagnosis steps, and fixes
- `SECURITY.md`: security posture, token handling, and operational risks
- `WEBSITE_BRIEF.md`: positioning and content brief for the future website

Current standout capability:

- Discord thread branching with automatic context inheritance and branch-aware prompt metadata.
- Reliable generated-file delivery back to Discord (`files_persisted`, `ATTACH:` directives, path fallback).
- Multi-user mention gating with global default + per-channel `/mentions` override.
