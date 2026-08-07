# Chapter 23 — Shared-Memory IPC and Futexes

Shared memory removes routine payload copies by letting processes address the same physical pages, but it removes kernel-enforced message ownership at the same time. The application must define layout, synchronization, capacity, peer lifetime, and crash recovery precisely. Futexes and event descriptors complement that design: atomics handle the uncontended path, while the kernel parks or wakes processes only when necessary. This chapter develops that contract from mapping creation through restart and overload.

## 23.1 POSIX Shared Memory and `memfd_create`

A **POSIX shared-memory object** is a kernel object opened by name with `shm_open` and sized with `ftruncate`. Processes map it with `mmap(..., MAP_SHARED, ...)`. The descriptor controls the object; the mapping provides access to its pages.

```cpp
// Setup excerpt: error handling and RAII wrappers omitted for focus.
int fd = ::shm_open("/feed-a", O_RDWR | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
::ftruncate(fd, static_cast<off_t>(bytes));
void* base = ::mmap(nullptr, bytes, PROT_READ | PROT_WRITE,
                    MAP_SHARED, fd, 0);
```

Creation is a protocol. `O_CREAT | O_EXCL` selects one initializer; an opener that sees `EEXIST` follows the attach path. The creator must publish a ready state only after sizing and initializing the layout. An attacher must not infer readiness merely because `shm_open` succeeded.

`shm_unlink` removes the name but leaves the object alive until open descriptors and mappings are gone, like unlinking an ordinary file. Unlink-after-open is useful for session-scoped objects whose participants receive descriptors through a controlled channel. A persistent name is useful for rendezvous but needs stale-object ownership and permission rules.

Linux's `memfd_create` creates an anonymous RAM-backed file and returns a descriptor. It has no global POSIX SHM name; another process commonly obtains it through inheritance or `SCM_RIGHTS`. `MFD_CLOEXEC` prevents unintended inheritance. Seals can prohibit shrinking, growing, writing, or further seal changes when enabled at creation, making a published layout harder to corrupt. Seal support and combinations must be checked on the running kernel.

`memfd_create` is Linux-specific. It can request hugetlb backing with appropriate flags and provisioning, but huge pages change allocation, accounting, and failure behavior as Chapter 13 explains. Neither POSIX SHM nor a memfd makes pages resident immediately. Prefault on the intended NUMA node and account for page tables, TLBs, and lock limits.

Descriptor size is mutable unless policy prevents it. Establish the final length before mapping participants and add shrink/grow seals where the design supports them. Write seals have additional constraints around writable mappings and differ from future-write sealing on newer Linux kernels; check `fcntl(F_ADD_SEALS)` results rather than assuming a requested seal took effect. Publish the installed seal set in diagnostics.

Permissions apply at different times. `shm_open` mode and directory/namespace policy govern discovery and opening; a passed memfd descriptor is already a capability. Mapping protections govern a particular mapping but do not revoke another process's writable descriptor. If readers must be unable to mutate data, pass a separately constrained descriptor or apply supported seals before distribution.

## 23.2 System V Shared-Memory Concepts

System V shared memory uses `shmget` to obtain a segment identifier, `shmat` to attach it, `shmdt` to detach, and `shmctl` for metadata and removal. It predates POSIX SHM and uses IPC keys, identifiers, and permission structures rather than file descriptors.

An identifier names a kernel segment, not a stable application identity. IDs can be reused. `ftok` does not generate globally unique keys and should not be treated as authentication. Deployment needs ownership, permissions, IPC-namespace placement, and cleanup procedures.

Marking a segment `IPC_RMID` prevents new ordinary discovery and schedules destruction after the last detach; precise attach behavior around removal is Linux-specific. Persistent unremoved segments survive process exit and can retain stale data. Inspect them with `ipcs -m` and remove only known segments with `ipcrm`.

System V segments can be suitable when a legacy environment already manages keys and lifecycle. POSIX SHM or memfd descriptors usually compose more naturally with close-on-exec, polling control channels, descriptor passing, and capability-based access. The data path after mapping can be equivalent; the setup and cleanup contracts differ.

Huge-page System V flags and locking controls exist on Linux subject to privileges and configuration. Do not select the older API to obtain a presumed performance advantage. Compare page size, placement, mapping flags, and synchronization—the properties that affect access—not only the creation call.

## 23.3 Shared Mappings and Relative Offsets

A `MAP_SHARED` mapping lets multiple address spaces refer to the same backing pages. Each process may receive a different virtual base because of ASLR or address-space occupancy. Raw pointers stored in the region are therefore invalid as shared links.

Store **relative offsets** from a defined base:

```cpp
struct RegionHeader {
    std::uint64_t byte_size;
    std::uint64_t ring_offset;
    std::uint32_t ring_capacity;
    std::uint32_t slot_size;
};

std::byte* checked_address(std::byte* base, std::size_t mapped,
                           std::uint64_t offset, std::size_t length) {
    if (offset > mapped || length > mapped - static_cast<std::size_t>(offset)) {
        return nullptr;
    }
    return base + offset;
}
```

Validate before addition to avoid integer wrap. Validate alignment for the target type, object lifetime, array extent, and layout version. An offset of zero can mean null if the allocator never places an object there. Fixed-width offsets make representation explicit; a 32-bit offset saves space but caps region reach.

Shared layouts should contain fixed-width integers, byte arrays, and deliberately constructed trivial or implicit-lifetime types. `std::string`, `std::vector`, ordinary allocator pointers, virtual functions, and process-private locks cannot simply be mapped into another process. Even standard-layout C++ types can change with compiler options or ABI, so use static assertions and a schema identifier.

Mapping the region at a fixed virtual address avoids one addition but creates collision, portability, and security problems. `MAP_FIXED` can overwrite existing mappings. `MAP_FIXED_NOREPLACE` fails rather than replacing on supporting Linux kernels, but the design still depends on a global address reservation. Relative offsets are the safer baseline.

## 23.4 Initialization, Versioning, Ownership, and Recovery

A shared region needs a state machine. Zero-filled memory is not proof that initialization finished; it may mean the creator crashed after sizing.

```text
EMPTY -> INITIALIZING(generation, owner) -> READY(generation)
                    \-> ABANDONED -> RECOVERING -> READY(new generation)
```

The header should include a magic value, format version, total size, feature flags, generation, byte order or fixed endian convention, cache-line/layout constants where relevant, and an initialization state. Publish `READY` with release semantics after every ordinary field and contained object is valid. Attachers acquire-load the state before reading them.

A version check should reject both unknown major formats and incompatible feature combinations before resolving any offset. Minor-version compatibility is a deliberate schema rule, not “same struct prefix.” Include header length so newer fields can be skipped safely and verify that the declared total size does not exceed the actual mapping.

Initialization also creates C++ object lifetimes. Zero bytes are not automatically a live instance of every possible type. Restrict the durable/shared schema to types whose lifetime can be established safely in mapped storage, and use placement construction where required before publication. Destructors are not run automatically when another process unmaps or crashes.

Ownership must cover each mutable cache line or slot. A single-writer log has one append owner. An SPSC ring assigns producer and consumer indices separately. Multiwriter structures require atomics, locks, or per-slot state. “Both processes can write” is not an ownership protocol.

A PID is weak owner identity because it can be reused. Combine it with a generation and, on Linux, consider a `pidfd` held through the control plane for lifetime observation. Credentials and a session nonce prevent an unrelated replacement process from being mistaken for the old peer.

Crash recovery must start from writes that may have stopped at any instruction. A recovering process cannot trust a half-written non-atomic record. Use commit markers, per-record sequence numbers, checksums, or copy-and-publish snapshots. If persistence matters, publication order and storage durability are separate, as Section 23.11 explains.

Recovery authority must be exclusive. A process-shared robust mutex, file lock on a control descriptor, or external supervisor can elect one recoverer. Atomically changing `ABANDONED` to `RECOVERING` is useful only if the state itself is valid and every participant agrees on the generation transition.

Test by killing the creator after every initialization phase and killing writers between payload and commit. Restart multiple contenders simultaneously. A recovery design that has been tested only after orderly `close` has not been tested for recovery.

Recovery should preserve evidence before repair. Copy the header, generation, owner identity, and last valid commit sequence to a diagnostic channel before overwriting them. Bound that work so a corrupt length cannot induce an enormous dump. Operators need to distinguish schema mismatch, peer death, capacity overrun, and invariant failure.

## 23.5 Cross-Process Atomics and False Sharing

Hardware-coherent shared pages allow atomic instructions to coordinate processes on ordinary cacheable memory, but C++ does not by itself specify process creation and interprocess synchronization as comprehensively as its thread model. On Linux targets, lock-free `std::atomic` or `std::atomic_ref` is commonly used in shared mappings under a documented compiler, ABI, architecture, and kernel contract. Portable POSIX code can use process-shared pthread primitives.

Require the atomic type to be lock-free when the layout depends on in-place cross-process operation. A non-lock-free `std::atomic` may use process-private runtime locks. Verify `is_always_lock_free`, alignment, size, and representation on every supported build. Never memcpy an atomic object as a state transition.

C++20 `std::atomic_ref` can operate on an existing suitably aligned, trivially copyable field. `required_alignment` may exceed the field type's ordinary alignment. While references exist, all accesses to the target must obey the facility's atomic access discipline. This makes it useful for a fixed shared schema only when layout and lifetime are controlled.

Release/acquire publication works across coherent cores under the target contract:

```text
writer: payload bytes -> release store sequence=N
reader: acquire load sequence=N -> payload bytes
```

The futex syscall does not supply the missing C++ memory order. The atomic state transition must still publish or acquire data.

False sharing crosses process boundaries. Producer and consumer indices placed in one line can bounce ownership even though they are different atomics. Pad independently written hot fields to the measured coherence-line granularity, but do not assume `std::hardware_destructive_interference_size` is available or authoritative for every deployment. Excess padding increases region, cache, and TLB footprint.

Inspect addresses and offsets at startup, assert alignment, benchmark pinned processes, and measure cache/coherence events supported by the CPU. ThreadSanitizer generally does not provide a complete model for arbitrary multiprocess shared mappings; supplement it with an in-process version of the algorithm and explicit protocol tests.

Process restart creates an atomic-lifetime question. A new process must not reconstruct or zero an atomic field while an old process can still access it. Establish exclusion through the supervisor or generation fencing first. Reinitialization is a state transition with the same race requirements as ordinary use, not a shortcut around them.

## 23.6 NUMA Placement

Shared physical pages have one current placement even though several processes map them. On a NUMA host, the thread that first writes an anonymous or shmem page commonly influences placement according to its memory policy. A creator that initializes everything on node 0 can impose remote access on a consumer pinned to node 1.

Partition by ownership where possible. Place producer-owned rings near the producer, consumer-owned structures near the consumer, and accept that truly shared control lines require coherence traffic. For a one-way payload ring, the producer writes slot contents and the consumer later reads them; placing pages near the dominant bandwidth user is a measured tradeoff.

Use `numactl`, `mbind`, or `set_mempolicy` before first touch, subject to cpuset and cgroup restrictions. Policy changes do not necessarily move already resident pages. Automatic NUMA balancing and explicit migration can introduce faults, copying, and mapping updates, so perform placement during setup.

```bash
numastat -p $PRODUCER_PID
numastat -p $CONSUMER_PID
grep -n . /proc/$PRODUCER_PID/numa_maps
```

Both mappings refer to the same pages, so process accounting may present different views or labels. Combine topology, placement, and hardware local/remote memory counters. Record CPU affinity and NIC queue placement when IPC feeds a packet-processing path.

## 23.7 Futex Fast Paths and Kernel Waiting

A **futex** is a Linux facility that lets user space maintain synchronization state in an aligned 32-bit word while the kernel manages wait queues only when blocking or waking is required. “Fast userspace mutex” describes the division of labor, not a guarantee that every operation is fast.

The uncontended lock path is usually an atomic compare-exchange. If it succeeds, no futex syscall occurs. A contender marks or observes contention and calls `futex(FUTEX_WAIT...)`. Unlocking performs a release transition and calls `FUTEX_WAKE` when waiters may exist.

```text
uncontended: atomic CAS -> critical section -> atomic store
contended:   atomic failure -> futex WAIT -> schedule away
unlock:      atomic release -> futex WAKE -> scheduler makes waiter runnable
```

`FUTEX_WAIT` compares the futex word with an expected value while arranging to sleep. If it no longer equals the expected value, the call fails with `EAGAIN` rather than sleeping. The atomic compare-and-block behavior closes the classic gap between a user-space check and queue insertion.

The futex word must be four-byte aligned and reside in readable memory; process-shared use requires mappings of the same underlying storage. The virtual addresses may differ. `FUTEX_PRIVATE_FLAG` or private operations are an optimization only when all users share one process; using them across processes can strand waiters.

`FUTEX_WAKE` wakes up to a requested count but carries no general fairness guarantee. A woken task is runnable, not necessarily running. CPU load, affinity, scheduling policy, priority, migrations, and page faults influence the slow path. Hash-bucket contention inside the kernel can couple nominally unrelated futexes.

The fast-path memory orders remain visible in source. A successful acquire CAS enters a protected region; a release store or RMW publishes its changes on unlock. The waiter may use relaxed operations while only deciding whether to sleep, but it must perform the protocol's acquiring transition before accessing protected payload. Neither returning from `FUTEX_WAIT` nor being selected by `FUTEX_WAKE` is that transition.

Raw futex protocols are hard to make correct. Prefer `pthread_mutex_t`, condition variables, semaphores, or C++ facilities when their process-sharing and deployment contracts fit. Use raw futexes only behind a small, tested abstraction with explicit state transitions.

Trace slow paths with `strace -f -e futex` in diagnosis and with futex/scheduler tracepoints or `perf sched` when timing matters. The absence of futex syscalls in a warmed uncontended run validates only that path. Force ownership overlap to verify wait, timeout, wake, and owner-death behavior.

The futex syscall operates on the 32-bit value and wait-queue key; it does not understand the rest of a mutex state machine. Common locks distinguish unlocked, locked without known waiters, and contended states so unlock avoids unnecessary wake syscalls. A mistaken transition can strand a waiter even when the kernel behaves perfectly.

Futex wait queues consume kernel memory only under contention, but a malicious or broken process can create many waiters or wake unrelated addresses repeatedly. Validate shared offsets before passing their addresses to a futex wrapper and bound the number of application participants. An unmapped futex address produces an error; unmapping while another participant can use it violates the higher-level lifetime protocol.

## 23.8 Spurious Wakeups and Retry Protocols

A wakeup is permission to retry, not proof that a predicate is true. Futex waits can return because of a wake, a signal (`EINTR`), timeout, value mismatch (`EAGAIN`), or other errors. Multiple waiters race after a wake, and another process may consume the condition first.

The correct structure is a predicate loop:

```cpp
// Pseudocode: futex_wait wraps the Linux syscall.
while (state.load(std::memory_order_acquire) == unavailable) {
    auto expected = unavailable;
    futex_wait(&state_word, expected, deadline);
}
// Re-check ownership transition before using protected data.
```

The exact state word and atomic object must satisfy aliasing and representation rules; do not casually treat `std::atomic<int>*` as `int*` for a syscall. A wrapper can store an aligned `std::uint32_t`, use a target-approved atomic access method, and pass the same bytes to Linux under a documented ABI contract.

Lost wakeup prevention depends on ordering the predicate change and wait protocol, not on waking “often enough.” The waiter checks, enters `FUTEX_WAIT` with the observed expected value, and the kernel rechecks before queueing. The changer modifies the predicate and wakes if waiters may exist. Even if a wake occurs just before the syscall, the changed value causes `EAGAIN`.

Relative timeout restarts can exceed an end-to-end deadline after signals or spurious returns. Compute a monotonic absolute deadline and pass the correct futex operation and clock semantics for the deployed kernel API. Treat timeout as another reason to recheck state before reporting failure.

Avoid thundering herds. Waking every waiter for one unit of work causes cache-line contention and scheduler churn. Wake one when one can progress; broadcast only for state transitions that make many predicates true, such as shutdown. Measure retries, sleeps, wake calls, involuntary context switches, and run-queue delay.

Cancellation needs ownership rules. If a timed waiter gives up, the predicate and waiter indication must remain consistent for other participants. A timeout must not clear a shared “has waiters” bit that also represents another sleeper. Production futex algorithms commonly tolerate conservative extra wakeups because a missed wakeup is worse, but still rely on predicate loops for correctness.

Use a stress matrix: waiter arrives before publication, between predicate check and syscall, while the owner wakes, after timeout, and during signal delivery. Run with one and many waiters and force process exit at each state. Count `EAGAIN`, `EINTR`, timeouts, and wake calls; none is by itself a protocol failure.

## 23.9 Process-Shared and Priority-Inheritance Futexes

Process-shared pthread synchronization objects provide a supported abstraction over shared memory and futex machinery on Linux. Initialize attributes with `PTHREAD_PROCESS_SHARED` before constructing the mutex or condition variable in a shared mapping. Every process must use compatible pthread and ABI implementations.

A process-shared mutex is not automatically crash recoverable. With robust attributes, a new locker can receive `EOWNERDEAD` after an owner dies. It then owns the mutex but must validate and repair protected state before calling `pthread_mutex_consistent`. Unlocking without consistency makes the mutex permanently unusable (`ENOTRECOVERABLE`). Robustness reports owner death; it does not know how to repair an order book.

Priority inheritance (PI) futexes let the kernel raise a lock owner's effective priority when a higher-priority waiter blocks, reducing a class of priority inversion. They add kernel bookkeeping and do not solve deadlock, long critical sections, CPU starvation outside the lock, or medium-priority interference before contention is recognized.

Use pthread mutex protocols rather than invoking raw `FUTEX_LOCK_PI` unless implementing a runtime. PI semantics interact with scheduler policies, owner TIDs, robust lists, and kernel versions. Real-time priorities can starve system services and require operational safeguards; test failure and overload on the actual scheduling configuration.

An uncontended process-shared pthread mutex may remain in user space on Linux, but this is an implementation property. Contention can enter the kernel and sleep. Benchmark both paths and ensure no protected code allocates, faults, logs synchronously, or performs blocking I/O.

## 23.10 `eventfd`, `signalfd`, and `timerfd`

Linux event descriptors turn counters, signals, and timers into readable file-descriptor events that integrate with `poll`, `epoll`, and `io_uring` paths. They are notification channels, not payload transport.

`eventfd` maintains an unsigned 64-bit counter. A write adds a value, except that all-ones is invalid; writes block or return `EAGAIN` near counter saturation. A normal read returns the counter and resets it to zero. With `EFD_SEMAPHORE`, each read returns one and decrements by one. `EFD_NONBLOCK` and `EFD_CLOEXEC` set safe creation flags.

This counter semantics naturally coalesces notifications. A producer can publish many ring entries and write once when transitioning from empty to nonempty. The consumer drains the ring and then the event counter under a race-free protocol. Writing for every item restores syscall and wakeup overhead that shared memory was meant to avoid.

`signalfd` converts a blocked signal set into records read from a descriptor. The signals must be blocked through the ordinary signal-mask API in every relevant thread so they are routed to the descriptor rather than delivered to a handler. It simplifies event loops but does not make all signals reliable queues; standard versus real-time signal coalescing rules still apply.

`timerfd` exposes timer expirations as a 64-bit count, allowing the reader to detect missed periods. Select a clock such as `CLOCK_MONOTONIC` for elapsed-time deadlines. Realtime clock adjustments and flags such as cancel-on-set have specific Linux semantics. A readable timer says the deadline passed; scheduler delay determines when code runs.

All three require syscalls, kernel objects, descriptor capacity, and readiness handling. Batch notifications, set close-on-exec, drain counters fully in edge-triggered loops, and define behavior on counter saturation or descriptor closure.

The shared-memory predicate remains authoritative. An eventfd count can be coalesced, consumed by another event-loop iteration, or left over after the ring was drained. On readiness, read the counter and drain shared work until the application predicate says empty. Before sleeping again, recheck after publishing sleeping intent. Treating one eventfd unit as exactly one ring record unnecessarily couples two different capacities.

Descriptor inheritance and restart need attention. A duplicated eventfd refers to the same counter, which is useful for producers but can keep the object alive unexpectedly. Enumerate owners, close stale duplicates, and create a new notification generation when replacing the shared region so old events cannot wake a new session ambiguously.

## 23.11 Memory-Mapped Files, Visibility, and Durability

A shared file mapping can be both an IPC region and an input to persistent storage, but **visibility** and **durability** are different contracts. Cache coherence and synchronization can make a store visible to another process long before the bytes reach stable media.

`MAP_SHARED` writes dirty page-cache pages. Linux writeback may flush them later. `msync` with `MS_SYNC` requests synchronous writeback for a page-aligned range; `MS_ASYNC` schedules or expresses asynchronous intent with behavior that has evolved on Linux. `fsync` on the file descriptor has filesystem-defined data and metadata obligations. None bypasses a volatile drive cache unless the storage stack honors the required flushes.

```text
writer CPU -> coherent cache -> dirty page cache -> filesystem -> device cache -> medium
                 visibility ----------------->        durability boundary varies
```

Atomic release/acquire orders CPU-visible data; it does not persist cache lines. `msync`/`fsync` handles storage interfaces; it does not make a malformed multiword update crash-consistent. A persistent record needs a write protocol: payload, integrity metadata, and commit state ordered so recovery can distinguish complete from torn or missing work.

Storage latency is unsuitable for an unbounded hot path. A common architecture appends to a bounded shared-memory log, hands durability to a separate thread or process, and reports a durable sequence later. The system must specify whether orders may proceed before that acknowledgement and what is lost on process, kernel, or power failure.

Test the stated failure model. Process kill tests do not simulate kernel panic or power loss. Filesystem and device guarantees must come from their documentation and controlled testing; do not infer them from another process immediately reading the bytes.

Writeback granularity can exceed a logical record. Two unrelated records on one page may be flushed together, and storage can expose torn sectors or reordered commands according to its contract. Checksums detect some corruption but do not impose order. Copy-on-write metadata, alternating superblocks, and generation commit records are common ingredients in a recoverable format; each needs a proof for the selected filesystem and device stack.

`MS_INVALIDATE` and cache coherency are often misunderstood. Coherent shared mappings do not normally require readers to call `msync` merely to see another process's CPU stores; they require correct synchronization. `msync` addresses mapping/file writeback and invalidation semantics, not C++ happens-before. Calling it per message adds storage-facing work without repairing a data race.

## 23.12 Truncation and `SIGBUS`

Accessing a mapped file beyond its current valid backing can raise `SIGBUS`. A peer that calls `ftruncate` can therefore turn a previously valid-looking pointer into a process-fatal access. Bounds checks against the original mapping length do not protect against concurrent shrink.

Do not resize a live shared region in place. Create a new generation, size and initialize it completely, transfer its descriptor or publish its name, switch participants, and retire the old mapping only after acknowledgements. This copy-and-switch pattern uses more memory temporarily but gives each mapping an immutable extent.

Linux memfd seals can prevent shrinking after setup when the descriptor was created with sealing enabled. Verify that the required seal was successfully installed before sharing. Filesystem permissions alone do not prevent a process that already has a writable descriptor from truncating.

Installing a `SIGBUS` handler is not a general recovery mechanism. C++ object state may be inconsistent, the faulting instruction may repeat, and most library operations are not async-signal-safe. A handler can record minimal diagnostics or terminate deliberately on an alternate stack; prevention belongs in lifecycle design.

Test truncation in a disposable process. Confirm which access faults, how the supervisor observes termination, and how peers reject the old generation. Never run destructive truncation experiments against a production mapping.

## 23.13 Ring Buffers, Single-Writer Logs, and Snapshots

A shared-memory **ring buffer** separates fixed-capacity storage from sequence-based ownership. In an SPSC ring, the producer owns a slot until a release publication; the consumer acquire-loads the publication, reads the slot, and eventually releases capacity back.

Use monotonically increasing sequence numbers rather than only wrapped indices. The slot is `sequence % capacity`, while the full sequence distinguishes generations. Specify integer wrap assumptions and use sufficient width. Put producer and consumer counters on separate cache lines when measurements justify it.

An eventfd fallback avoids polling forever. The consumer spins for a bounded interval, then prepares to sleep. The transition must avoid a lost wakeup: it records sleeping intent, rechecks the ring, then waits. The producer publishes data and notifies when it observes sleeping intent or an empty-to-nonempty transition. Both sides drain or clear notification state carefully.

A **single-writer log** gives one process exclusive append ownership. Readers track independent cursors, so a slow reader does not contend on the writer's index. Capacity policy decides whether the writer blocks, overwrites old entries, or disconnects lagging readers. Per-record commit sequences let readers distinguish complete data from a writer crash.

Separate reservation from commit in a multiwriter design. A fetch-add can reserve positions quickly, but one stalled writer can leave a hole before later completed records. Readers then need per-slot commit state or a policy for skipping abandoned reservations. A globally advanced published tail is correct only when every preceding record is committed.

Variable-sized records complicate wrap. A record can straddle the physical end, require padding markers, or be copied into two spans. Validate both fragments and make the wrap marker itself crash-safe. Fixed-size slots waste space but give simpler bounds, ownership, and cache behavior—often a favorable trade for bounded trading messages.

A **double-buffered snapshot** builds a complete inactive copy and atomically publishes its generation/index. Readers acquire the index, read an immutable buffer, and may validate the generation again. Reusing the old buffer requires proving no reader still accesses it, through acknowledgements, epochs, or a bounded timing/lifetime contract.

These structures avoid payload syscalls in steady state, not work. They pay cache coherence, memory-order operations, page and TLB footprint, polling or wakeups, and recovery metadata. Compare them with the kernel-mediated mechanisms in Chapter 22 using the same delivery and overload semantics.

## 23.14 Request/Reply, Publish/Subscribe, and Overload Policies

A shared-memory **request/reply** design normally uses separate bounded queues for each direction and a correlation ID. A client must handle server restart, duplicate execution, late replies, and abandoned requests. Reusing a slot does not cancel work already observed by the server.

Choose idempotent operations or persist a deduplication key where duplicate execution is unacceptable. A timeout means the client stopped waiting; it does not prove the server did not act. Generation numbers in correlation IDs prevent a reply from an old server session matching a new request.

Publish/subscribe can use one log with a cursor per subscriber. The publisher's policy for the slowest cursor defines the system:

- block publication and propagate backpressure;
- reserve enough capacity for a bounded lag;
- drop the lagging subscriber and require snapshot recovery;
- overwrite and expose an explicit gap.

Never overwrite silently. A subscriber compares expected and observed sequences and enters a recovery state on a gap. Market data often favors continued publication plus snapshot/replay recovery; risk or audit traffic may require blocking or fail-closed behavior on a separate path.

Memory capacity is fixed before throughput. Define maximum record size, slot count, subscriber count, outstanding requests, and per-peer metadata. Validate all untrusted lengths and offsets even when the producer is “local”; a crashed or compromised peer shares the same bytes.

Measure overload by pausing one peer, not only by increasing average rate. Observe queue age, overwrite/gap count, eventfd writes, sleeps, wakeups, and recovery duration. Tail behavior begins where capacity ends.

Separate traffic classes when their overload contracts differ. A lossy market-data update stream should not share a full queue with mandatory kill-switch commands. Separate rings or reserved control capacity prevent bulk traffic from blocking safety state. This costs pages and descriptors but makes admission policy inspectable.

Backpressure can form cycles: service A waits for reply space from B while B waits for request space from A. Bidirectional protocols need a rule that drains replies and control events even when request production is blocked. Model queue dependencies as a graph and break cycles with ownership, reserved capacity, or a nonblocking failure transition.

## 23.15 Heartbeats, Sequence Numbers, and Stale-Peer Detection

A **heartbeat** is evidence that a peer made progress recently, not proof that it is healthy now. Store a monotonic timestamp or incrementing heartbeat sequence with release semantics; observers acquire-load it and compare against a monotonic local clock.

Timeout selection must tolerate scheduler delay, CPU isolation mistakes, stop-the-world diagnostics, page faults, and overload. An aggressive threshold detects failure quickly but creates false suspicion. A heartbeat thread can remain alive while the business thread is stuck, so include a business-progress sequence such as last consumed request or published market-data number.

Sequence numbers serve several roles: record generation, gap detection, duplicate suppression, and restart identity. Do not compare wrapped unsigned sequences with ordinary `<` unless the maximum distance and modular comparison rule are explicit. A 64-bit counter makes wrap operationally remote but does not excuse a malformed peer from sending arbitrary values.

Stale-peer detection combines signals:

```text
control channel closed
OR pidfd reports exit
OR heartbeat expired and progress stopped
OR shared generation changed
        -> stop using peer-owned slots -> elect recovery -> reconnect
```

PID polling alone is vulnerable to reuse and permission races. A pidfd is Linux-specific and identifies a particular process lifetime, but it does not say whether the process is responsive. Socket closure proves descriptor lifetime ended, not that every shared-memory record was committed.

On declaring a peer stale, stop writing into storage it may still access until exclusion is established. Fencing can mean supervisor-enforced process death, generation change plus rejected old writes, or ownership leases with a safe clock/authority model. Two live processes both believing they own the writer role can corrupt a ring faster than any recovery routine can repair it.

A generation field prevents compliant stale participants from committing, but it cannot stop a compromised or paused old process that resumes without checking. Strong fencing requires revoking its ability to write: terminate it, remove its mapping through process control, or switch to a new object whose descriptor it never receives. Choose the strength according to the failure model.

Log state transitions and generation IDs outside the critical data path. Recovery diagnostics should answer which sequence was last committed, which peer owned it, why staleness was declared, and whether capacity was overwritten. That evidence turns an intermittent timeout into a testable protocol event.

## 23.16 Interview Check

1. Compare POSIX shared memory with `memfd_create` for a region distributed through a Unix-domain control socket.
2. Why are raw pointers invalid in a generally mapped shared region, and which bounds and alignment checks must an offset resolver perform?
3. Design an initialization state machine that handles a creator dying after `ftruncate` but before publishing the layout.
4. What deployment assumptions are required before using `std::atomic` across Linux processes? Why is non-lock-free atomic state dangerous?
5. Trace the uncontended and contended paths of a futex-backed mutex. Which operation supplies release/acquire ordering?
6. How does the futex expected-value check prevent a lost wakeup, and why must the caller still loop?
7. Compare `eventfd` normal and semaphore modes. How can notification coalescing reduce work for a shared ring?
8. Another process can read a newly committed mapped record. Why does that not prove the record is durable?
9. Explain the `SIGBUS` risk from truncation and design a generation switch that avoids resizing a live mapping.
10. A subscriber stalls until a ring wraps. Compare block, overwrite-with-gap, and disconnect/recover policies for market data and audit traffic.
