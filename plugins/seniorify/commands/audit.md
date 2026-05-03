---
description: Force-arm the Seniorify auditor for the next code-modifying action.
argument-hint: "[optional plan body in plain English]"
allowed-tools: ["Bash"]
---

!`node "${CLAUDE_PLUGIN_ROOT}/dist/commands/audit.js" $ARGUMENTS`

The Seniorify auditor is now armed. Your next code-modifying action will trigger a
plan-audit dialog regardless of triviality.

If a body was supplied above, follow the agent_instruction printed by the script:
when the next PreToolUse block fires, call the `submit_plan` MCP tool with the body,
the affected paths, and the `pending_engagement_id` from the block message.
