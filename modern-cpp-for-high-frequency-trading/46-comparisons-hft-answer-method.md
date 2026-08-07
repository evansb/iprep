# Chapter 46 — Comparisons and the HFT Answer Method

Interview comparisons are rarely requests for a universal winner. They test whether you can preserve semantics while tracing ownership, hidden work, and tail behavior through a concrete workload. “A vector is faster” and “lock-free is lower latency” are slogans, not engineering answers. This chapter turns the book's recurring choices into a disciplined comparison method: define the required contract, expose fast and slow paths, state bounds and failure modes, then name the measurement that could disprove the recommendation.

## 46.1 Contiguous, Linked, Hashed, Tree, and Flat Containers

A container choice begins with required operations, ordering, reference stability, key distribution, capacity, and worst-case policy. Big-O notation alone omits allocation, cache lines, hashing, comparisons, and rare structural work.

| Family | Storage and indirection | Typical strength | Tail or failure concern |
|---|---|---|---|
| Contiguous sequence | Zero or one owned contiguous region, depending on container; adjacent elements | Scan, indexing, compact footprint | Dynamic growth moves/copies and invalidates |
| Linked sequence | Node allocation and pointers | Stable node identity, constant-time relink | Pointer chasing and allocator tails |
| Hash table | Buckets plus inline or node entries | Average constant-time lookup | Collisions and rehash |
| Tree | Usually allocated nodes and links | Ordered lookup with logarithmic bound | Allocation and dependent branches |
| Flat associative | Sorted contiguous entries | Compact ordered lookup and scans | Linear insertion movement |

`std::vector` wins for iteration, indexed access, append with reserved capacity, and small-to-medium sorted sets. Its contiguous layout makes hardware prefetching effective. Inserting near the front moves a suffix; growth can allocate, move or copy all elements, and invalidate pointers, references, and iterators according to the container rules.

`std::list` wins when nodes must keep stable addresses and the algorithm already holds the insertion/erase position. It does not make finding that position constant time. Each node commonly carries two links, has allocator metadata or fragmentation, and requires dependent loads. A pool can bound allocation but does not create spatial traversal order automatically.

`std::unordered_map` is appropriate when key equality and average lookup dominate, a good bounded-cost hash exists, and iteration order is irrelevant. Reserve and cap the load factor to avoid hot-path rehash. Adversarial or unlucky collisions make lookup linear. Node-based standard implementations often allocate each entry; open-addressed alternatives have different invalidation and deletion behavior.

`std::map` provides ordered keys and logarithmic operations. Its stable iterators and no-rehash behavior can matter more than raw lookup speed. A sorted vector or C++23 `std::flat_map` usually reads more compactly and uses binary search, but insertion moves elements and can reallocate. Flat storage wins for read-mostly snapshots; trees win for mutation with ordering and stability requirements.

Verify with production-like key skew, hit/miss mix, mutation rate, and pre-reserved capacity. Count allocations, bytes, comparisons, hashes, branches, cache/TLB misses, and percentile latency. Include rehash, capacity exhaustion, and collision cases rather than reporting only warmed successful lookups. Chapter 11 supplies the detailed invalidation rules.

## 46.2 Stack, Arena, Pool, and General Heap Allocation

Allocation strategies differ in lifetime model before they differ in speed. Ask whether objects have lexical, phase, fixed-class, or arbitrary lifetimes; whether destruction matters; and what happens at capacity.

**Stack allocation** ties storage to scope or thread-stack lifetime. Address adjustment is usually minimal work and locality is good. Large or unbounded objects risk stack exhaustion, and first touch can fault pages. Returning a pointer or view to a dead stack object is invalid. Stack storage wins for small, bounded scratch state with lexical lifetime.

An **arena** reserves a region and usually advances a bump pointer. Allocation is constant work until capacity is reached; individual deallocation is absent. Reset releases a phase at once. Destructors must either be unnecessary, registered, or run explicitly. Arenas win for parse batches, request phases, and immutable snapshots whose objects die together. They waste memory when a few objects outlive the phase.

A **pool** manages fixed-size or size-class slots. It provides reuse, stable capacity, and explicit exhaustion behavior. A free list adds metadata and can suffer contention or ABA when shared; per-thread pools improve locality but make cross-thread frees a design problem. Pools win for bounded, repeatedly created orders or queue nodes with known sizes and lifetimes.

The **general heap** accepts arbitrary sizes and lifetimes. Modern allocators use size classes and thread caches, so a warmed allocation can be short. Slow paths can acquire locks, request pages, fault, reclaim, or suffer fragmentation. It wins where flexibility and maintainability dominate or where allocation is outside the critical path.

No custom allocator repairs an unbounded object count. Define capacity and failure: return an error, shed work, recover, or terminate safely. Preallocation changes failure timing from an incident to startup, which is often the larger HFT benefit.

Verify allocation count and size with instrumentation, measure resident and virtual memory, page faults, fragmentation, and cross-thread frees, and test exhaustion deliberately. Touch pages and execute destructors in the benchmark. Comparing only successful warmed `allocate()` calls omits the ownership contract developed in Chapter 10.

## 46.3 Mutexes, Spinlocks, and Lock-Free Algorithms

Synchronization choices preserve a shared invariant and establish memory ordering. The first question is whether shared mutation can be removed through single-writer ownership or partitioning. If not, compare progress, contention, scheduler assumptions, fairness, and reclamation.

A **mutex** blocks competitors and synchronizes protected non-atomic state. A common Linux implementation uses an atomic user-space fast path and a futex-backed slow path, but C++ does not specify that algorithm or fairness. Mutexes win when critical sections are bounded, contention is rare, sleeping is acceptable, and state or lifetime changes are easiest to express under one lock. A preempted owner, priority inversion, convoy, callback, allocation, or fault inside the section broadens tails.

A **spinlock** repeatedly checks ownership while remaining runnable. It can avoid scheduler wakeup when the owner is executing elsewhere and will release almost immediately. It wastes a CPU for longer waits, can slow an owner on an SMT sibling, and can prevent the owner from running under oversubscription. Fairness and backoff depend on the implementation. Spinlocks win only with reserved CPU capacity, proven short hold times, and no blocking operation inside.

A **lock-free algorithm** guarantees system-wide progress under its stated assumptions; it does not guarantee that one operation finishes or that latency is low. CAS retries transfer cache-line ownership, and safe reclamation adds hazard, epoch, reference-count, or non-reclamation state. It wins when progress despite a paused participant is required and the access pattern avoids a single contended word. An SPSC ring is a much more favorable case than a hot MPMC stack.

Storage differs: a mutex embeds coordination state and may use kernel wait queues only under contention; a spinlock embeds atomic state but consumes execution capacity; a lock-free structure often embeds versions, per-slot sequences, or per-thread reclamation records.

Benchmark equal semantics, including fairness, capacity, overload, and reclamation. Measure per-thread retries and percentiles, CPU time, context switches, cache-to-cache transfers, and behavior with a deliberately paused owner/participant. Chapter 15 covers waiting and Chapter 17 covers reclamation. The answer “lock-free is faster” is never complete.

## 46.4 SPSC, MPSC, and MPMC Queues

Queue topology is defined by the number of concurrent producers and consumers, not by the number of threads in the process. Selecting the narrowest topology reduces synchronization and proof complexity.

An **SPSC** queue has one writer for the producer index and one for the consumer index. A bounded ring preallocates storage, separates hot indices, and commonly needs release publication plus acquire observation. It wins between fixed pipeline stages. Full and empty policies are explicit, and object construction/destruction must follow slot ownership.

An **MPSC** queue serializes producers while one consumer owns removal. Designs use a producer-side mutex, atomic exchange/list, or per-producer SPSC queues merged by the consumer. A single shared tail can ping-pong under load. Per-producer queues reduce contention and expose fairness to the consumer, at the cost of more rings, memory, and scan work.

An **MPMC** queue coordinates both sides, often with per-slot sequence numbers and CAS operations. It supports worker pools or dynamic consumers but has the most metadata, retry, fairness, and wraparound complexity. Lock-free system progress does not prevent a producer or consumer from starving. It wins only when both multiplicities are genuinely required.

Capacity affects semantics. A bounded queue can reject or overwrite in fixed storage; an unbounded queue allocates or links nodes and converts overload into memory growth. Blocking on full propagates backpressure; dropping can invalidate a market-data sequence or lose an acknowledgement. Define policy per message class.

Ordering must be stated. SPSC naturally preserves its producer's order. MPSC can preserve a total order of successful publication without matching wall-clock intent; per-producer queues preserve each producer only unless the consumer defines arbitration. MPMC completion order and fairness are algorithm-specific.

Verify with realistic producer/consumer ratios, burst distributions, CPU topology, full/empty transitions, index wraparound, and paused participants. Count CAS retries, cache-line transfers, scan work, queue residence, drops, and per-thread percentiles. ThreadSanitizer can find some races but does not prove memory orders or progress; Chapter 43's workshops provide the proof patterns.

## 46.5 Copies, Moves, and Non-Owning Views

A **copy** creates an independent value, a **move** transfers or reconstructs resources according to a type's move operations, and a **view** borrows storage without extending its lifetime. They provide different ownership, not merely different byte counts.

Copying a small trivially copyable normalized event can be a few fixed loads/stores and improves locality by releasing a large receive buffer. Copying a `std::vector` or long string allocates and copies elements. The type's operations, not the spelling, determine work.

`std::move` is a cast that enables move overload resolution. A common move of a heap-owning container transfers pointers and leaves the source valid but unspecified; allocator mismatch or type design can require element moves. Moving small-buffer strings may copy embedded characters. A move can throw unless its operation is `noexcept`, affecting container growth decisions.

`std::span` and `std::string_view` usually hold pointer-and-size-like state and do not allocate. They win for synchronous parsing and read-only access within a clear ownership scope. They fail when the underlying vector grows, ring slot is recycled, stack frame returns, temporary dies, or asynchronous consumer outlives a buffer.

The average-latency trap is to avoid a bounded 32-byte copy by retaining a page-backed NIC buffer or shared ownership across stages. That view increases footprint, indirection, and reclamation pressure. Conversely, copying a large payload for each fan-out consumer wastes bandwidth.

State the boundary: borrow during callback, move unique ownership across one queue, or copy a compact domain object for independent lifetime. For fan-out, compare copying with immutable shared buffers and reference-count contention.

Verify `sizeof`, special-member selection, allocator behavior, generated assembly for small types, and allocation counts for large ones. Poison or immediately recycle test buffers to expose escaped views; use sanitizers for lifetime failures. Measure end-to-end buffer occupancy, not only the copy instruction loop. Chapters 4 and 30 provide the language and network-lifetime details.

## 46.6 `unique_ptr` and `shared_ptr`

`std::unique_ptr` expresses exclusive ownership; `std::shared_ptr` expresses shared ownership through a control block and atomic ownership accounting suitable for participating threads. Choose by ownership graph, not convenience.

A `unique_ptr<T>` commonly stores one pointer; a stateful deleter can increase its size. Moving transfers ownership without incrementing a shared count. Destruction invokes the deleter exactly once. It wins for trees, service components, buffers passed through a single-owner pipeline, and polymorphic ownership where allocation is acceptable.

A `shared_ptr<T>` commonly stores an object pointer and control-block pointer. The control block contains strong and weak counts, deleter/allocator state, and possibly the object when created by `make_shared`. Copies modify shared counters, causing atomic and coherence traffic. Destruction of the last owner can run an unbounded object destructor on whichever thread releases it.

`make_shared` can combine object and control-block allocation, improving locality. A surviving weak pointer can keep that combined allocation alive after `T` is destroyed. Separate allocation allows object memory to be released while weak state remains and supports specialized ownership, at more allocation and indirection cost.

Shared ownership wins when lifetime genuinely spans independent asynchronous consumers and no simpler owner exists. It loses when used to avoid deciding who owns the object, when copied on every message, or when deterministic reclamation thread matters. Cycles leak unless broken with `weak_ptr`; `weak_ptr::lock` can fail and performs synchronization.

Neither pointer makes pointee access thread-safe. `const shared_ptr<T>` does not make `T` immutable. Publication and mutation still need a protocol.

Verify object/pointer sizes on the target library, allocation count, copies, last-release location, destructor work, and cache-to-cache events under fan-out. Test cycles and delayed weak references. Compare a move-only buffer handle or copied compact event before accepting shared counting in a hot path. Chapter 9 covers deleters and control-block lifetime.

## 46.7 Exceptions, `expected`, and Error Codes

Error mechanisms differ in control-flow contract, payload, propagation discipline, and failure-path cost. Decide whether failure is exceptional, locally recoverable, latency-critical, and permitted across ABI or thread boundaries.

Exceptions separate the success return type from failure and unwind RAII objects automatically. Common GCC/Clang ABIs make the no-throw path relatively low overhead through tables, but throwing performs runtime lookup, allocation or exception-object management, stack unwinding, destructors, and indirect control flow. C++ does not guarantee a “zero-cost” implementation. Exceptions win for initialization or rare failures where cleanup and propagation matter and an unbounded throw path is acceptable. They must not cross incompatible or C boundaries.

C++23 `std::expected<T,E>` stores either a value or error. It makes failure visible in the type and supports monadic composition. Common implementations need inline capacity for the larger alternative plus engagement state and possible padding, but C++ does not prescribe that exact layout. A large `E` can therefore expand every result. Each consumer branches or propagates explicitly. It wins for parse, validation, and setup APIs where structured errors are common enough to model but exceptions are undesirable.

Error codes return a sentinel, enum, or `std::error_code`, often through a pair or output parameter. They are ABI-friendly and predictable when checked. They fail when callers ignore, overwrite, or conflate values. A sentinel embedded in the value domain can be ambiguous.

No mechanism bounds the recovery work. Formatting an error, logging, allocation, retries, and rollback can dominate. On a hot parser, return a compact enum plus offset; format later. For impossible internal invariants, termination or an assertion policy is different from an expected wire error.

Verify success and each failure path separately, inspect object sizes and generated branches, instrument allocations, and fuzz propagation. Ensure `noexcept` functions cannot accidentally throw and terminate. Test cleanup at every partial-construction point. Compare identical diagnostics and recovery semantics rather than an exception with a silently ignored integer. Chapter 9 develops the guarantees.

## 46.8 Virtual Dispatch, Templates, Variants, and Type Erasure

Dispatch mechanisms trade runtime openness, compile-time knowledge, storage, code size, and indirect branches. The call instruction alone is rarely the full cost.

Virtual dispatch provides an open set of derived types behind a stable base interface. Common ABIs use a vptr and vtable, but C++ does not prescribe layout. Objects are often separately allocated and reached through pointers, adding indirection and scattered storage. It wins for runtime plugins or stable interfaces. Compilers can devirtualize when the dynamic type is provable.

Templates provide static dispatch and specialization. They can inline and propagate constants, eliminate branches, and embed storage. Each instantiation can duplicate code, increase compile/link time, and pressure the instruction cache. Templates win when types are known at compile time and specialization materially reduces work.

`std::variant` is a closed set of alternatives and does not dynamically allocate storage for the contained object. Common implementations reserve inline space governed by the largest alternative plus state and padding, but the exact discriminator and layout are not standardized. `std::visit` dispatches by active index; an implementation may use branches or tables. It makes exhaustive handling possible but loses when the type set must be extended independently or one large alternative bloats every object.

Type erasure stores operations through an erased function table or callable wrapper. It can offer value semantics and a stable non-template interface. Small-buffer optimization is implementation- or design-specific; oversized/stateful objects can allocate. It wins at module boundaries or when controlling template expansion while accepting indirection.

Failure modes include missing virtual destructors, dangling erased references, `bad_variant_access`, hidden callable allocation, and ABI mismatch. Measure representative mixed type distributions, allocation and object footprint, indirect-branch misses, instructions, and binary/hot-code size. Inspect optimized assembly for devirtualization. Chapter 7 details the mechanisms; the interview answer should tie them to openness and working set.

## 46.9 AoS and SoA

An **array of structures** (AoS) stores complete records adjacently. A **structure of arrays** (SoA) stores each field in a separate contiguous array. The choice follows access shape and mutation invariants.

AoS wins when an operation consumes most fields of one order or book level together, when records move as units, and when a simple stable interface matters. One cache-line fetch can provide several related fields. It wastes bandwidth when scans use only one small field from a large record and can inhibit SIMD through strided field placement.

SoA wins for column scans, vectorized risk calculations, and dense updates to one field. It fetches only the used columns and exposes contiguous lanes. It requires synchronized sizes/indices across columns, more base pointers, and multiple streams when reconstructing a whole record. Insertion can move several arrays and failure must not leave column lengths inconsistent.

A hybrid layout often wins: arrays of small hot records plus separate cold metadata, or array-of-structures-of-arrays blocks sized for SIMD/cache use. It preserves some record locality while vectorizing within a block.

Memory footprint depends on padding. AoS repeats per-record padding; SoA can remove it but may require alignment padding per column and more allocation metadata. Stable references are difficult in either layout when vectors grow. Reserve or use fixed capacity.

The worst case is workload-dependent: random whole-record lookups make SoA touch several distant lines; wide AoS scans waste bandwidth and cache. Updating the same column from several threads can also create false sharing unless ownership is partitioned.

Verify with the actual field-use matrix, element count, mutation pattern, vectorization report, generated SIMD, cache/TLB events, memory bandwidth, and full object footprint. Include normalization or gather cost at API boundaries. Chapter 5 introduces layout and Chapter 18 explains vector execution.

## 46.10 Relaxed, Acquire/Release, and Sequentially Consistent Atomics

Memory order is a correctness contract, not a speed level selected by instinct. First identify which non-atomic writes must become visible to which reads and which atomic modification order carries that relationship.

`memory_order_relaxed` guarantees atomicity and per-object modification order without synchronizing other state. It wins for independent counters, unique ID allocation where only uniqueness matters, and algorithm steps whose ordering comes from another edge. It is wrong for publishing a pointer to newly initialized non-atomic data by itself.

A release operation followed by an acquire operation that reads from the appropriate release sequence can establish synchronization. This is the usual publication tool for a ring slot, immutable snapshot pointer, or ready flag. Only writes before release become visible after the matching acquire; the argument must name the actual atomic and value flow.

Sequential consistency adds a single total order for SC operations consistent with each thread's order. It simplifies reasoning about multi-atomic protocols and is the safe default before proof. It does not make a compound operation atomic or repair data races on ordinary objects.

On x86-64, acquire loads and release stores often use ordinary load/store instructions because the architecture supplies sufficient ordering. ARM64 commonly uses acquire/release instructions. SC stores or fences can require stronger sequences. Compiler and exact CPU matter; the portable semantics are unchanged.

All contended read-modify-write operations need cache-line ownership regardless of relaxed ordering. Changing SC to relaxed may not cure a ping-pong bottleneck. The slow path is contention, not just fences.

An atomic object's size and alignment can exceed those of `T`, and not every specialization is lock-free. A non-lock-free implementation may call library support backed by locks or other shared state. Check `is_always_lock_free` when the algorithm requires a compile-time property and `is_lock_free()` for the actual target; neither property chooses the correct memory order.

Failure modes include illegal compare-exchange failure orders, using relaxed publication, missing lifetime synchronization, and assuming a coherent CPU makes a C++ race defined. Prove happens-before on paper, run litmus/stress tests across x86-64 and ARM64, use ThreadSanitizer where applicable, and inspect assembly. Chapter 14 supplies formal rules. Optimize an order only after the proof survives the change.

## 46.11 Threads and Processes

Threads share an address space; processes have separate virtual address spaces and communicate through kernel or shared-memory mechanisms. The decision is primarily failure, privilege, deployment, and ownership isolation—not creation speed.

Threads share objects directly and make low-copy handoff possible. They also share corruption, allocator state, file descriptors at the process level, and many fatal failures. A data race is undefined behavior for the process, and an out-of-bounds write can damage any in-process component. Threads win for tightly coupled pipeline stages with trusted code, explicit ownership, and a measured need for direct memory sharing.

Processes provide address-space and credential boundaries. One process cannot ordinarily follow a bad pointer into another's private state. They support independent restart, resource limits, and deployment ownership. They add IPC serialization or shared-memory protocols, more mappings and page tables, descriptor/state management, and reconciliation after peer death. A process crash can still corrupt shared memory or external state.

Thread startup commonly reserves a stack and creates a kernel task. Process `fork`/`exec` adds page-table, loader, relocation, initialization, and demand-fault work. Both should be long-lived in an HFT data path; startup microbenchmarks rarely decide architecture.

Context switches can occur between threads or processes. Address-space changes may affect translation state depending on hardware and kernel mitigations, but do not assume every process switch flushes all caches or TLBs. Scheduling, affinity, NUMA, and working-set displacement dominate many tails.

Processes win for fault containment, privilege separation, independent rollout, and untrusted protocol code. Threads win for shared single-writer state and very frequent fine-grained handoff. A hybrid commonly isolates sessions or risk while using threads within each service.

Verify crash behavior, restart/reconciliation time, IPC tails, resident and page-table memory, context switches, faults, and deployment operations. Inject a segfault, hang, and memory leak into each boundary. Chapters 20–23 develop Linux lifecycles and IPC.

## 46.12 Shared Memory, Unix Sockets, and Pipes

IPC choices differ in message semantics and recovery. Define direction, fan-in/out, framing, descriptor passing, credentials, backpressure, peer death, and whether a payload copy is acceptable.

**Shared memory** maps the same pages into processes. It can avoid kernel payload copies after setup, but requires a synchronization protocol, relative offsets instead of process-specific pointers, versioned layout, ownership, reclamation, false-sharing control, and crash recovery. It wins for high-rate fixed-format local streams with stable participants and specialist ownership.

**Unix sockets** provide stream, datagram, or sequenced-packet semantics, kernel buffering, readiness, peer credentials, and descriptor passing. They copy or reference data through the socket path according to Linux implementation and API. They win for control, request/reply, variable messages, independent process lifecycles, and operational simplicity. Stream sockets require framing; datagram sizes and queue limits need handling.

**Pipes** are unidirectional byte streams with simple file-descriptor integration. Writes up to `PIPE_BUF` have defined non-interleaving properties among writers, but pipes do not preserve application messages generally. They win for parent/child streaming or simple tool composition, not rich peer sessions.

All three can block and backpressure. Shared memory only moves the queue into user space; a full ring still needs reject, wait, overwrite, or drop semantics. Unix socket and pipe buffers consume kernel memory and readiness/wakeup work. Large buffers absorb bursts and add queue delay.

Failure modes differ: stale shared-memory owners and incompatible schemas; partial stream frames and peer-credential mistakes; pipe endpoint leaks that prevent EOF. Close-on-exec and descriptor lifetime matter for kernel IPC.

Benchmark identical framing, validation, capacity, and full behavior. Measure copies, syscalls, wakeups, cache-line transfers, queue residence, memory, and peer-restart behavior. Pause a consumer and kill it mid-message. Chapter 22 covers socket/pipe contracts; Chapter 23 covers cross-process memory.

## 46.13 Blocking, `epoll`, Busy Polling, and Kernel Bypass

I/O waiting strategies trade simplicity and CPU efficiency against wake latency, multiplexing, and operational complexity. Ask how many descriptors are active, whether a core is reserved, and what work must occur on idle-to-active transition.

**Blocking I/O** parks a thread until an operation may proceed. It offers simple state and low idle CPU. Scheduler wakeup, migration, and cold caches broaden latency. One thread per connection increases stacks and scheduling as counts grow. It wins for a small number of streams or noncritical control paths.

**`epoll`** lets one or a few threads wait for readiness across many descriptors. It avoids a linear user scan but still needs nonblocking state machines, partial operations, and correct draining—especially with edge-triggered mode. Ready-list bursts can create fairness issues. It wins for multiplexed sessions whose aggregate rate does not justify dedicated cores.

**Busy polling** keeps a thread runnable and repeatedly checks for work, through socket support or application loops. It removes some park/wake delay at the cost of a core, power, heat, and interference. It wins for a dedicated latency-sensitive queue when producer and NAPI progress have reserved capacity.

**Kernel bypass** exposes userspace rings or specialized stacks, reducing transitions, copies, and general stack work. It adds pinned or huge memory, dedicated polling, custom protocol and ownership code, security/isolation concerns, and device-specific recovery. It wins only when measured socket-path work violates the requirement and operations can support the replacement.

Worst cases are scheduler delay for blocking, event-loop starvation for `epoll`, spinning while the producer cannot run, and ring/buffer exhaustion or process failure for bypass. Equal comparisons preserve routing, checksums, timestamps, filtering, backpressure, and recovery.

Storage shifts with the choice. Thread-per-connection blocking reserves stacks and kernel task state. `epoll` maintains kernel interest and ready state plus user connection state. Busy polling retains socket buffers while consuming execution capacity. Bypass preallocates DMA-capable frame pools and rings, often with pinned or huge pages. Include all of it in the footprint rather than counting only payload bytes.

Measure idle and loaded CPU, first-packet and burst percentiles, syscalls, context switches, `EAGAIN`, softirq pressure, drops, and queue age. Test sparse and saturated traffic. Chapters 24 and 31 provide the path mechanics.

## 46.14 `read`, `write`, `mmap`, and Direct I/O

File I/O methods differ in caching, copy, alignment, fault, durability, and access-pattern semantics. State whether the workload is sequential or random, read or write, shared, durable, and latency-critical.

`read` and `write` normally use the page cache for regular files. Data copies between kernel cache and user buffers, but readahead, writeback, and familiar error handling make the path robust. Reads and writes can be short; writes can be accepted before durable storage. They win for streaming access and predictable explicit call boundaries.

`mmap` maps file pages into the address space. Loads and stores become ordinary instructions after translation and residency, and sharing can avoid an explicit copy. First access can fault, truncation can produce `SIGBUS`, and writeback or durability still needs an explicit policy. It wins for random access, shared read-mostly data, or structures naturally addressed in place when fault behavior is controlled.

**Direct I/O** requests bypass of page-cache data buffering on supported filesystem and device paths. It imposes alignment and size constraints that vary, can still use asynchronous completion, and does not universally imply durable media. It wins for large controlled I/O where double caching is harmful and the application owns buffering.

Memory footprint moves rather than vanishes: page cache, user buffers, mapped pages, pinned/direct buffers, and metadata all count. `mmap` can reduce explicit copies but increases fault and VMA/page-table considerations. Direct I/O can expose device latency and queueing more directly.

Failure paths include `EINTR`, partial operations, ENOSPC during writeback, mapping truncation, dirty-page throttling, alignment errors, and device errors. Define crash consistency separately from API completion.

Verify cold and warm cache separately, page faults, readahead, dirty/writeback state, syscalls, copies, device queue latency, and actual durability barriers. Use equal bytes and access patterns; dropping caches is system-wide and requires safe test isolation. Chapter 25 supplies the detailed path.

## 46.15 TCP, UDP, and Multicast

Transport choice starts with delivery semantics and communication pattern. TCP is a reliable ordered byte stream between endpoints. UDP sends independent datagrams without reliability or ordering. IP multicast distributes datagrams to a group through network and host membership state.

TCP wins for order entry, sessions, and streams where reliable ordered delivery and congestion or flow control are required. It needs application framing, has connection state and a handshake, and cannot deliver later bytes past missing earlier bytes. Retransmission, window closure, and head-of-line blocking create tails.

“Reliable” does not mean that every submitted byte is ultimately delivered after a connection failure, nor that the peer application acted on it. A disconnect after remote processing but before an application acknowledgement can still leave an unknown business outcome.

UDP wins for small independent messages, application-controlled recovery, and cases where stale data is less valuable than new data. It preserves datagram boundaries but can lose, duplicate, reorder, and truncate at receive. Applications need sequence, gap, validation, and overload policy.

Multicast wins when one publisher sends the same stream to many receivers and network support exists. It avoids one sender flow per subscriber at the application level, but requires group management, multicast routing and switching behavior, per-receiver loss recovery, and commonly redundant feeds or snapshot/retransmission channels. It is not a reliable transport.

Storage includes TCP send/receive and retransmission state, UDP socket/datagram queues, and multicast membership/filter state. All traverse NIC, kernel, and application queues unless bypassed. Small-packet per-packet work can dominate byte bandwidth.

Failure semantics decide the comparison: TCP may deliver old data after recovery; UDP exposes gaps; multicast receivers can disagree about which packets were lost. Security and authentication belong to TLS or application protocol design.

Measure message-to-message semantics, not raw payload throughput: handshake, framing, retransmission, gaps, queue age, packet rate, syscalls, copies, and recovery-to-valid-state. Inject loss, reordering, receiver pause, and flow control. Chapters 28–30 provide the protocol details.

## 46.16 Interrupts and Polling

Interrupt-driven receive asks hardware and the kernel to notify software of work; polling checks for work proactively. The choice trades notification delay against CPU efficiency and often uses a hybrid rather than either extreme.

Interrupts win for sparse or mixed workloads because idle CPUs can sleep or run other work. Interrupt handling, NAPI scheduling, application wakeup, and cold state add latency. Coalescing batches notifications to reduce interrupt rate, intentionally delaying some packets.

Polling wins when traffic is frequent, a core is reserved, and the checked queue is close to the consumer. It avoids repeated sleep/wakeup and can process batches directly. Empty polls consume CPU, interfere with SMT, caches, and memory, increase power, and can delay the producer if placement is wrong.

Linux NAPI is already hybrid: an interrupt schedules bounded polling, and the driver returns to interrupt mode after draining. Socket busy polling moves some polling opportunity into application context. DPDK-style loops poll userspace-visible rings continuously.

Both modes depend on preallocated descriptor rings and packet buffers; the difference is who notices completion and where processing runs. Interrupt mode also maintains vector and scheduler state. Polling adds little per-packet allocation in a well-designed path but reserves a core as a capacity resource. Ring exhaustion remains possible in either mode.

Tail failure modes include interrupt storms, adaptive-coalescing shifts, NAPI budget exhaustion, scheduler delay, polling a queue whose producer cannot run, and thermal or frequency effects. Neither approach fixes downstream queue overload.

Define CPU and topology ownership. A polling thread without an assigned physical core is an oversubscription risk; an interrupt vector on a remote NUMA CPU defeats locality. Preserve watchdog and control capacity when isolating CPUs.

Verify sparse first arrival, steady packet rate, and bursts. Count interrupts, polls with and without work, softirq time, context switches, CPU/power, queue drops, and percentiles. Vary coalescing and affinity one factor at a time. Chapter 31 provides NAPI and busy-poll observability.

## 46.17 Kernel Sockets, AF_XDP, and DPDK

These APIs expose progressively more packet-path ownership. Kernel sockets provide transport and network semantics; AF_XDP exposes packet rings connected through XDP; DPDK-style poll-mode drivers commonly give userspace direct queue and buffer-pool control.

**Kernel sockets** win on portability across NICs, routing, TCP, firewall integration, namespaces, mature recovery, and familiar tooling. They perform stack work, system calls, queueing, and commonly payload copies. Offloads, batching, busy poll, and affinity can reduce costs before replacement.

**AF_XDP** wins for selected L2/L3 packet paths that benefit from XDP steering and userspace processing while retaining a Linux integration point. It uses registered UMEM and fill, completion, RX, and TX rings. True zero-copy depends on driver, NIC, and configuration; copy mode is valid. The application owns frame lifetime and must handle ring starvation and device reset.

**DPDK** wins for dedicated high-rate packet processing with supported hardware and a team prepared to own huge-page pools, poll-mode queues, protocol features, security boundaries, and deployment. It can minimize transitions and tune batches. It consumes cores and pinned memory and moves routing, filtering, capture, and failure recovery into a different operational ecosystem.

The choices are not semantically equal by default. A UDP socket delivers validated datagrams after IP and UDP processing; an AF_XDP or DPDK loop may receive raw frames and must validate Ethernet, VLAN, IP lengths and fragments, checksums, and UDP itself. Add that work before comparing.

Worst cases include socket-buffer overflow and scheduler wakeup; AF_XDP UMEM or ring exhaustion and accidental deployment in copy mode when zero-copy was not required explicitly; DPDK lcore stall, mempool exhaustion, and loss of service when a userspace driver fails. Bypass does not prevent NIC or switch loss.

Verify complete feature parity, CPU and memory reservation, packets per second, copies, latency distribution, drops at every ring, restart time, observability, and operator procedure. An external tap can verify wire behavior. Chapter 31 details ownership.

## 46.18 Burst Absorption and Bufferbloat

A buffer absorbs a finite mismatch between arrival and service. It cannot repair sustained overload. The decision is how much burst to absorb, how old work may become, and what semantic action occurs at the limit.

Small buffers expose overload quickly, limit memory and queue age, and trigger drops or backpressure during short service pauses. Large buffers tolerate longer bursts and scheduler interruptions but consume pages, hide pressure, and increase worst-case residence. **Bufferbloat** is the resulting excessive delay while queues remain apparently successful.

Trading policies differ by data class. Stale market-data incrementals may be discarded by invalidating the stream and recovering. Order acknowledgements cannot be casually dropped because they determine state; exhausting their reserved capacity may require fail-closed disconnect and reconciliation. Telemetry can often sample or overwrite.

Queue chains matter: NIC ring, NAPI backlog, socket buffers, decoder batch, application queues, and switch ports can each hold data. Shrinking only the last queue may not reduce end-to-end age if the socket stores the backlog. Increasing every queue multiplies hidden delay.

Capacity should follow a documented burst envelope and service pause, with item and byte limits for variable messages. Beyond that envelope choose reject, drop newest or oldest, overwrite, disconnect, or recover. Backpressure can propagate to TCP senders; UDP and multicast senders may never observe one local receiver's drop.

Verify queue age as well as depth, high-water marks, overflow counters, memory and page footprint, and recovery behavior. Pause consumers, burst senders, and delay the logger or allocator. Confirm control messages retain capacity. Chapters 30 and 31 cover application and packet queues.

## 46.19 Average Throughput and Bounded Latency

**Throughput** measures completions per unit time; **latency** measures time for one operation or event. An average summarizes a distribution but says nothing about a hard bound. HFT designs often require adequate throughput while controlling high percentiles and explicit overload behavior.

Batching, parallelism, deep queues, large buffers, and many in-flight misses can raise throughput. They wait for work, increase residence, consume capacity, and amplify stragglers. A pipeline's tail includes each stage's service and queue delay; correlated bursts make simple percentile addition invalid.

An algorithmic bound counts steps under stated assumptions. It is not a wall-clock bound: page faults, preemption, interrupts, cache misses, thermal changes, retransmission, and device queues intervene. A wait-free operation can be descheduled. Conversely, a mutex design can show tight observed latency under its deployment assumptions without a formal per-operation guarantee.

Average-case structures such as hash tables need collision and rehash policy. Amortized vector append needs reserved capacity if growth is unacceptable. General allocation, blocking I/O, and recovery introduce slow paths. Identify and move them to startup, bound them, or define failure.

Measurement must avoid coordinated omission: a load generator that waits for each response stops issuing work during stalls and understates queueing. Report histograms and requirement-relevant percentiles, sample count, maximum with context, throughput, drops, and CPU and memory conditions. A percentile is not a guarantee beyond the observed experiment.

The winning design meets semantic correctness, capacity, and service targets under a declared envelope and fails deliberately outside it. Maximum benchmark throughput at saturation is rarely the best operating point; leave headroom for bursts, recovery, and system noise. Chapter 38 provides the measurement protocol.

## 46.20 The Semantics–Latency–Memory–Predictability–Verification Answer Template

A strong technical answer follows five lenses in order. The order prevents optimization from changing the question.

**1. Semantics — What must be true?** Define the contract: ownership, ordering, lifetime, consistency, delivery, progress, invalidation, capacity, and failure response. State workload shape and platform scope. Eliminate candidates that cannot satisfy it.

**2. Latency — What work happens?** Trace the fast path and slow path. Count allocations, copies, branches, comparisons, atomics, cache-line transfers, syscalls, wakeups, packets, retries, and recovery. Distinguish latency from throughput and average from amortized or worst case.

**3. Memory — Where does state live?** Name embedded fields, indirection, control blocks, nodes, buckets, pages, kernel buffers, DMA rings, padding, and NUMA placement. State who owns each buffer and what invalidates or reclaims it.

**4. Predictability — What broadens the tail?** Identify growth, rehash, collisions, faults, reclaim, contention, preemption, queueing, retransmission, replay, full buffers, partial operations, and peer or device failure. Say what is bounded and what the system does when the bound is reached.

**5. Verification — What evidence would change the answer?** Propose an equal-work benchmark and correctness tests. Name assembly, allocation instrumentation, sanitizers, hardware counters, `perf`, scheduling traces, socket and NIC counters, packet captures, or fault injection. Include target compiler, library, kernel, CPU, NIC, topology, and load distribution where relevant.

The complete response can be compact:

```text
Given [required semantics and workload], choose [candidate]
because its fast path performs [work] using [storage/ownership].
The important tail is [slow path/failure], bounded or handled by [policy].
[Alternative] wins instead when [changed requirement].
Verify with [correctness test] and [measurements on target system].
```

For example: “Given one producer, one consumer, fixed capacity, and reject-on-full semantics, choose a preallocated SPSC ring. Each side owns one index and publishes with release/acquire; no hot-path allocation occurs. The limits are full capacity, cache-line placement, and consumer pause. MPMC wins only if participant topology changes. Verify memory-order reasoning, wraparound and full tests, per-operation tails, and cache-to-cache counters on the deployed CPUs.”

Avoid false precision. Do not invent universal cycle or nanosecond values. Do not claim a bound while depending on an unbounded allocator or queue. Do not recommend bypass, real-time policy, or disabled security without operational consequences. A defensible answer is conditional, measurable, and explicit about failure.

## 46.21 Interview Check

1. A read-mostly table has 200 entries and receives one update per second. Compare `map`, `unordered_map`, and a sorted contiguous representation using all five lenses.
2. Choose an allocation strategy for a fixed-capacity order pool and describe exhaustion, cross-thread release, and page-fault policy.
3. A lock-free MPMC queue has higher p99 latency than a mutex queue. Give at least four mechanisms that can explain the result and a test for each.
4. When does copying a parsed market-data event improve total latency compared with forwarding a view or `shared_ptr`?
5. Compare exceptions, `expected`, and compact error codes for an untrusted packet decoder and for process startup.
6. Explain why changing an atomic operation from sequential consistency to relaxed ordering can be both incorrect and ineffective as a performance fix.
7. Select among blocking sockets, `epoll`, busy polling, AF_XDP, and DPDK for ten sparse control connections plus one high-rate feed. State CPU and operational assumptions.
8. A system eliminates drops by increasing every buffer, but strategies now act on stale data. Diagnose the queue chain and propose semantic overload policies.
9. Turn the claim “multicast is faster than TCP” into a well-formed comparison with delivery, recovery, packet rate, and measurement criteria.
10. Give a two-minute semantics–latency–memory–predictability–verification answer comparing threads and processes for a market-data decoder boundary.
