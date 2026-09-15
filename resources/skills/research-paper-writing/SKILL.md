---
name: research-paper-writing
description: Draft, revise and polish academic papers - abstract, introduction, related work, method, experiments, conclusion - and build them with LaTeX. Use when the user writes or edits a paper or thesis chapter, asks whether a passage reads well, wants notes or a draft in another language turned into publication-quality English, wants a reviewer-style critique before submission, or needs the LaTeX to compile.
aliases:
  - paper-writing
---

# Research papers

## Before editing

Read the whole draft (or the section and its neighbours) first. Find the venue's
template and page limit, the paper's single main claim, and the evidence for it.
Ask for any of these that you cannot find.

## Section by section

- **Abstract**: problem, gap, what was done, the main result with a number, why
  it matters. No citations, no undefined abbreviations.
- **Introduction**: context, the specific problem, why existing work falls short,
  the contribution as a short list, a pointer to the results.
- **Related work**: group by idea, not by paper; end each group by saying how
  this work differs.
- **Method**: enough to reproduce; define every symbol at first use; one notation
  throughout.
- **Experiments**: setup (data, baselines, metrics, seeds), main results table,
  ablations tied to claims, limitations. Every claim in the text points at a
  table or figure.
- **Conclusion**: what was shown and what remains, without new claims.

## Editing prose

- Keep the author's meaning; flag rather than silently change a claim.
- One idea per paragraph, topic sentence first; cut hedges that add nothing.
- Prefer active voice and concrete verbs; keep tense consistent.
- When translating a draft, translate meaning, then edit for how a native writer
  in the field would put it.
- Show changes as a diff (edit the .tex file) or, for pasted text, the revised
  paragraph followed by a short list of what changed and why.

## Review pass

Read as a critical reviewer and list: unsupported claims, missing baselines,
unclear contributions, notation clashes, figures that cannot be read in grey,
and anything over the page limit. Rank by how much each would hurt acceptance.

## LaTeX

- Build with `latexmk -pdf main.tex` (or `-xelatex` for non-Latin scripts) through
  bash; if latexmk is missing, run `pdflatex`, `bibtex`, then `pdflatex` twice.
- Fix errors from the first one in the log; warnings about undefined references
  usually vanish after the second run.
- Check the PDF with the pdf skill: page count, figures placed, references
  resolved (no `??`). Call `present_files` with the PDF.
