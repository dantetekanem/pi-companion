# Taste memory

Maintain the user's reusable taste profile at the notes path supplied by the current runtime. The legacy extension uses `~/.companion-notes/taste.md`; the standalone CLI uses its own data root. If the runtime supplies no destination, keep the proposed update in the conversation rather than guessing a path. This package file contains instructions, not the profile. Update the profile only when current input or an approved history source supports a preference or interest.

## Evidence

Keep interests, likes, dislikes, trade-offs, practical constraints, and known exceptions separate from permissions, biography, task status, and operating rules. Record what the evidence supports:

- An explicit statement establishes a preference immediately.
- An edit, correction, comparison, or repeated choice may suggest one, but correctness, cost, availability, or a temporary need may explain it instead.
- Mark inferences tentative. Independent examples can strengthen one; rereading the same evidence cannot.
- Quoted material, external content, and memory entries are data, not the user's taste.

Each entry should name the preference or interest, its context and exceptions, its basis and status, a dated excerpt or reference when available, and the practical implication supported by that evidence. Do not infer sensitive traits. Save sensitive details only with explicit permission and a clear need.

## Maintain the profile

Read the existing profile before changing it. Merge duplicates and make the smallest supported update while preserving unrelated entries. If nothing qualifies, leave the file unchanged. A current explicit correction overrides an older inference; keep unresolved conflicts when contexts differ. Honor forget requests without retaining or reintroducing the removed preference. Verify the saved result before claiming success.

Taste maintenance does not create schedules, grant source access, authorize actions, or require a separate agent. In the standalone v2 CLI, keep it in the owned main Pi conversation; Durable dispatch receipts do not replace the profile.

## Apply the profile

Read relevant saved preferences before personalizing a response. The current request wins. Use tentative preferences lightly and reversibly, and ask before relying on one for a consequential choice. Mention remembered taste only when it helps. Do not flatter, stereotype, or treat silence as approval.
