---
name: deep-research
description: Investigate a question thoroughly across many sources and write a report with citations. Use when the user asks for in-depth research, a comparison of options, a literature or market scan, fact-checking a claim from several angles, or a written briefing - not for a quick lookup one fetch can answer.
aliases:
  - research
---

# Deep research

## 1. Frame it

Write the question, what a useful answer looks like (a recommendation, a
comparison table, a timeline), the scope (dates, regions, sources to prefer or
avoid) and the depth wanted. If any of these would change the work and is not
clear, ask with the question tool first.

Break the question into three to six sub-questions and record them with the task
tool, one task each.

## 2. Gather

- MCode fetches pages with `webfetch` but has no search engine of its own. Start
  from sources the user named, official documentation, standards bodies, primary
  data (statistics offices, company filings, papers), and pages those sources
  link to. When you need a starting point you do not have, ask the user for
  links or search terms rather than inventing URLs.
- For wide questions, hand sub-questions to subagents with the actor tool
  (`spawn`, `subagent_type: "explore"`), each with its sub-question, the sources
  to start from, and what to report back: findings with the URL and a short
  quote for each. Bind each to its task with `task_id`. Keep working while they
  run; their results arrive as notifications.
- For every claim you intend to use, keep the URL, the date of the source and
  the exact supporting sentence.

## 3. Weigh

- Prefer primary sources over summaries of them, recent over old where things
  change, and independent sources that agree over a single loud one.
- When sources disagree, say so and explain which you trust more and why.
- Separate what the evidence shows from your own inference, and mark the latter.

## 4. Write the report

Save it as a Markdown file in the project (or the format asked for):

1. The answer, in a few sentences.
2. Findings, one section per sub-question, each claim followed by its citation
   `[n]`.
3. Disagreements and open questions.
4. Sources: a numbered list with title, publisher, date and URL.

Call `present_files` with the report. In the reply, give the answer and the two
or three findings that matter most; do not paste the whole report.
