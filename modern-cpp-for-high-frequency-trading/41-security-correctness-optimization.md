# Chapter 41 — Security and Correctness Under Optimization

An optimized parser is fast only while its assumptions hold. Network input can violate lengths, alignment, tags, sequence rules, and complexity expectations; the C++ optimizer can then exploit undefined behavior more aggressively than a packet capture suggests. Security adds a second dimension: architecturally rejected data may still influence speculative microarchitectural state, and ordinary string comparison can leak secret-dependent timing. This chapter preserves validation while making its work bounded, then shows how sanitizers, static analysis, and fuzzing complement rather than replace a production correctness contract.

## 41.1 Packet Lengths, Wraparound, Alignment, and Invalid Fields

An input parser must validate every byte range before creating a typed access or copying from it. The safe predicate proves both the offset and requested length lie within the received buffer without overflowing arithmetic.

```cpp
#include <cstddef>
#include <span>

bool contains(std::span<const std::byte> packet,
              std::size_t offset,
              std::size_t length) noexcept {
    return offset <= packet.size() &&
           length <= packet.size() - offset;
}
```

The apparently equivalent `offset + length <= packet.size()` can wrap because unsigned arithmetic is modulo. Using a wider intermediate helps only if that type is provably wide enough for all inputs and later conversions. Subtraction after proving `offset <= size` avoids underflow.

Validate the enclosing header before reading its length field. Then validate that length against protocol minimum, maximum, remaining bytes, and message-specific layout. A received datagram length, transport framing length, and embedded message length are separate claims and can disagree.

Network bytes do not automatically satisfy C++ alignment or object-lifetime requirements. Reinterpreting `packet.data() + 1` as a `Header*` can be misaligned and can violate aliasing and lifetime rules. Decode integers from bytes, or copy into a suitably aligned trivially copyable local and convert endianness. `std::bit_cast` requires equal-sized complete objects; it does not perform a checked short read or byte swap.

Invalid enumeration tags, booleans, floating representations, string encodings, counts, and reserved bits need explicit rejection. A `static_cast<MessageType>(raw)` can create a value not named by an enumerator; a `switch` default still matters. Never use an invalid tag to index a dispatch table before checking its range.

Counts create multiplication and allocation hazards. If a header says there are `count` entries of `width` bytes, prove `count <= maximum`, prove the product without overflow, and prove the resulting range remains in the enclosing message. Do not allocate `count` elements before validating those facts.

```cpp
#include <limits>

bool checked_product(std::size_t a, std::size_t b,
                     std::size_t& result) noexcept {
    if (a != 0 && b > std::numeric_limits<std::size_t>::max() / a)
        return false;
    result = a * b;
    return true;
}
```

Even a non-overflowing value may exceed the protocol or resource budget, so arithmetic safety precedes policy validation rather than replacing it.

Keep wire types separate from domain types. A decoded `RawPrice` is not a valid `Price` until tick range, sign, scale, and venue rules pass. Factories returning `std::expected<ValidatedMessage, ParseError>` can make invalid construction unavailable, though representation and library support belong to the interface design in Chapter 9.

Parsing work should be monotonic: each successful validation advances a bounded cursor, and failures terminate through a bounded error path. Do not log the full hostile packet synchronously. Increment a reason counter and copy a capped diagnostic prefix to a cold-path buffer.

Nested encodings need a depth limit even when every local length is valid. Recursive TLV, compression, and envelope formats can otherwise overflow the call stack or create exponential expansion. Prefer iterative parsing with an explicit fixed-capacity work stack and reject depth or decompressed size beyond the contract.

Compile with conversion and bounds warnings, run sanitizers, and fuzz near every boundary: zero, minimum minus one, maximum, maximum plus one, and arithmetic limits. Test the optimized build because undefined behavior can disappear or change form under optimization.

## 41.2 Hash-Collision Pathologies

A hash table's expected constant-time lookup depends on key distribution and hash quality. The C++ unordered containers specify average-case expectations under their model, while a bucket containing many colliding keys requires linear work in that bucket. An adversary or pathological feed can turn a convenient map into a CPU denial of service.

Collision risk comes from several sources: a weak hash, structured keys with ignored fields, implementation-known hashing, untrusted strings, or a load factor allowed to grow too far. Reserving capacity prevents rehash at a known size but does not repair collisions.

```cpp
struct BrokenHash {
    std::size_t operator()(std::uint64_t) const noexcept {
        return 0; // every key enters one bucket
    }
};
```

With this hash, `find`, insert, and erase traverse an increasing chain or equivalent collision structure. Memory remains allocated across buckets and nodes while useful locality collapses. Tail work grows with attacker-controlled cardinality.

For bounded numeric domains, direct addressing, dense vectors, sorted flat containers, radix structures, or a fixed-capacity open-addressed table can give more explicit limits. Each trades memory, mutation cost, and maximum capacity. An order-ID table may use a high-quality keyed hash to make deliberate collision construction difficult, plus a hard entry limit and probe bound.

Open addressing avoids per-node allocation but does not eliminate pathology. High load factors lengthen probe clusters, deletions create tombstones, and an unsuccessful lookup can scan many slots. Robin Hood or displacement strategies improve distributions under assumptions but need bounded-capacity analysis. State the maximum probes the production path permits.

Node-based tables add pointer chasing and allocator work. Under collision, they can repeatedly miss in cache while performing equality checks on attacker-controlled long strings. Bound key length before hashing and equality, and consider storing a fixed digest plus a separately owned validated key.

A randomized or keyed hash protects against precomputed adversarial keys only if the seed is secret enough, generated correctly, and not leaked through diagnostics. Cryptographic-strength hashing costs more instructions than identity hashing; use it where the input threat requires it rather than for every internal integer map.

Overflow policy is part of defense. If a fixed probe limit is exceeded, reject, route to a slower isolated structure, or rebuild under a new seed. The slow path must itself be bounded and observable without flooding logs.

Verify with generated colliding and same-bucket keys for the deployed hash and container, not only random inputs. Measure maximum probes, comparisons, allocations, and cache misses. Fuzzing rarely discovers deep collision sets without a structure-aware generator, so add them as explicit tests.

Hash flooding can also target observability labels, session caches, replay deduplication, and JSON/control-plane maps rather than the feed parser. Inventory every untrusted-key table. A cold administrative endpoint can still exhaust CPU or heap shared with the trading process.

Record collision or probe histograms with bounded local counters, and alert before the hard limit is reached. Do not log every colliding key; that converts a hash attack into a logging attack.

## 41.3 Protocol State-Machine Validation

A protocol parser validates bytes; a **state machine** validates whether a syntactically valid message is legal now. Authentication, login, sequence recovery, trading session state, and order lifecycle all require temporal rules.

```text
disconnected -> connected -> authenticated -> synchronized -> active
       ^              |            |              |
       +--------------+--failure---+--logout------+
```

Define states and events as bounded enums, then make every pair resolve to an explicit transition or rejection. A default “accept and continue” hides new message types and invalid orderings. Unknown protocol versions should enter a negotiated compatibility path or fail closed according to the interface contract.

Validation order matters. Check framing and message authentication before using payload fields. Check session identity and sequence before mutating the book. Check an order exists and belongs to the session before applying cancel or replace. A duplicate replay must not repeat a non-idempotent state change.

Apply a transition transactionally: validate all preconditions, compute the new state, then publish it. If validation mutates counters, indexes, or queues incrementally and later fails, rollback becomes another state machine. Staging a small decoded command value before touching shared state often simplifies both safety and latency bounds.

Concurrency needs one owner or one synchronization protocol. If a session thread validates sequence while a recovery thread mutates the same state, two individually correct transitions can interleave illegally. Thread confinement plus bounded commands is often simpler than a mutex around half of the state. Snapshots sent to monitoring are observations, not alternate mutation paths.

Authentication state must not be inferred from transport state. A connected socket is not an authenticated session; a resumed TCP connection does not restore application sequence; a replayed authenticated packet may still be stale. Bind the authenticated peer, negotiated protocol version, session epoch, and sequence domain in state.

Sequence arithmetic needs defined wrap behavior from the protocol. Comparing raw unsigned values with `<` is not automatically correct across wrap. Use a protocol-specific modular comparison only when the sequence space and maximum distance make it unambiguous.

State failure policy distinguishes malformed peer input, local corruption, recoverable gaps, authentication failure, and version mismatch. Recovery may request replay; security failure may close and rate-limit; local invariant failure may stop trading. Do not merge them into one retry loop.

Model-based tests should enumerate all state/event pairs. Fuzz sequences, not only single packets, and assert invariants after every step. Log transition IDs and sequence values in bounded binary form so postmortem analysis can reconstruct the path.

Generate the transition table from one reviewed specification or test the hand-written table for completeness at compile time. A new enum value should fail compilation or a completeness test, not fall into permissive default behavior. Negative tests should assert state remains unchanged after every rejected event.

Crash recovery is another transition. Persistent “active” state read after restart may describe a connection that no longer exists. Version stored state, distinguish committed from in-progress updates, and rebuild volatile relationships from authoritative sources.

## 41.4 Speculation Around Bounds Checks

An architectural bounds check prevents an out-of-range load from retiring, but a CPU may **speculatively execute** a predicted path before the condition resolves. If the speculative load influences cache state, later timing can reveal information even though architectural state rolls back. Spectre-v1-style attacks exploit this distinction.

```cpp
if (index < public_size) {
    const auto secret = private_data[index];
    probe[secret * stride]++; // speculative cache effect can encode secret
}
```

The ordinary check remains required for C++ correctness. Removing it, adding undefined behavior, or relying on a fault makes both security and optimization worse. A compiler is also free to transform source control flow while preserving architectural semantics; C++ has no general portable “do not speculate this load” guarantee.

Mitigations include preventing untrusted indexes from selecting secret data, isolating secrets in another address space, data-dependent index masking under a proven scheme, speculation barriers, and compiler-supported speculative-load hardening. The correct sequence is architecture, compiler, and threat-model specific. On x86 and ARM64, barrier instructions and their exact ordering/coverage differ.

Separate Spectre variants and other transient-execution issues. Indirect-branch target injection, return prediction, store bypass, and privilege-boundary attacks have different mitigations. Retpolines or branch-target controls do not automatically fix an in-process bounds-check bypass. Use the platform's current security guidance rather than one generic “Spectre fixed” flag.

Process separation can place secrets outside the attacker's address space, reducing one class of gadget, while shared libraries, shared memory, and kernel interfaces remain considerations. It adds IPC, scheduling, and operational complexity. This is a security architecture decision that must be measured, not an instruction-level patch.

Branchless clamping is not automatically safe. If an invalid index becomes zero, an attacker may still learn element zero or influence later accesses. Mask generation must not itself invoke undefined shifts, overflow, or compiler transformations that break the intended dependency.

Mitigations cost front-end bandwidth, inhibit instruction-level parallelism, add dependencies, or increase syscalls/process separation. Apply them at trust boundaries after identifying the secret and attacker-controlled value. Avoid globally disabling speculation without measuring and understanding platform guidance.

Verify source, optimized assembly, and behavior on every supported compiler/architecture. Use vendor and compiler mitigation documentation and regression tests that flag code-generation changes. Timing tests can support evidence but cannot prove the absence of every microarchitectural channel.

The threat model identifies who runs code and where. A remote packet sender has less direct timing resolution than an untrusted colocated process, plugin, or strategy module, but repeated requests and amplification can compensate. Cloud or shared-host deployment changes assumptions about sibling cores and caches.

Performance tests must retain mitigations. Benchmarking with barriers removed answers a different security contract. Record microcode, firmware, kernel mitigation state, compiler flags, and SMT policy with results because each can change instruction and cache behavior.

## 41.5 Constant-Time Processing for Secrets

A **constant-time** operation avoids secret-dependent control flow, memory addresses, and variable-latency behavior within a defined leakage model. It is needed for cryptographic keys, authentication tags, tokens, and other secrets—not for ordinary public market prices.

An early-exit comparison leaks the position of the first mismatch:

```cpp
// BROKEN for secret authentication tags.
bool equal(std::span<const std::byte> a,
           std::span<const std::byte> b) {
    if (a.size() != b.size()) return false;
    for (std::size_t i = 0; i != a.size(); ++i)
        if (a[i] != b[i]) return false;
    return true;
}
```

A loop that accumulates differences avoids early source branches, but the compiler may transform it, lengths may remain secret-dependent, and surrounding error behavior can leak. Use a vetted cryptographic library's constant-time primitive for tag comparison rather than inventing one from a code sketch.

`volatile` does not create constant-time code. It constrains selected observable accesses in the C++ abstract machine but neither prevents secret-dependent branches nor defines cache behavior. Likewise, an optimization level of zero is not a security mitigation and produces different variable-latency code.

Error handling must be uniform where the protocol requires it. Returning “unknown user” faster than “bad password,” sending different packet lengths, or rate-limiting only one failure creates an oracle outside the comparison loop. Constant-time primitive use is one component of an end-to-end response policy.

Constant-time does not mean one universal cycle count. Public input length, interrupts, cache conflicts, and scheduling can vary. The contract is that selected secret values do not influence observable execution features within the model. State whether length is public and which local or remote attacker is considered.

Table lookups indexed by secret bytes, secret-dependent allocation, big-integer algorithms with data-dependent loops, and distinct error messages all leak. Prefetching a table does not make the address pattern constant. Network noise reduces signal quality but repeated queries can recover weak leakage.

Speculative execution adds channels beyond ordinary constant-time source. Cryptographic libraries track platform mitigations and assembly details across compilers. Keep them patched and do not enable “fast” build flags that violate their documented contract.

Verification includes assembly review, statistical timing tools, fixed CPU and power conditions for lab sensitivity, and differential tests across secret classes. Passing a timing test is evidence, not proof; code review and use of audited primitives remain primary.

Compiler upgrades, LTO, PGO, and target-feature changes can transform code. Pin reviewed builds, rerun constant-time checks on final linked artifacts, and preserve compiler identity. Source packages that provide hand-written assembly may select different implementations at runtime based on CPU features; each selected path needs support evidence.

Memory clearing is related but separate. The compiler may remove an ordinary `memset` whose result is never observed. Use a documented secure-erasure facility supplied by the platform or library, understand copies that may remain, and minimize secret lifetime and replication rather than relying on one wipe.

## 41.6 Validation Cost Versus Failure Risk

Validation consumes instructions and branches, but skipping it transfers attacker-controlled assumptions into memory safety, state corruption, and unbounded work. The meaningful optimization question is how to validate once, early, and with bounded failure handling.

Layer checks from cheapest to more expensive:

1. verify minimum framing and bounded total length;
2. validate version, type, and fixed reserved bits;
3. validate message-specific lengths and counts;
4. authenticate or checksum as required by the protocol;
5. validate session and sequence state;
6. apply the already-validated command.

This order is not universal: authentication may need to precede parsing sensitive fields, and a constant-time failure policy may forbid observable early distinctions. Derive it from the threat and protocol contract.

Checks can aid optimization. Once a length is proven, a bounded loop can vectorize; once a tag range is proven, dispatch can use a compact table. Express invariants in ordinary defined C++, not an unchecked compiler assumption reachable by hostile input. `assert` is for programmer invariants and may disappear under `NDEBUG`; it is not input validation.

Avoid validating the same raw bytes independently in several layers. Produce a typed validated representation with explicit ownership, then prevent construction except through the validator. The type boundary documents which checks have occurred.

A useful split is `FramedMessage`, `AuthenticatedMessage`, and `SessionCommand`. Each constructor or factory consumes the prior stage and adds an invariant. Do not expose raw constructors that let tests or “fast paths” skip stages. The small wrapper types can compile away while their type distinctions remain compile-time constraints.

Caching validation results is safe only while the underlying bytes and context remain unchanged. A `span` into a recycled packet cannot carry a permanent “validated” flag. Authentication can depend on session keys or epochs, and authorization can change. Ownership and invalidation belong in the validated type.

Failure paths need budgets. Hashing or hex-dumping a megabyte malformed frame is attacker-controlled work. Cap recorded bytes, rate-limit by stable source identity where safe, aggregate repeated reasons, and close or shed according to policy.

Benchmark valid traffic and each rejection class with realistic distributions. Count branches, bytes touched, and worst-case loops. A favorable average dominated by valid minimum-size messages does not establish resistance to maximum-size invalid input.

Rate limits and byte budgets bound aggregate attacker work. Track bytes validated, decompressed output, messages per connection, outstanding handshakes, and recovery requests. Limits should be enforced before allocating corresponding resources and should have monotonic clocks and overflow-safe counters.

Failure response itself can amplify traffic. Sending a detailed error for every malformed datagram creates reflection and egress load. Some protocols should silently drop invalid unauthenticated input while incrementing local bounded telemetry. Apply the protocol and threat model, not a universal “always reply” rule.

## 41.7 Address, Undefined-Behavior, Thread, and Memory Sanitizers

Sanitizers instrument a program and link runtime support to detect selected dynamic violations. They observe executed paths under an altered memory layout and schedule; none proves a program bug-free.

**AddressSanitizer** (ASan) detects many out-of-bounds and use-after-free errors using shadow memory, red zones, and allocation interception. Quarantine and changed layout can expose or hide timing-sensitive reuse. On Linux, leak detection is commonly available through associated LeakSanitizer support, subject to toolchain configuration.

ASan does not detect every intra-object overwrite, uninitialized read, data race, or temporal error after memory is unpoisoned/reused. Custom allocators can hide object boundaries unless they integrate poisoning interfaces. Stack-use-after-return detection has compiler/runtime modes with different coverage and overhead.

**UndefinedBehaviorSanitizer** (UBSan) inserts checks for selected undefined operations such as misalignment, signed overflow, invalid shifts, and some bounds/type errors. The `undefined` group does not enable every integer-conversion or unsigned-overflow diagnostic; choose explicit groups based on the code. Recovery mode continues after reports where supported; trap mode removes much reporting machinery but changes failure behavior.

Some UBSan checks diagnose suspicious but defined behavior when explicitly enabled, such as selected implicit conversions or unsigned overflow. Treat reports according to the enabled check, not the tool's umbrella name. `-fno-sanitize-recover` can stop after a report; continuing through corrupted state may create misleading secondary failures.

**ThreadSanitizer** (TSan) instruments memory and synchronization to detect data races. It requires broad instrumentation and substantial virtual/real memory. It can miss logical races that use atomics legally, protocol bugs, or paths not executed. Custom assembly and uninstrumented libraries need annotations or integration; suppressing them can hide real synchronization.

TSan understands a model of supported synchronization, not every device, shared-memory peer, kernel-bypass queue, or custom futex scheme. Annotate only after proving the protocol. A suppression can remove the happens-before evidence TSan needs and cause both missed races and confusing secondary reports.

**MemorySanitizer** (MSan) tracks initializedness and origins. It generally requires instrumenting dependent code and libraries; uninstrumented boundaries can produce false results unless intercepted or annotated. Its support is narrower than ASan/UBSan. Do not confuse it with ASan: uninitialized reads and invalid-address accesses are different classes.

```sh
clang++ -std=c++23 -O1 -g -fno-omit-frame-pointer \
    -fsanitize=address,undefined parser.cpp -o parser-asan
clang++ -std=c++23 -O1 -g -fsanitize=thread queue.cpp -o queue-tsan
clang++ -std=c++23 -O1 -g -fsanitize=memory -fsanitize-memory-track-origins \
    parser.cpp -o parser-msan
```

Tool combinations and platform support vary; TSan is normally a separate build from ASan, and MSan needs an instrumented ecosystem. Consult the exact compiler version.

Sanitizer configuration is part of test semantics. ASan use-after-return and initialization-order checks, UBSan recovery/trap modes, MSan origin tracking, and TSan history settings change coverage, memory, and report quality. Store runtime options in the test invocation rather than relying on developer shell defaults.

A practical CI matrix separates jobs:

```text
ASan + selected UBSan checks: unit, parser corpus, integration
UBSan trap/recovery variants: optimized boundary and arithmetic suite
TSan: bounded multithreaded queues, shutdown, publication tests
MSan: parser/library closure built with compatible instrumentation
fuzz workers: ASan/UBSan continuously; periodic MSan and state targets
```

Do not assume one successful combined build covers incompatible or disabled checks. Print the compiler version and sanitizer runtime options at job start, and retain the complete command line.

Reports at foreign-function boundaries need analysis. A kernel fills an output buffer according to a syscall contract; inline assembly may initialize bytes the tool cannot infer; DMA updates memory outside normal instrumentation. Use documented unpoisoning or annotations only after validating returned lengths, completion ordering, and ownership. Annotating a whole buffer initialized before hardware completion hides a real race.

Custom pools should cooperate with ASan poisoning where practical: poison free slots, unpoison the exact live object at construction, and re-poison after destruction. The hooks are toolchain-specific and stay in the allocator/test integration layer. The production lifetime protocol must remain valid without them.

When a report appears only at `-O2`, keep it. Optimization can expose a path, inline enough context for a check, or exploit earlier undefined behavior. Reduce the input without reducing optimization level first. Inspect the first report before secondary corruption, and avoid broad ignorelists used merely to make CI green.

Sanitizer resource limits also need dedicated settings. TSan and MSan map large shadow regions, ASan quarantine consumes memory, and fuzz workers multiply processes. A cgroup limit sized for the release binary can kill the test before it reaches the target path. Raise limits in an isolated CI scope while retaining per-input caps, then distinguish an instrumentation-capacity failure from an input-driven leak. Never copy those enlarged limits into production automatically. Test infrastructure should remain disposable and hold no trading credentials because sanitizer runtimes are not hardened for hostile deployment.

Record peak memory, virtual mappings, termination reason, and completed corpus units so infrastructure exhaustion remains diagnosable and reproducible.

Sanitizer runtimes are testing tools, not hardened production dependencies. They add checks, metadata, allocations, interceptors, signal handling, and large memory overhead. Their latency results do not predict production. Run unit, integration, fuzz, and replay suites under separate sanitizer configurations, symbolize reports with matching binaries, and treat suppressions as reviewed debt with owners.

Build all relevant translation units consistently. Mixing sanitized application code with uninstrumented plugins can leave blind spots; MSan is especially demanding about the dependency closure. Keep one small unsanitized boundary only when required by tool documentation, wrap it, validate inputs/outputs, and test it separately.

Sanitizer failures need reproducible artifacts: exact input, random seed, binary build ID, runtime options, environment, and unsymbolized addresses when symbolization may change. Do not paste only the top frame into an issue and discard the triggering corpus.

## 41.8 Static Analysis

**Static analysis** examines source, intermediate representation, or binaries without requiring one concrete execution. Compiler warnings, dataflow analyzers, linters, and security-specific checkers find different classes of defect.

Start with high-signal compiler diagnostics and make intentional conversions explicit. Warnings for sign conversion, truncation, shadowing, uninitialized values, switch coverage, format types, and suspicious lifetime patterns catch parser defects cheaply. Warning sets change across compiler versions, so pin versions and review new findings during upgrades.

Path-sensitive analyzers can track nullability, ownership, use-after-move, double close, lock state, and tainted lengths through branches. They face state explosion and model libraries imperfectly. An absence of warnings is not a proof, while a false positive should be resolved through clearer code or a narrow documented suppression.

Linters operate at another layer. They enforce banned APIs, safer span use, explicit ownership, naming, and project policies. Compiler warnings see instantiated code and optimization facts; a source linter can see intent and API shape. Run more than one compiler because GCC and Clang diagnose different constructs.

Binary hardening checks inspect the linked artifact for PIE, non-executable stack, relocation protection, symbol exposure, and control-flow features. They do not validate parser logic. Static analysis coverage ends where generated assembly, inline assembly, or an external library begins unless the tool has a model.

Annotations improve results only when true. Marking a function `noexcept`, non-null, pure, or bounds-safe to silence a tool changes the human contract and sometimes optimization. Never assert an invariant that hostile input can violate.

Static analysis is particularly effective on cold failure paths that tests rarely execute: allocation failure, partial initialization, duplicate cleanup, and integer conversion. Run it on generated code only when the generator or model can be fixed; blanket suppression creates a blind region at trust boundaries.

Integrate findings into review with stable fingerprints, severity, source owner, and expiration for suppressions. Diff-based gating controls noise, but periodically rescan the whole baseline. Security rules should identify the threat and coding standard rather than rely on a tool's default severity name.

Analysis consumes CPU and memory in CI. Sharding by translation unit is useful, but whole-program ownership and cross-module dataflow may require a linked analysis phase. Cache results by compiler/tool version and inputs without reusing stale findings after configuration or generated headers change.

Verify analyzer usefulness with seeded test defects and historical bugs. If it cannot see through a custom span, allocator, or atomic wrapper, add models or simplify the abstraction before trusting its clean report.

## 41.9 Fuzzing Parsers and State Machines

**Fuzzing** generates or mutates inputs and executes the target while monitoring for crashes, sanitizer reports, hangs, excessive resource use, and violated assertions. Coverage-guided fuzzers retain inputs that reach new control-flow regions.

A parser target should accept raw bytes without network, filesystem, logging, or wall-clock dependencies. The following is an excerpt: `Parser` and `check_parser_invariants` are supplied by the component under test.

```cpp
#include <cstddef>
#include <cstdint>
#include <span>

extern "C" int LLVMFuzzerTestOneInput(const std::uint8_t* data,
                                      std::size_t size) {
    Parser parser;
    const auto result = parser.parse(
        std::as_bytes(std::span{data, size}));
    check_parser_invariants(result);
    return 0;
}
```

The example assumes constructors and invariant checks are bounded. A new parser per input improves isolation but may hide persistent-state bugs; use a separate stateful target for sessions.

Seed corpora with valid messages, every message type, boundary lengths, recovery messages, and historical failures. Dictionaries expose field tags and magic bytes. Structure-aware mutators can update framing lengths or checksums so mutations reach deeper semantic states rather than failing the first byte check.

Coverage is a guide, not the objective. A target can achieve high edge coverage while never producing a valid authenticated transition or a long collision chain. Add semantic counters—states reached, error classes, maximum nesting, probe length—and feed interesting examples back to the corpus.

Checksums and MACs block random mutation from deep parsing. In a parser-only target, expose a test seam that recomputes a non-secret checksum after mutation. Authentication code needs separate tests that retain its security semantics; do not ship the bypass or let a fuzz-only macro alter production parsing logic beyond a clearly isolated harness adapter.

State machines need sequence fuzzing. Encode a list of actions—connect, authenticate, message, gap, replay, disconnect—and cap the list length. After every action, check ownership, sequence, resource, and risk invariants. Reset state between test cases so one input remains reproducible.

Run separate ASan/UBSan, MSan where viable, and TSan concurrency targets. Fuzzers perturb timing but do not systematically prove lock-free schedules. Add deterministic concurrency tests and model checking for small protocols.

Treat timeout and out-of-memory as findings when one bounded input can cause them. Set per-input limits and remove external retries. Minimize crashes, store the exact binary/build metadata, and add the minimized input as a regression test before fixing.

Isolation protects the fuzzing host from leaks and process termination. Run workers with resource limits, no production credentials, disposable storage, and network disabled unless the target explicitly requires it. Sanitizer output and cores can contain corpus bytes, which may derive from confidential captures; sanitize the corpus before external sharing.

Minimization must preserve the relevant oracle. A smallest crashing byte string is useful for memory safety; a timing or state-machine bug may require a schedule, action sequence, or environment. Store those dimensions alongside the bytes.

Differential fuzzing compares a new decoder with a trusted reference or round-trip encoder. Agreement does not prove either correct, but disagreement finds semantic edge cases beyond memory crashes. Compare error categories and state transitions, not pointer-rich object bytes.

## 41.10 Instrumented Versus Production Behavior

An instrumented binary is a different program for performance purposes. It has extra loads, stores, branches, metadata, runtime calls, mappings, allocator behavior, and often different inlining and layout. It is invaluable for finding bugs and invalid for claiming production latency.

Instrumentation can alter concurrency. TSan delays accesses and intercepts synchronization; ASan changes object spacing and reuse; coverage counters add shared writes; logging changes scheduling. A race disappearing under TSan is not evidence of correctness, and one appearing under altered timing still deserves memory-model analysis.

Optimization changes semantics only when the source already has undefined or unspecified dependencies, but it changes timing and layout even for correct code. `-O0` can keep values in memory, suppress vectorization, and preserve call frames; `-O3` can inline, unroll, vectorize, and delete dead checks whose preconditions are assumed. Test both for different purposes.

Maintain a build matrix with distinct purposes:

| Build | Purpose | Not evidence for |
|---|---|---|
| ASan/UBSan | memory and selected UB tests | production memory/latency |
| TSan | dynamic race detection | throughput or lock fairness |
| MSan | uninitialized-data tests | normal address-space footprint |
| coverage/fuzz | path discovery | production branch behavior |
| hardened release | deployment safety controls | source-line diagnostics alone |
| performance release | target latency measurement | sanitizer cleanliness alone |

The production build must retain input checks, ownership, synchronization, and security mitigations. Do not compile away validation under a “fast” macro. Assertions that protect only internal impossible states can terminate or be omitted according to policy, but external input conditions remain ordinary control flow.

Keep semantic equivalence testable. Run the same deterministic corpus through sanitizer and release builds and compare accepted messages, rejection reasons, state transitions, and output hashes. Differences can reveal undefined behavior, conditional compilation drift, or instrumentation-specific paths.

Avoid `#ifdef SANITIZER` changes to core algorithms. When a platform primitive cannot be instrumented, isolate it behind the same interface and supply a faithful test implementation. The sanitized build must exercise the same validation and ownership states, not a simplified parser.

Release verification includes warnings, static analysis, hardened compiler/linker settings chosen for the threat model, symbol/build-ID retention, fuzz regressions, and latency measurement. PGO and LTO can transform layout and speculation; rerun assembly/security review at the final link artifact.

Hardening settings have performance and compatibility costs. Stack protectors, control-flow integrity, fortified library calls, relocation binding, and speculation mitigations cover different threats. Select them from deployable toolchain/platform support, measure the final artifact, and document exceptions. Removing a protection to win a benchmark requires a security review, not a local micro-optimization.

Production sampling can use hardware counters, bounded flight events, and externally attached tracing with measured overhead. Canary deployment and shadow replay expand environmental coverage without linking test runtimes into every process. Define data handling carefully: production traffic may contain secrets and client information.

Correctness tools form overlapping evidence. A parser accepted for production has a written input contract, bounded algorithms, reviewed optimized code, sanitizer-clean executed suites, static-analysis disposition, sustained fuzzing, and operational failure telemetry. No single green dashboard replaces that argument.

Rollout continues verification. Canary instances process bounded traffic; shadow decoders compare results without controlling orders; feature flags can fail closed to the previous reviewed path. Rollback must understand schema and state compatibility. A security fix that cannot be disabled safely should stop traffic rather than revert to a known vulnerable parser.

A concrete hardened decode path brings the chapter together. The receiver supplies an immutable span whose length came from the syscall, plus interface/channel metadata. The framer validates a fixed minimum and bounded total length with subtraction-based arithmetic. It copies or decodes fixed fields without unaligned typed access, rejects unknown version and type values, and proves every count/product. A message-specific decoder produces a value whose constructor is inaccessible outside validation.

Authentication then consumes the exact framed bytes with a vetted library primitive and uniform secret-dependent behavior. Session validation checks peer identity, epoch, expected sequence, replay window, and legal state transition. Only after all checks succeed does the single owner mutate trading state. The failure path increments a bounded per-thread reason counter and optionally copies a capped binary diagnostic; it does not allocate, retry indefinitely, or reflect a detailed error to an unauthenticated sender.

The design has explicit resource bounds: maximum packet, nesting depth, entries, decompressed bytes, hash probes, outstanding sessions, recovery messages, and diagnostic rate. It has explicit invalidation: validated views cannot outlive the owned receive buffer, and cached authentication results expire with session epoch. Its security build retains speculation and constant-time mitigations selected for the supported CPUs.

Verification covers different claims rather than one giant test:

| Claim | Evidence |
|---|---|
| range and arithmetic safety | boundary unit tests, ASan/UBSan, fuzz corpus |
| initialized data and lifetime | MSan-capable build, ownership review |
| race freedom | confinement proof, TSan-supported integration tests |
| state legality | complete transition table and sequence fuzzing |
| bounded complexity | collision/depth/size adversarial tests and counters |
| secret handling | audited primitives, final assembly, timing evidence |
| speculative hardening | threat model, toolchain flags, artifact review |
| release equivalence | deterministic corpus comparison across builds |
| operational behavior | canary/shadow replay and bounded failure telemetry |

Tool failures are not “false because production is faster.” An ASan overflow demonstrates an invalid access on the executed path even though addresses differ in release. A TSan report requires memory-model analysis even if production timing rarely triggers it. A fuzz timeout requires complexity analysis even when typical packets are small. Conversely, clean tools cover only executed and modeled behavior, so the written invariants remain necessary.

The final acceptance review inspects the linked optimized artifact, not just source and unit objects. It records compiler, standard library, linker, CPU target, mitigations, generated schemas, and dependencies. It confirms external validation is ordinary runtime logic, no benchmark macro bypasses it, and every production rejection retains a bounded observable reason. Fast and correct are not competing modes; defined bounds make optimization defensible.

## 41.11 Interview Check

1. Rewrite `offset + length <= packet_size` so unsigned wrap cannot make an invalid range pass. Which check must occur before reading an embedded length?
2. Why can an untrusted hash table degrade to linear work despite average constant-time lookup, and which bounded data structures or collision policies can replace it?
3. Design a session state machine for login, synchronization, active traffic, gap recovery, and logout. Where must mutation occur relative to validation?
4. Explain why an architecturally correct bounds check may not stop speculative data leakage. Why is removing the check never a mitigation?
5. What does constant-time mean for authentication-tag comparison, and why is a handwritten XOR loop insufficient evidence?
6. Order framing, type, length, authentication, sequence, and state validation for a concrete protocol, and explain which threat-model choice could change the order.
7. Compare ASan, UBSan, TSan, and MSan by detected defect, instrumentation model, ecosystem requirements, and major blind spots.
8. How would you evaluate whether a static analyzer understands a custom buffer view, resource wrapper, and atomic publication protocol?
9. Build a structure-aware fuzzing strategy for a parser plus a stateful recovery session. What belongs in the corpus, mutation model, oracle, and regression suite?
10. A sanitizer build is clean but the release build fails under load. List the layout, scheduling, optimization, conditional-compilation, and undefined-behavior differences you would investigate.
