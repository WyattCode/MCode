---
name: less-ai-tone
description: Clean the machine-written feel out of a finished piece of writing (去AI味, 去掉AI腔) by applying only the rules listed in this skill - stock openers and closers, reflexive contrasts, lists of three, dash and colon habits, inflated vocabulary, translationese, unsupported claims, recap paragraphs, chatbot framing. Text no rule matches is left exactly as it was, and the structure of the piece is never changed. Use after a draft is written, when the user asks to make it sound less like AI, more natural or more human, in Chinese or English.
aliases:
  - de-ai
  - humanize
---

# Less AI tone

This is a rewrite with a fixed list. Each rule below names a tell you can point
at in the text and says what to do with it. Change only what a rule catches.
Anything no rule catches stays word for word, and the piece keeps its
sections, their order, its argument and every fact in it. The goal is text
that no longer reads as generated, not text in your own voice: do not add
first-person asides, slang, jokes or choppy short paragraphs to make it seem
human.

## Before you start

1. Read the whole piece and name its genre: report, essay, speech, marketing
   copy, fiction, technical documentation, academic writing, a message. Several
   rules depend on it.
2. If the user gave a sample of their own writing or a style to follow, read
   it first. It decides what counts as the piece's normal punctuation,
   register and sentence length, and it wins over any rule here.
3. Work on a copy. Keep the original so the two can be compared at the end.

## The rules

Each rule: what to look for, and what to do. "Leave" lists what looks similar
but is not the tell.

### 1. Stock openers and closers

Look for: a first sentence that restates the question or announces the topic
("在当今快速发展的时代", "In today's fast-paced world",
"Let's dive in"), and a last paragraph that begins with a summing-up phrase
("总而言之", "综上所述", "In conclusion", "Overall") and says again what
was already said.

Do: start with the first sentence that carries information; end on the last
point that adds something. Delete the frame, not the content inside it - if
the closing paragraph holds a point made nowhere else, keep that sentence.

Leave: a summary the genre calls for (an abstract, an executive summary, the
conclusion section of a paper).

### 2. Signposting that announces instead of saying

Look for: "值得注意的是", "不难发现",
"It's worth noting that", "It is important to note", "Notably,".

Do: drop the phrase and state the point. If the point then feels unimportant,
it probably was; leave that judgment to the user and keep the sentence.

### 3. The reflexive contrast

Look for: "不是……而是……", "不仅仅是……更是……", "与其说……不如说……",
"It's not just X, it's Y", "This isn't about X - it's about Y", used where no
one had claimed X.

Do: state Y directly. Keep the contrast only where the text or its reader
actually holds the view being corrected. When the same pattern appears more
than twice in a piece, keep at most the strongest one.

### 4. Dashes, colons and quotation marks as a habit

Look for: a dash ("——", " - ", "—") used to set off an aside or a reveal in
sentence after sentence; a colon before a one-word or one-phrase payoff;
scare quotes around ordinary words.

Do: rewrite with ordinary sentence structure - a comma, a clause, or two
sentences. Keep dashes where the author's own writing uses them this way (see
"Before you start"); change only the excess.

### 5. Lists where prose was needed

Look for: groups of exactly three adjectives, nouns or clauses again and again
("高效、便捷、智能", "fast, reliable, and scalable"); bullet lists and bold
labels in what should be continuous prose; a heading over every two
paragraphs.

Do: keep the items that are specific, merge or drop the filler, and turn a
list back into sentences when the genre is prose. Keep lists that are real
lists (steps, requirements, an inventory) and the formatting the genre expects
(documentation, slides).

### 6. Inflated words

Look for, in Chinese: 赋能, 助力, 打造, 全方位, 至关重要, 不可或缺, 无缝, 画卷,
and words of the same kind. In English: delve,
tapestry, landscape (for a field), leverage, robust, seamless, pivotal,
crucial, vibrant, testament, realm, navigate (for anything but travel),
unlock, elevate, embark.

Do: use the plain word the sentence means, or drop the word if the sentence
stands without it. Keep a term that is the precise technical word in its field.

### 7. Translationese (Chinese)

Look for: "进行" before a verb ("进行分析" -> "分析"); "对……进行……";
unnecessary "被" passives; long chains of "的"; "一个" before every noun;
"通过……来……" where the means is obvious; sentences built on English
word order with the verb at the end of a long modifier.

Do: rewrite in natural Chinese word order with the same meaning. For literary
writing, judge against the piece's own style rather than against plain prose.

### 8. Claims without support

Look for: "研究表明", "众所周知", "Studies show",
"Experts agree", "Many people believe" with no study, data or expert named.

Do: if the text gives the source or figure elsewhere, attach it here. If it
gives none, soften to what the text can stand behind, or ask the user for
the source. Never invent a source, a number or a name.

### 9. Hedging and empty intensifiers

Look for: stacks of qualifiers ("在一定程度上可能会", "may potentially",
"somewhat arguably"); intensifiers that add nothing ("非常",
"truly", "incredibly", "extremely") on sentence after sentence.

Do: keep one qualifier where the uncertainty is real, drop the rest. Keep
intensifiers only where the emphasis is the point.

### 10. Chatbot framing

Look for: "希望以上内容对您有所帮助", "当然！", "好的，以下是",
"I hope this helps", "Feel free to ask", "Great question", any sentence
addressed to the person who asked for the text rather than to its reader.

Do: delete it. The text is for its readers, not a reply in a chat.

## What never changes

- Facts, figures, names, dates, quotations and citations.
- The order and division of sections, and what each paragraph argues.
- Technical terms, code, commands and anything inside quotation marks that is
  a quotation.
- Sentences no rule above matches, even if you would have written them
  differently.

## When you finish

1. Compare with the original. Every change must trace to a rule; undo any that
   does not.
2. Read the result once as its intended reader would. If a rewrite made a
   sentence less clear, put the original back.
3. Give the user the cleaned text, then a short list of what you changed,
   grouped by rule number, with a count for each. Say plainly if some rule
   matched nothing.

If the user wants a file changed rather than text in the reply, edit the file
and keep a copy of the original beside it unless they say not to.
