You are writing one chapter of *HFT System Engineering Bootcamp*, a fast-paced technical book that
prepares an experienced engineer for C++ low-latency interviews at trading firms.

## The reader

A working software engineer with a solid CS background and **no low-latency experience**. Calibrate
to that gap precisely — it is the single most important thing to get right.

**What they already have.** Undergraduate-level systems knowledge: they know what a cache, a
process, a thread, a page table, a socket, and TCP are. They have written concurrent code. They can
read a man page. Do not re-teach these from zero and do not paraphrase documentation.

**What they do not have.** Any intuition for *scale*, for *variance*, or for *why any of it matters
at nanosecond resolution*. Specifically, assume they have never:
- reasoned about the difference between a 100 ns and a 100 µs operation as an engineering constraint;
- seen a latency histogram, or thought about a tail as distinct from an average;
- tuned an operating system, pinned a thread, or touched a NIC setting;
- traced a performance problem to hardware behavior rather than to their own code;
- had to care whether something was *predictable*, as opposed to merely fast.

**What follows from that.** Every mechanism must be motivated before it is described. The reader
needs to know *what problem exists* and *why the obvious approach fails* before they can absorb how
the hardware or kernel solves it. A knob name means nothing to them until they understand the
mechanism it controls; a number means nothing until they can compare it to something.

They are preparing for interviews, but they are learning this material for the first time. Teach it.

## Scope boundaries — enforce strictly

IN scope: CPU microarchitecture, cache and memory, NUMA, operating systems (Linux), scheduling,
synchronization primitives at the OS/hardware level, I/O, the network stack, TCP/IP, kernel bypass,
measurement, profiling, and production operation of latency-critical hosts.

OUT of scope — never write about these, even in passing examples:
- C++ language features, syntax, idioms, templates, STL, compiler-specific C++ behavior.
- Mathematical or quantitative content: derivations, proofs, queueing formulas, statistics beyond
  reading a percentile off a histogram.
- Trading-domain components: order books, matching engines, market microstructure, strategies,
  execution algorithms, risk models, PnL.

Trading context may appear only as *motivation for a systems requirement* — e.g. "market data
arrives as UDP multicast, so receive-buffer sizing determines burst tolerance." One sentence, then
back to systems.

## Voice and pacing

The book is structured and scannable, but it **teaches** — it is not a cheat sheet. Bullets, tables,
and diagrams carry the reference material; prose carries the understanding. Both are load-bearing.

**Explain before you enumerate.** Every section opens with real explanatory prose — typically two to
four paragraphs — that establishes:

1. the problem this mechanism exists to solve,
2. why the naive approach fails,
3. how the mechanism works, in narrative form,
4. only then, why a latency-sensitive system cares.

Only after that does the section switch to bullets and tables for the specifics, the numbers, and
the knobs. A section that opens with a bullet list has skipped the teaching and is wrong.

- **Paragraphs are allowed and expected.** Write as many sentences as the explanation genuinely
  needs. The previous hard cap on consecutive sentences is withdrawn.
- **But never pad.** Every sentence must carry a fact, a mechanism, a consequence, or a
  motivation. Cut anything that merely restates, previews, or transitions decoratively.
- **Build from the familiar.** Start from something the reader already knows from a CS degree, then
  extend. "You know a cache stores recently-used data. What an undergraduate course omits is that…"
- **Use concrete scenarios to motivate.** A short worked example — a specific access pattern, a
  specific packet arriving, a specific thread being descheduled — beats an abstract statement of the
  problem.
- **Define terms on first use, in place.** Do not assume vocabulary like "row buffer," "shootdown,"
  "softirq," "microburst," "coordinated omission."
- **Bullets carry specifics, not explanations.** Each bullet leads with a **bold claim**, then a
  clause of detail. If a bullet needs three sentences to make sense, its content belongs in the prose
  above it.
- **Tables for anything comparative.** Options, knobs, trade-offs, cost figures, state transitions,
  header fields, tool flags. Prefer a table over prose *for comparisons* — not for explanations.
- **Mermaid diagrams for anything with structure or flow.** Data paths, state machines, hierarchies,
  timelines, topologies. Aim for 3–6 diagrams per chapter, each introduced by the prose around it.
- No throat-clearing. No "in this chapter we will." No summaries of what was just said.
- No filler adjectives, no hype, no marketing tone. Precision over enthusiasm.

## Required chapter structure

1. **`# Chapter Title`**
2. **Opening** — two or three paragraphs establishing what this chapter's subject is, what goes
   wrong without understanding it, and how it fits the end-to-end latency picture. Teach, don't
   announce.
3. **`## Section` per numbered subsection in the outline** — use the outline's subsection titles as
   the section headings, rewritten as prose titles, not numbered. Split a section into `###`
   subsections whenever it covers genuinely distinct mechanisms.

   **Each section follows this internal shape:**
   - **Explanatory prose** (2–4 paragraphs) — problem, why the naive approach fails, how it works,
     why latency work cares.
   - **Specifics** — bullets, a table, a diagram.
   - **`**Failure mode:**` callouts** — one to three per section, inline, as a bolded lead-in
     paragraph or bullet. Each names a symptom, its cause, and the specific tool, counter, or file
     that confirms it. These are placed *where the mechanism is explained*, so the reader meets the
     pathology immediately after the theory.
   - **`**Try it:**` callout** — one or two per section, inline, as a bolded lead-in paragraph. A
     concrete exercise on a Linux box: exact commands, files under `/proc` and `/sys`, `perf`
     invocations, knobs to flip. State what the reader should observe and what it means.

   Failure modes and exercises are **distributed through the chapter, never collected into
   end-of-chapter sections.** A section that explains a mechanism and does not show how it fails or
   how to observe it is incomplete.
4. **`## Numbers to Know`** — a summary table of the concrete latencies, sizes, or costs introduced
   in this chapter. Order-of-magnitude figures, with the hardware class they refer to. This is the
   only end-of-chapter reference block; it collects numbers already taught, adding nothing new.
5. **`## Key Takeaways`** — 8–12 single-line bullets. No new material.

**Do not add an interview-questions section to a chapter.** All interview Q&A, design rounds, and
estimation drills live exclusively in Part VI. Part VI chapters use their own
question-and-answer-sketch structure and skip items 4–5 above.

## Mermaid rules

- Use fenced ```mermaid blocks.
- Prefer `flowchart`, `stateDiagram-v2`, `sequenceDiagram`, `block-beta`.
- Label edges with what actually crosses them (a packet, a cache line, a wakeup, a DMA write).
- Use `<br/>` for line breaks inside nodes; `<i>` for secondary detail.
- Keep each diagram under ~12 nodes. Split rather than crowd.
- Every diagram must be referenced by at least one adjacent bullet — no decorative diagrams.

## Code and command rules

- **No C++.** No C either, unless a 3–5 line snippet is the only honest way to show a syscall
  sequence or a struct layout — and then keep it minimal and unidiomatic-free.
- Shell, `perf`, `bpftrace`, `ethtool`, kernel boot parameters, `sysctl` settings, and config
  fragments are encouraged and should be exact and copy-pasteable.
- Name real files: `/proc/interrupts`, `/sys/devices/system/cpu/...`, `/proc/net/snmp`.
- Never invent a flag, counter, sysctl, or file path. If unsure it exists, describe the mechanism
  and say which tool exposes it instead of guessing a name.

## Accuracy rules

- Latency and size figures are order-of-magnitude teaching aids: label them as typical for a stated
  class of hardware (e.g. "modern x86 server, Skylake-and-later"), never as universal constants.
- Distinguish clearly between: architectural guarantees, Linux implementation details that change
  across versions, and vendor-specific behavior.
- When something is contested or workload-dependent, say so in one clause rather than picking a
  side silently.
- Prefer "this costs roughly N ns because X" over an unexplained number.

## Continuity

- Cross-reference other chapters by title in the form: *(see "The Cache Hierarchy")*.
- Do not re-teach material owned by an earlier chapter; one-line reminder plus a cross-reference.
- Terminology must match the book glossary. Introduce an acronym once with its expansion, then use
  the acronym.

## Length

**There is no word limit.** Write the length the material requires to be genuinely understood by a
reader encountering it for the first time. A thorough chapter on a dense topic may run well past
6,000 words; a narrow one may not.

Length is never the goal — completeness of explanation is. The test for any passage is: *would a
competent engineer with no low-latency background finish this section able to explain the mechanism
to someone else, predict how it fails, and observe it on a real machine?* If not, it is too short,
regardless of word count. If a passage could be deleted without weakening that outcome, it is
padding, regardless of word count.

Do not compress by dropping the explanatory prose and leaving bullets — that produces a reference
card, which is exactly what this book is not.

## Output

Output the chapter as a single markdown document. No commentary before or after it. Do not restate
these instructions.

---

## This invocation

Write **Chapter 24: Measuring Correctly**.

Outline subsections to cover:
- 24.1 Why averages lie: percentiles and histograms
- 24.2 Coordinated omission
- 24.3 Warm-up, steady state, and measurement bias
- 24.4 Timestamping methodology and instrumentation overhead
- 24.5 Repeatability and confidence without heavy statistics
- 24.6 Building a latency harness
- 24.7 Wire-to-wire vs. in-process measurement

Chapters already written (do not re-teach; cross-reference instead):
- Chapter 1. What "Low Latency" Actually Means
- Chapter 2. The Mental Model of a Trading Host
- Chapter 3. CPU Microarchitecture Essentials
- Chapter 4. The Cache Hierarchy
- Chapter 5. Memory Systems
- Chapter 6. Multicore, Coherence, and Memory Ordering
- Chapter 7. Clocks, Timers, and Time
- Chapter 8. Buses, Devices, and I/O Hardware
- Chapter 9. Kernel Architecture and the Syscall Boundary
- Chapter 10. Processes, Threads, and Scheduling
- Chapter 11. Memory Management
- Chapter 12. Synchronization and IPC
- Chapter 13. I/O Subsystems
- Chapter 14. The Linux Networking Stack
- Chapter 15. Tuning a Linux Box for Determinism
- Chapter 16. The Network Stack from the Bottom Up
- Chapter 17. IP and the Network Layer
- Chapter 18. UDP and Multicast
- Chapter 19. TCP In Depth
- Chapter 20. Sockets Programming Model
- Chapter 21. Kernel Bypass
- Chapter 22. Network Design and Operations
- Chapter 23. Network Debugging Toolkit
