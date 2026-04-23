---
"emdash": patch
---

Fixes revision restore bypassing the draft workflow on revisioned collections. On collections configured with `supports: ["revisions"]`, restoring a revision now stages the restored data as a new draft revision instead of overwriting live content, so the restore still has to go through publish like any other edit. Restore also now requires publish permission alongside edit, preventing it from being used to sidestep publish-specific policy.
