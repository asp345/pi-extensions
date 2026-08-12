---
description: Remove Claude-typical expressions and sentence structures from a document
argument-hint: "<file>"
---
Rewrite ${@:-the document under discussion; if none is clear, ask which file} to remove
Claude-typical phrasing. The text was written by a model with specific habits; search for
those habits directly. The document may be in English or Korean; both lists below apply.
Keep the technical content, math, labels, and the strength of every claim exactly as they
are. Change only the offending phrases and make each edit minimal.

Remove all figurative language: metaphor, simile, and personification, in any language.
Every replacement states the literal operation. Never introduce figurative language or
an em dash in a replacement.

Habits to remove:

- Contrastive scaffolding: "not X, but Y", "It is not that ... rather ...", "less about X
  than Y", "The point is not X. The point is Y.", "What is needed is X". Assert the
  positive claim directly.
- Personified data and machinery metaphors: values that "live", "survive", "outlive",
  "die", "meet", "see", "remember"; proofs that "do the work" or "rest on" something;
  components called "twins" or "cousins"; "machinery", "plumbing", "glue", "scaffolding",
  "under the hood", "heavy lifting", "gates"/"unlocks" as verbs, "through the lens of",
  "tells the same story". Replace with the literal operation: persists, remains, is
  stored, is combined, depends on, variant, counterpart.
- Construction and hazard metaphors: "load-bearing", "seams", "footgun", "sharp edges",
  "escape hatch", "guardrails", "moving parts", "surface area", "blast radius",
  "happy path", "north star". Name the actual property: essential, central, boundary,
  risk, error-prone case, override, default case.
- Significance inflation: "Crucially", "Importantly", "Notably", "Remarkably", "The key
  insight is", "is worth stating/noting", "subtle but important", "This is precisely
  where", "It is no accident that". Delete the frame and keep the fact.
- Uniqueness emphasis: "The only X is Y", "the sole", "one and only", "exactly one" used
  for weight rather than a counted fact. Write "X is Y" or "X: Y".
- Settlement verbs outside actual conclusions: "This confirms", "This establishes",
  "This settles", "This cements", "locks in". State the fact; reserve conclusion verbs
  for theorem conclusions.
- Restatement tics: "In other words", "Put differently", "The upshot is", "That is,"
  followed by a paraphrase of the previous sentence. Keep the better version, delete the
  other.
- Colon drama and rhetorical setup: "The reason is simple: ...", "One fact does the
  work: ...", "Why does this hold? Because ...". Convert to a plain declarative sentence.
- Filler intensifiers and pet adjectives: "essentially", "effectively", "fundamentally",
  "at its core", "simply", "just", "clean", "elegant", "principled", "robust",
  "powerful", "seamless". Delete, or replace with a checkable property.
- Punctuation habits: em dashes, exclamation marks, rhetorical questions, and triadic
  "X, Y, and Z" rhythm added for cadence rather than content.

Korean habits to remove:

- Calques of English metaphors: "배선" for connections outside literal circuit wiring,
  "게이트", "파이프라인을 타고", "레버리지", "훅". Describe the actual relation: 연결,
  호출 순서, 의존.
- Coined word-for-word translations of English compound terms: "wiring family" →
  "배선족", "glue code" → "접착 코드". Such words do not exist in Korean technical
  usage. Use the established Korean term when one exists; otherwise keep the English
  term in English.
- Settlement verbs outside actual conclusions: "확정했습니다", "확정됩니다", "확립합니다",
  "못박습니다", overused "보장합니다". Use the plain verb for what happened: 정해집니다,
  저장합니다, 기록합니다.
- Contrast and inflation calques: "단순히 X가 아니라 Y입니다", "중요한 것은 X가 아니라
  Y라는 점입니다", "핵심은 ~라는 점입니다", "주목할 점은", "흥미롭게도", "결정적으로".
  Assert the claim directly.
- Personification and restatement: 값이 "살아남습니다"/"살아있습니다" → "유지됩니다";
  "다시 말해"/"즉," followed by a paraphrase of the previous sentence → keep one version.
- Translationese endings and connectives: overused "~하게 됩니다", "~인 셈입니다", "~라고
  할 수 있습니다", and "~를 통해" where "~로" or a direct verb suffices.

Examples of the direction of change:

- "is worth stating separately because" → "is stated separately because"
- "the hold survives because no intervening nwrite mentioned 1"
  → "the hold persists because no intervening nwrite mentioned 1"
- "walks the whole ResNet-20 through the same lens"
  → "applies the same construction to ResNet-20"
- "the sentence the surrounding claims rest on"
  → "the claim the surrounding results depend on"
- "the two shares of a value never meet inside the node"
  → "the two shares of a value are never combined inside the node"
- "their *_step_secret twins" → "their *_step_secret counterparts"
- "이 값은 다음 단계까지 살아남습니다" → "이 값은 다음 단계까지 유지됩니다"
- "슬롯 배치를 확정했습니다" → "슬롯 배치를 정했습니다"
- "모듈 간 배선을 따라" → "모듈 간 호출 순서를 따라"

Keep the document's own terminology even when it looks figurative: if "gate", "wire",
"probe", "handoff", "leakage", "배선" (in a literal circuit or PCB context), or similar
words are defined terms of the text, they stay.
Only remove figurative language that is not part of the document's vocabulary.

Do not reflow paragraphs, reword math, or touch LaTeX commands, labels, \ref/\cite, or
document structure. When in doubt whether a phrase is a Claude habit, leave it. Apply the
edits to the file, then re-read the changed regions to confirm no markup broke.
