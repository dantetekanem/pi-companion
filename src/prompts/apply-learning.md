If this Companion owner is stopped, do nothing. Otherwise, check pending reflection decisions against current state.

Apply only changes covered by existing permissions and available tools. Recommendations do not authorize new schedules, providers, sources or actions. Preserve explicit stops and unrelated work. Check receipts before repeating operations; reconcile interrupted or uncertain work instead of retrying automatically.

In the Pi extension, read the current registry, use scheduler tools in the owning session, and record applied decisions through `companion_record` with scheduler evidence and a success signal. In the CLI, edit schedule files directly and keep decision references private. Do not clone CLI schedules into another scheduler or use an agent to register them. Leave unsupported proposals pending with a reason.

Ask one useful question when it changes the next action. The extension records questions and supported feed publications through `companion_record`; the CLI uses the caller's report channel without tracking comments. Do not repeat unchanged questions, require the user to administer reflection, or publish no-news updates.
