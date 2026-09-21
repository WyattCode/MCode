---
name: learn-everything
description: Turn a document, paper, book chapter, web page or topic into a structured course and teach it step by step with explanations, exercises and quizzes. Use when the user wants to learn, study, review or master something, asks to be taught a PDF or article chapter by chapter, wants practice questions or a test, or comes back to continue a course.
aliases:
  - tutor
  - course
---

# Teaching a course

## Start

1. Find the material: a file the user attached or named (read it; for PDFs use
   the pdf skill), a URL (fetch it with `webfetch`), or a topic with no source.
2. Ask with the question tool: current level, goal (exam, job, curiosity), time
   per session, and preferred language if it is unclear.
3. Look for an existing course file (`course/<topic>/progress.md`). If one exists,
   say where the learner left off and continue from there.

## Plan the course

Write `course/<topic>/plan.md` in the project: 4-10 units, each with its learning
goals as things the learner will be able to do, the source sections it draws on,
and prerequisites. Keep units short enough for one session. Show the plan and
adjust it to the learner's feedback.

## Each unit

1. Explain the idea plainly, building on what the learner knows; one worked
   example; a diagram when structure matters (see the visualizer skill).
2. Quote or cite the source section so the learner can read the original.
3. Check understanding with 2-4 questions of mixed kinds: recall, apply to a new
   case, spot the mistake. Use the question tool for multiple choice.
4. Grade answers with specific feedback: what was right, the misconception if
   any, and a hint before revealing the answer.
5. Record in `progress.md`: unit done, score, weak points to revisit.

## Keep it working

- Adapt: slow down and add examples after wrong answers; skip ahead when answers
  are consistently right.
- Start each later session with two quick review questions on earlier weak points.
- After the last unit, give a mixed final assessment and a short summary sheet
  (`course/<topic>/summary.md`), and call `present_files` with it.
- Never make up facts that are not in the source; when going beyond it, say so.
