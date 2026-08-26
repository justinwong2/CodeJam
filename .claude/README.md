# Shared Claude Code Configuration

This directory is **committed to the repository**. Anything here loads
automatically for every teammate who opens this repo in Claude Code — no
personal setup, no "works on my machine".

## Contents

| Path                       | What it does                                                                                                      |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `skills/document/SKILL.md` | Repo-scoped documentation skill. Knows this project's doc layers, drift-control rules, and hackathon constraints. |

## Using the shared skill

Type `/document` in Claude Code from anywhere in this repo:

```bash
/document                                 # audit docs, report drift
/document feature: per-Agent identity     # propose doc updates for a capability
/document adr: chose AgentRunner boundary # draft an architecture decision record
/document spec: policy enforcement        # draft a design spec
```

## Scoping note

A project skill takes precedence over a personal skill of the same name while
working in this repo. If you have your own `document` skill in
`~/.claude/skills/`, this one wins here — which is intended, since it targets
this project's actual documentation layers rather than generic ones.

## Adding a shared skill

1. Create `.claude/skills/<name>/SKILL.md`.
2. Give it YAML frontmatter with `name` and `description`. The description is
   what tells Claude when to reach for it, so make it specific.
3. Commit it. Teammates get it on their next pull.

Keep shared skills genuinely repo-specific. Anything general belongs in a
personal `~/.claude/skills/` directory instead — otherwise it becomes noise in
everyone's session.

## Not committed

Personal overrides belong in `.claude/settings.local.json`, which is gitignored.
Never commit API keys, tokens, or personal paths here.
