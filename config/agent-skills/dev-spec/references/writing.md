# Threadnote STE profile

<!-- dev-spec, dev-plan, dev-cycle and watch-pr each ship an identical copy of this file. `scripts/build.ts` rejects the bundle if the copies differ. threadnote-memory/SKILL.md has a compact copy of the Apply, Relax and Exempt rules. Change all copies together. -->

This profile is a practical subset of ASD-STE100 Simplified Technical English (STE). Use it for all workflow outputs. These outputs are user-facing reports, task-card business inputs, review findings, PR bodies, handoffs and stored memories. A human or an agent must understand the text on the first read.

## Apply

- Write one topic in each sentence.
- Keep a procedural sentence to 20 words or fewer. Keep a descriptive sentence to 25 words or fewer.
- Keep a paragraph to 6 sentences or fewer. Give each paragraph one topic.
- Use the active voice and a simple tense: present, past or future. Write "The runtime rejects the packet", not "The packet is rejected".
- Start an instruction with the imperative verb. Give one instruction in each sentence. Use a numbered list for steps.
- Write the condition first. Write "If the check fails, stop the phase", not "Stop the phase if the check fails".
- Keep the articles ("a", "the") and the demonstratives ("this", "that").
- Use no more than 3 words in a noun cluster. Write "the lease of the watch consumer", not "watch consumer lease renewal state".
- Use one word for one meaning. Use the same term for the same thing in all of the text. Do not change terms for style.
- Use a plain verb. Do not use an -ing form, a phrasal verb, a contraction or a noun as a verb. Write "before you merge the PR", not "before merging". Write "start", not "kick off".
- In a warning or a caution, write the command first and then the reason. Write "Do not push to `main`. CI does not check a direct push".
- Label each claim as measured, inferred or unknown.

## Relax

These two rules are the "80%" part of the profile.

- Do not limit your words to the STE dictionary. Use the simplest common word that has one clear meaning.
- Use descriptive sentences for tradeoffs and risks. Keep one topic in each sentence.

## Exempt

- Keep these items verbatim in backticks: code identifiers, paths, commands, flags, error codes, technical names and URLs. Examples are `recall_context`, `config/dev-skills.json` and `--require-current-code-refs`.
- Keep product names and quoted text verbatim. Put quoted text in quotation marks.
- The Apply rules do not apply to the text of an exempt item.

## Readability

- Keep Markdown headings, lists and tables. Use a table to compare options.
- Write full sentences. Do not compress the text into telegraphic fragments. Keep the articles.

## Example

Before:

> So basically we went ahead and refactored the flaky watch-consumer lease renewal logic, and it's now being retried with backoff, which should fix the CI timeouts, though the root cause hasn't really been nailed down.

After:

> We changed how the watch consumer renews its lease. If a renewal fails, the consumer now tries again with exponential backoff. We infer that this change stops the CI timeouts. The root cause of the timeouts is unknown.
