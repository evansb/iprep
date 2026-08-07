# Chapter 25 — Completion, Files, and the Device Path

Storage I/O does not become predictable merely because a call returns quickly or avoids an explicit user-space copy. A buffered write can finish before durable media sees the data; a mapped load can hide a major fault; a direct read can wait in a device queue; and an `io_uring` submission can complete through several execution paths. This chapter follows operations from submission to completion, identifies who owns every buffer, and distinguishes reduced syscall or copy work from guaranteed low latency.

## 25.1 `io_uring` Submission and Completion Queues

`io_uring` is a Linux asynchronous I/O interface built around a **submission queue** (SQ) and **completion queue** (CQ) shared between user space and the kernel. User space prepares submission queue entries (SQEs); the kernel produces completion queue entries (CQEs). The interface can batch work and completions with fewer system calls than one-operation-at-a-time APIs.

```text
user space                         kernel

fill SQEs -> publish SQ tail ----> consume submissions
                                      |
                                      v
read CQEs <- observe CQ tail <---- publish completions
```

The raw ABI uses `io_uring_setup`, mappings, memory-ordering rules, and `io_uring_enter`. Most applications use `liburing`, which packages those details. This is a Linux API, not part of C++23, POSIX, or the C++ standard library. Operations and flags have been added across kernel releases, and enterprise kernels sometimes backport selected features. Probe supported operations and test the deployed kernel rather than relying only on a nominal version.

A submission entry describes an operation, descriptor or registered-file index, buffer address or registered-buffer selector, offset, length, flags, and a 64-bit `user_data` token. A completion contains `user_data`, a signed result, and flags. A negative result is generally `-errno`; `errno` itself is not the per-completion channel.

The completion means that the submitted operation reached the completion semantics of that opcode. It does not automatically mean a write is durable, a peer consumed socket bytes, or an application callback has run. `write`-like completion follows the corresponding write semantics; durability needs an explicit synchronization operation with filesystem-aware policy.

Submission order is not a general execution-order guarantee. Independent SQEs can run and complete out of order. If operation B semantically depends on A, express that through supported link semantics or submit B after observing A’s completion. Even linked operations require their documented failure rules; a queue’s array order alone is not a transaction protocol.

Submitting is not the same as executing entirely asynchronously in device hardware. Some operations can complete inline or through native asynchronous paths; others may be handled by kernel worker threads when they would block. Worker creation, scheduling, credentials, and contention can affect tails. `io_uring` avoids neither filesystem locks nor page faults merely by changing the interface.

Queue depth bounds the number of outstanding entries the ring can represent, but application objects, kernel requests, pinned pages, device commands, and completion backlog consume further memory. The application must drain CQEs. If it falls behind, CQ overflow handling depends on ring setup and kernel capabilities; overflow counters are a serious capacity signal.

Ring publication is concurrent shared-memory communication. The raw ABI specifies head/tail ownership and memory-ordering requirements. Do not replace liburing’s accessors with ordinary unsynchronized loads because it appears faster on x86-64; ARM64 and compiler reordering make such code incorrect. If a custom wrapper is justified, follow the kernel UAPI contract and test both architecture families.

A minimal liburing flow is conceptually:

```cpp
// EXCERPT: error paths and feature probing omitted.
io_uring ring;
io_uring_queue_init(256, &ring, 0);

io_uring_sqe* sqe = io_uring_get_sqe(&ring);
io_uring_prep_read(sqe, fd, buffer, size, offset);
io_uring_sqe_set_data64(sqe, operation_id);
io_uring_submit(&ring);

io_uring_cqe* cqe = nullptr;
io_uring_wait_cqe(&ring, &cqe);
const int result = cqe->res;
io_uring_cqe_seen(&ring, cqe);

io_uring_queue_exit(&ring);
```

Every omitted return value matters. SQE acquisition can fail when the local submission space is full. Submit can be partial. Wait can be interrupted. A CQE result can be short or negative. The buffer and descriptor relationship must remain valid until completion.

A file read CQE with result zero indicates end of file at the completed position. A socket receive CQE with zero normally indicates orderly stream shutdown, while a zero-length datagram remains a valid message under datagram semantics. Completion APIs do not erase the distinctions from Chapter 24.

Batch CQE processing so the ring can reclaim space, but do not postpone application work indefinitely while waiting for a full completion batch. The oldest completed request is already accumulating response latency. Record submission, kernel completion observation, and final callback boundaries separately.

Use unique operation identifiers rather than raw object pointers unless object lifetime is rigorously tied to completion. An identifier can index a fixed operation table and include a generation. It prevents a late CQE from being mistaken for a recycled request while keeping storage bounded.

## 25.2 Registered Files, Buffers, Polling, and Cancellation

Registration lets an `io_uring` instance retain references to files or buffers so repeated operations can avoid some per-request lookup, reference, mapping, or pinning work. Registration exchanges setup cost and resident resources for a shorter repeated path.

**Registered files** occupy slots in a ring-specific table. SQEs can refer to a fixed-file index instead of performing an ordinary descriptor-table lookup. The kernel holds references, so closing the original descriptor number does not necessarily end the underlying file lifetime. Updating or unregistering slots requires coordination with in-flight operations.

**Registered buffers** make specified memory regions available for fixed-buffer operations. Kernel and configuration details determine pinning and accounting. Long-term pinned memory cannot be reclaimed or migrated normally, can consume lockable-memory allowance, and must be included in NUMA planning. Registering a giant pool “just in case” is not free.

Provided-buffer and buffer-ring features let the kernel select an available application buffer for receives. Completions identify which buffer was used; the application processes and returns it to the pool. This avoids allocating per packet but introduces a strict ownership cycle:

```text
free pool -> kernel selectable -> CQE names buffer -> application owns
    ^                                                  |
    +---------------- application recycles ------------+
```

Recycling before parsing completes creates data corruption. Failing to recycle exhausts the pool. Capacity and full-pool behavior must be observable.

Polling modes target different sources of overhead. `SQPOLL` can use a kernel thread to consume submissions, reducing entry syscalls while consuming CPU and adding setup, privilege, affinity, and idle-policy considerations that vary by kernel. `IOPOLL` polls supported storage completions and generally requires direct I/O and compatible devices/filesystems. Socket busy-poll and multishot operations are separate mechanisms. None should be enabled without measuring CPU occupancy, power, interference, and operational constraints.

Multishot accept, receive, or poll operations can produce several CQEs from one submission on kernels that support the selected opcode and flags. CQE flags indicate whether more completions may follow. The operation object and buffers must live through the final completion, not merely the first.

Linked SQEs express ordering or failure relationships, but their exact cancellation and continuation semantics depend on hard versus ordinary links and opcode results. They reduce user/kernel round trips; they do not create a database transaction. A write linked to `fsync` still needs correct file and directory durability design.

Fixed resources make ring ownership less flexible. A registered-file table is local to the ring; transferring an operation to another ring needs a corresponding registration or ordinary descriptor reference. Per-core rings can improve locality but multiply queue memory, registered tables, workers, and teardown paths. A shared ring reduces duplication while introducing producer coordination.

Cancellation is a race between the target’s progress and the cancel request. The cancel CQE and target CQE are separate facts. The target may have completed before cancellation, may be canceled, or may be uncancelable at that stage. Never free its buffer on “cancel submitted.” Reclaim only after the completion protocol proves no operation can still access it.

Shutdown therefore has a state machine: stop creating operations, request cancellation where useful, continue draining completions, resolve every outstanding operation, unregister resources, and destroy the ring. Timeouts and process termination need explicit policy. Count outstanding requests, cancellation outcomes, CQ overflow, worker activity, and buffer-pool occupancy.

Security posture belongs in deployment planning. `io_uring` exposes a broad kernel interface and has had features restricted by container runtimes, seccomp policies, and system administrators. Probe failure must produce an intentional fallback or startup refusal, not a silently different live-path design. Keep kernel maintenance and feature reduction in the operational cost comparison.

## 25.3 Buffered File I/O and the Page Cache

Buffered file I/O normally uses the Linux **page cache**, which holds file data in memory pages associated with an inode and offsets. A `read` commonly copies bytes from page-cache pages into a user buffer. A `write` commonly copies bytes from the user buffer into cache pages and marks them dirty.

```text
read:   storage -> page cache -> user buffer
write:  user buffer -> page cache --later--> storage
```

If requested data is resident and uncontended, a read may perform a page-cache lookup and copy without device I/O. A cache miss can initiate storage reads and put the task to sleep. Allocation, filesystem locks, checksum or decompression work, memory reclaim, and user-buffer faults can extend either path.

The cache is generally keyed around the opened file’s underlying inode and offsets, so different processes and open file descriptions can benefit from the same resident pages. Each read still copies into its own user buffer. Concurrent truncation, hole punching, direct I/O, and writeback can force coordination beyond a simple cache lookup.

Short regular-file reads are valid near end of file and in other cases allowed by the API. Loop until the logical record is complete, EOF arrives, or an error occurs. A log tailer must distinguish temporary current EOF from permanent session completion and handle file replacement by identity rather than pathname alone.

A successful buffered write normally means bytes were accepted into the kernel’s caching path, not that they are on durable media. `fsync` asks the filesystem to flush file data and metadata needed to retrieve it; `fdatasync` can omit metadata not needed for subsequent data retrieval. Exact persistence guarantees depend on filesystem, mount options, storage cache behavior, barriers, device firmware, and failure model.

Durably creating or renaming a file can require synchronizing the containing directory as well as the file. The sequence and guarantee are filesystem-specific; test crash behavior on the deployed stack. “Called `fsync`” is not a complete durability specification.

The page cache consumes system memory and participates in global reclaim. A large replay or log scan can displace pages useful to the trading process, even if the reader runs elsewhere. Conversely, cached files can make repeated benchmarks appear to measure memory bandwidth rather than storage.

Cold-cache benchmarking is operationally intrusive. Dropping all system caches affects unrelated workloads and requires privilege; it is not an acceptable shared-host technique. Use a disposable host, a dataset larger than the available cache, direct I/O where semantically comparable, or per-file advice with documented limitations. Report which method was used.

Observe residency and I/O through several tools:

```sh
perf stat -e page-faults,minor-faults,major-faults ./reader
pidstat -d -p PID 1
iostat -x 1
```

Event names and permissions vary with `perf` and hardware. `iostat` reports device-level aggregates that can combine unrelated workloads. `/proc/PID/io` distinguishes some process I/O counters, but buffered writes can be attributed differently from later writeback. Use synchronized traces when causality matters.

Application buffering can avoid repeated small syscalls, but it adds another copy and flush policy. A fixed aligned buffer has bounded storage; an expanding stream or vector can allocate. Choose record framing so recovery can distinguish a fully committed record from a torn or partial tail.

## 25.4 Readahead, Dirty Pages, and Writeback

**Readahead** predicts future file access and brings pages into cache before a demand read reaches them. Sequential access benefits when prediction and storage queueing overlap application work. Random access can turn readahead into wasted bandwidth and cache pollution.

Linux readahead behavior depends on kernel version, backing device, filesystem, file history, and access pattern. `posix_fadvise` can provide hints such as `POSIX_FADV_SEQUENTIAL`, `RANDOM`, or `WILLNEED`; `readahead` can initiate a range. Hints do not guarantee residence or completion when the call returns. Verify faults and device traffic.

A written cache page is **dirty** until writeback has propagated it toward storage. Kernel flusher activity writes dirty pages in the background. When dirty memory crosses policy thresholds, writers can be throttled and perform writeback work themselves. A long run of apparently cheap writes can therefore end in a severe tail spike.

Relevant system settings appear under `/proc/sys/vm`, including dirty ratios or byte thresholds and expiration/writeback intervals. Changing them affects the whole host and can increase data-loss exposure or memory pressure. Inspect configuration; do not tune a production host from a microbenchmark result.

Writeback ordering and persistence are not synonymous. A device can report command completion while data remains in a volatile cache unless the protocol, cache settings, and flush commands enforce the required boundary. Filesystems journal metadata or data according to their designs and mount modes. Document whether the requirement is process-crash recovery, kernel-crash recovery, power-loss durability, or replication to another system.

An `fsync` can wait for work caused by earlier writers to the same file or filesystem, not only the caller’s last record. Group commit deliberately lets several records share a flush, improving throughput while adding queueing and coupling their latency. Measure sync latency under competing writeback and near-full filesystem conditions.

Disk-full and quota failures can appear after earlier buffered writes succeeded. Reserve capacity, monitor free space and inode availability, and keep the failure path bounded. Logging an out-of-space error to the same full filesystem is not a recovery mechanism.

Preallocating file space with `fallocate` can move extent allocation out of a live append path on supported filesystems. It does not guarantee that every later write avoids metadata, page allocation, quota, or storage latency. Sparse files and copy-on-write filesystems have additional behavior.

For latency-sensitive event recording, bound in-process queues and decide what happens when storage falls behind. Blocking the order thread couples storage writeback to trading latency. Dropping all records harms diagnosis and possibly compliance. A common design publishes compact records into a bounded per-thread ring and has a dedicated writer batch them, with explicit overwrite, loss counter, or fail-closed policy.

## 25.5 Memory-Mapped I/O

A file-backed `mmap` creates virtual-memory mappings whose pages are associated with file offsets. Access uses ordinary loads and stores; missing translations or pages trigger faults that let the kernel populate mappings. The absence of an explicit `read` syscall does not mean absence of I/O or blocking.

`MAP_SHARED` updates are visible through the shared mapping and can be written back to the file. `MAP_PRIVATE` uses copy-on-write semantics for modifications and does not propagate those private changes to the file. Visibility to another process and durability after power loss are separate properties.

The mapping remains valid after its descriptor is closed because the virtual-memory area holds the needed reference. Truncating the underlying file below a mapped access can cause `SIGBUS`. Growing the file does not automatically enlarge an existing mapping. Lifecycle and file-size ownership need coordination.

An address returned by `mmap` must be checked against `MAP_FAILED`, not null. The requested address is normally a hint unless `MAP_FIXED` variants are used; careless fixed mapping can replace existing mappings. File offsets must satisfy page-alignment rules, while the desired field can begin at a displacement inside the mapped page.

Fault types shape latency:

- a minor fault can install page tables or map an already cached page;
- a major fault requires storage I/O;
- copy-on-write can allocate and copy a page;
- a TLB miss can walk page tables without a software-visible page fault.

Sequential mapped access can benefit from readahead. `madvise` supplies access and residency hints such as `MADV_SEQUENTIAL`, `MADV_RANDOM`, or `MADV_WILLNEED`. `mincore` can report current residency with caveats and races. `MAP_POPULATE` asks Linux to prefault portions during mapping, but its behavior, errors, and interaction with later eviction do not give a permanent residency guarantee.

`mlock` can prevent mapped pages from being reclaimed subject to limits and privileges. It does not preclude TLB misses, cache misses, writeback, scheduler preemption, or storage activity required before locking succeeds. Lock only bounded working sets and monitor the result.

`msync(MS_SYNC)` requests synchronous writeback for dirty shared-mapping pages in a range. Linux has specific behavior for `MS_ASYNC`, and filesystems determine durable ordering. File metadata and directory operations may require additional synchronization. Treat mapping persistence as a protocol, not a single call.

Memory mapping is effective for random read-mostly access, shared file pages, and formats designed around stable offsets. It complicates error handling because faults occur on loads rather than returning ordinary error codes. Explicit `pread` into owned buffers offers a clear completion point and bounded buffer lifetime. Measure both under cold, warm, reclaim, and truncation scenarios.

Mapping a huge file consumes virtual address space cheaply at first but page tables and resident pages grow as it is touched. Random access can create many VMAs only if the application fragments mappings, yet one large VMA can still generate a broad TLB working set. Unmapping ranges forces kernel bookkeeping and translation invalidation; frequent map/unmap is not a free substitute for buffer management.

For shared-memory data structures, ordinary stores becoming visible to another process do not provide crash consistency. C++ atomics can order participating threads or processes only when the mapped objects and implementation support the required shared-memory use; persistence ordering is a separate hardware and filesystem concern.

## 25.6 Direct I/O Alignment and Completion Behavior

Linux `O_DIRECT` requests file I/O that bypasses much of the page cache. Its intent is to reduce cache pollution and duplicate buffering, not to guarantee synchronous device access or lower latency.

Direct-I/O constraints depend on filesystem, kernel, device, offset, length, and buffer address. Misaligned requests may fail with `EINVAL` or, on some filesystems and circumstances, fall back to buffered I/O. Since Linux 6.1, filesystems may report direct-I/O alignment through `statx` with `STATX_DIOALIGN`; support is optional. Older approaches use filesystem-specific documentation and conservative alignment.

Allocate and validate explicitly:

```cpp
#include <cstdlib>
#include <memory>

struct FreeDeleter {
    void operator()(void* p) const noexcept { std::free(p); }
};

using AlignedMemory = std::unique_ptr<void, FreeDeleter>;

AlignedMemory allocate_aligned(std::size_t alignment,
                               std::size_t size) {
    void* p = nullptr;
    if (::posix_memalign(&p, alignment, size) != 0) {
        return AlignedMemory{};
    }
    return AlignedMemory{p};
}
```

`alignment` must be a power of two and a multiple of `sizeof(void*)`; size and file offset must meet the actual I/O constraints separately. This allocation can call the general heap and fault pages on first touch. A hot-path system should allocate, validate, place, and touch a bounded pool during preparation.

Bypassing the page cache means the application owns caching, eviction, buffer reuse, and queue depth. Re-reading the same block can hit storage again. Direct I/O can be issued asynchronously through suitable interfaces, but completion still waits for filesystem and device behavior.

Mixing buffered I/O, mappings, and direct I/O to overlapping regions introduces coherence work and filesystem-specific restrictions. Linux attempts to maintain coherence in supported cases, often through cache invalidation or serialization, which can erase the expected benefit. Avoid the mixture or follow the deployed filesystem’s documented rules.

Linux documents a further fork hazard for outstanding direct I/O into private memory mappings: do not issue `fork` while such operations can access those buffers, unless the memory arrangement meets documented exceptions such as shared mappings or excluded regions. Establishing child copy-on-write address spaces while DMA or I/O writes private pages can corrupt data or produce undefined application outcomes.

Direct I/O can make cache interaction more predictable and reduce page-cache writeback coupling. Device queues, flash translation layers, garbage collection, thermal effects, error recovery, and interrupts remain tail sources. Compare distributions under realistic queue depths and sustained writes, not one warmed block.

## 25.7 Reduced-Copy Mechanisms

A **reduced-copy** mechanism avoids one or more payload copies or transitions; “zero-copy” rarely means zero data movement or zero CPU work. DMA transfers data between device and memory. Kernel code still manages descriptors, page references, checksums, accounting, synchronization, and completion.

Identify the baseline before claiming a saved copy:

```text
file -> page cache -> user buffer -> socket buffer/reference -> NIC DMA
```

A file-to-socket facility may bypass the user buffer. A user-buffer socket zero-copy API may pin/reference user pages rather than copying payload into kernel-owned buffers. These optimize different segments and impose different lifetime constraints.

Linux mechanisms include `sendfile`, `splice`, `tee`, `copy_file_range`, packet `mmap` rings, `MSG_ZEROCOPY`, AF_XDP, and `io_uring` operations. Support varies by descriptor type, filesystem, socket protocol, kernel, device, and security policy. Fallback paths can copy or return errors.

References extend buffer lifetime. With `MSG_ZEROCOPY`, successful `send` return does not mean the application may immediately overwrite the buffer; completion notifications arrive through the socket error queue. Small sends may be copied anyway because page pinning and completion overhead exceed copy cost. Error-queue processing becomes part of correctness.

Page pinning reduces memory-management freedom and can multiply with outstanding depth. Reference counting pages adds cache traffic. A payload assembled from many fragments may exceed scatter/gather limits or stress NIC descriptors. One contiguous copy can sometimes be faster and more predictable.

Measure CPU cycles, memory bandwidth, cache pollution, syscall count, queue depth, and end-to-end latency. Hold application semantics constant: a copy-based path that reports completion when data is safe to reuse is not directly comparable to a reference path measured before its reuse notification.

| Mechanism | Avoided work | New obligation |
|---|---|---|
| `writev` | user concatenation copy | retain all fragments through syscall |
| `sendfile` | explicit user file buffer | manage file/socket offsets and shorts |
| `MSG_ZEROCOPY` | some socket payload copying | pin/reference lifetime and error-queue CQ |
| registered I/O buffer | repeated mapping/lookup work | resident pool and completion ownership |

The table names likely intent, not an implementation promise for every request. Small payloads, unsupported routes, encryption, or driver constraints can select copying paths.

## 25.8 `sendfile`, `splice`, and Zero-Copy Send Concepts

`sendfile` transfers bytes between suitable descriptors inside the kernel, commonly from a regular file to a stream socket. It avoids an explicit user-space payload buffer. The call can return a short count and still requires retry state, offset ownership, and error handling.

When passed an offset pointer, `sendfile` reads and updates that explicit offset without changing the input descriptor’s file position. With a null pointer it uses and advances the shared file offset. The output socket can return `EAGAIN` in nonblocking mode, and the file data may still require storage I/O.

`splice` moves or references pages between a pipe and another supported descriptor; at least one endpoint must be a pipe on Linux. `tee` duplicates pipe-buffer references between pipes without consuming the input. `vmsplice` maps user pages into pipe-buffer operations under nuanced lifetime and flag rules. A common pipeline is:

```text
file --splice--> pipe --splice--> socket
```

The pipe has finite capacity. Short operations and `EAGAIN` require a state machine representing bytes currently in the pipe and remaining file range. Adding a pipe can also add kernel objects, buffer metadata, and scheduling interactions.

File offsets need the same care as ordinary reads. Concurrent calls sharing an implicit offset coordinate through one open file description. Explicit offsets make work partitioning clearer but must not overlap unless duplication is intended. A short transfer advances only by its returned count.

`copy_file_range` requests in-kernel copying between files and can exploit filesystem or storage offloads. Cross-filesystem behavior and fallbacks have changed across Linux versions. It is not a network-send API and is not a universal reflink guarantee.

Kernel TLS, checksums, encryption, and transformations can alter whether data remains referenceable end to end. NIC scatter/gather and offloads still have descriptor and segment limits. Verify the actual path with kernel documentation, tracing, and CPU counters; syscall names alone do not prove copy elimination.

For small order messages, reduced-copy setup and lifetime tracking often cost more than copying tens of bytes into a prepared socket buffer. These mechanisms are usually more compelling for large replay, snapshot, or log-transfer payloads. Benchmark by message-size distribution.

## 25.9 Block-Device and Filesystem Paths

A file operation can traverse the syscall entry, virtual filesystem, concrete filesystem, page cache or direct-I/O mapping, block layer, device driver, hardware queue, device, and completion path. Any layer can split, merge, queue, retry, or reject work.

```text
application
  -> syscall / io_uring request
  -> VFS
  -> filesystem
  -> page cache or direct-I/O mapping
  -> block layer and I/O scheduler
  -> driver submission queue
  -> device controller / media
  -> interrupt or polling completion
  -> wakeup / CQE
```

NVMe exposes multiple hardware submission and completion queues. Linux maps software contexts and CPUs to queues according to driver and topology policy. CPU affinity can reduce cross-core completion traffic, but application, interrupt, device, and NUMA placement must be considered together. Pinning every component to one core can overload it.

Queue depth enables a device to overlap work and reach throughput, while each request waits behind others. Deep queues can amplify latency and hide overload. Different traffic classes—small synchronous journal writes and large replay reads—can interfere despite separate application threads.

Filesystems add their own algorithms: extent lookup, allocation, copy-on-write, checksums, compression, journaling, and locks. A metadata-heavy append and an overwrite of a preallocated extent can reach the same device through different work. Space fragmentation changes mapping and request merging over the lifetime of a file.

Layering obscures device identity. A logical volume can span devices; RAID can fan one request out; encryption transforms data; a network filesystem leaves the local block path entirely. State the full mount and device stack before interpreting a block counter.

I/O schedulers and device policies vary. NVMe commonly uses multiqueue schedulers such as `none` or `mq-deadline`; rotational media has different needs. Inspect rather than assume:

```sh
lsblk -o NAME,TYPE,SIZE,ROTA,SCHED,MOUNTPOINTS
cat /sys/block/DEVICE/queue/scheduler
cat /proc/interrupts
```

Replace `DEVICE` with a resolved block-device name; layered devices, partitions, RAID, device mapper, and containers complicate the mapping from a pathname. `findmnt` and `lsblk` help trace it.

Interrupt completion saves CPU when events are sparse but adds wakeup and interrupt moderation effects. Polling can lower wakeup latency at the cost of continuous CPU and contention. Hybrid policies exist. Device firmware may perform garbage collection, wear leveling, thermal throttling, or recovery outside kernel visibility.

NUMA affects storage buffers as well as network buffers. A device attached near one socket can DMA to pages placed on another node, and a completion handled on a third CPU can add interconnect traffic. First-touch placement, registered-buffer allocation, queue affinity, and consumer placement should form one plan. The optimal mapping depends on PCIe topology and which CPU actually processes the data.

Durability requests can serialize more than payload transfer. Filesystem journal commits, cache flushes, and forced-unit-access commands may create barriers between work. Relaxing them can improve apparent latency while weakening the failure contract. Benchmark only configurations that satisfy the stated recovery requirement.

Use `iostat -x`, block tracepoints through `perf` or eBPF tooling, and filesystem-specific tools to separate application queue time from device service. Tool availability and tracepoint names vary by kernel. Never infer a device’s tail from average utilization alone.

## 25.10 C++17 Filesystem Facilities and Their Syscall Costs

The C++17 `<filesystem>` library provides portable path manipulation and filesystem queries. C++ specifies results and error behavior; it does not prescribe a Linux syscall count, caching policy, or allocation strategy.

Pure path operations can still allocate because `std::filesystem::path` owns character storage. Queries such as `status`, `exists`, `file_size`, `canonical`, and directory iteration call into the operating system. One apparently simple expression can perform several queries if written naively:

```cpp
#include <filesystem>
#include <system_error>

namespace fs = std::filesystem;

bool regular_nonempty(const fs::path& path) noexcept {
    std::error_code ec;
    const fs::file_status status = fs::status(path, ec);
    if (ec || !fs::is_regular_file(status)) {
        return false;
    }
    const auto size = fs::file_size(path, ec);
    return !ec && size != 0;
}
```

The `error_code` overloads avoid exceptions for expected query failures, but library internals may still allocate and exceptional resource failures remain possible depending on operation and implementation. Throwing overloads construct `filesystem_error` with paths and error information.

Caching `status` as above avoids repeating the same query in `is_regular_file(path)`. It does not remove the time-of-check/time-of-use race: another process can replace the pathname before a later open. Security- or correctness-sensitive code should open relative to a trusted directory descriptor with appropriate Linux flags, then inspect the opened object with `fstat`/`statx` as required.

Directory iteration can allocate names, perform multiple directory reads, and optionally query entry metadata. Filesystem and libc behavior determine whether type information is available in directory records or needs separate stats. Network and userspace filesystems can turn metadata queries into remote operations.

`canonical` resolves every component and requires existence; `weakly_canonical` has different handling of nonexistent tails. Symbolic links, mount namespaces, and concurrent rename make path resolution a stateful kernel operation. Avoid canonical strings as security identities. An already opened descriptor and `fstat` result identify the object more directly.

`directory_entry` may cache some status information, but the standard’s observable requirements and implementation determine when queries refresh. Do not build correctness around an assumed cache. If a startup scan needs one consistent view while files change, define snapshot, retry, or rejection semantics.

Use `strace -c` or a filtered syscall trace to learn what the selected library build does functionally:

```sh
strace -f -e trace=%file ./filesystem_probe
```

The trace severely perturbs latency. Keep filesystem discovery, configuration loading, and path canonicalization outside a trading hot path. Convert startup results into stable descriptor-owning RAII objects or compact validated configuration.

## 25.11 Standard I/O Buffering and Locking

C `FILE*` streams add user-space buffering, formatting, orientation, EOF/error state, and normally internal locking around a file descriptor. C++ iostreams add stream sentry objects, formatting state, locale facets, ties, error masks, and extensible buffer objects. These are valuable interfaces, not constant-cost primitives.

Buffering combines small logical writes into fewer system calls. Flushing occurs when a buffer fills, on explicit `fflush`/`flush`, during orderly close, and under implementation- and stream-specific conditions. `std::endl` writes a newline and flushes; `"\n"` does not by itself require a C++ stream flush.

`fflush` and `ostream::flush` push user-space buffered bytes toward the kernel. They do not imply `fsync` durability. Conversely, calling `fsync(fileno(stream))` before flushing the user buffer omits bytes not yet handed to the kernel. A durable stdio protocol must order both layers and check both errors.

Concurrent calls to a shared stream require synchronization under library rules. Internal locks prevent data-structure corruption but create contention and do not guarantee whole multi-call records remain adjacent. C++20 `std::osyncstream` can assemble output per wrapper and emit it atomically relative to other synchronized wrappers, typically using extra buffering and possible allocation.

By default, the standard C++ streams are synchronized with their corresponding C streams to permit defined mixing behavior. Calling `std::ios_base::sync_with_stdio(false)` can improve throughput by removing that synchronization. Call it before I/O, and do not then assume arbitrary interleaving with `stdio` retains order. `std::cin.tie(nullptr)` removes automatic `cout` flushes before input when interactive behavior is unnecessary.

Locale-aware numeric formatting, conversion, dynamic buffer growth, virtual stream-buffer calls, locks, and eventual blocking I/O make formatted streams unsuitable for a critical packet or order path. C++23 `std::print` simplifies formatting but does not make formatting or output nonblocking; library support and implementation paths vary.

A low-latency logger can encode fixed binary records into per-thread bounded buffers and move formatting to an offline or background consumer. It still needs an overflow policy and must preserve enough schema and clock information for decoding. Removing `iostream` from the hot path is an architectural choice, not proof that logging is free.

Check errors explicitly. Buffered output can defer failures until flush or close. Process termination through `_exit`, a signal, or a crash bypasses normal stream cleanup. If a record is required for recovery or compliance, specify its publication and durability boundary independently of standard stream lifetime.

## 25.12 Batching Benefits Versus Queueing Delay

Batching amortizes fixed work across multiple operations. One `io_uring_enter`, `writev`, `recvmmsg`, filesystem write, or device submission can represent many logical records. Larger sequential requests can improve storage throughput and reduce metadata and syscall overhead.

The first item in a batch waits for the batch to fill or for a timer. Under light traffic, fill delay can dominate. Under heavy traffic, draining an enormous batch can starve other queues. Batch size is therefore a latency policy, not merely a throughput knob.

Use a dual trigger: submit when a bounded count or byte threshold is reached, or when a bounded age expires. The timer mechanism, clock read, and wakeup have costs. A dedicated busy thread can check age frequently but consumes a CPU; a kernel timer can sleep efficiently but adds scheduling jitter. Choose from the service objective.

Queueing occurs at multiple levels:

```text
producer ring -> writer batch -> kernel/page cache -> block queue -> device
```

Keeping the producer ring shallow does not prevent dirty-page or device queues from growing. Instrument occupancy and timestamps at boundaries. Little’s Law relates average number in a stable system to average arrival rate and time, but averages do not bound bursts or tails.

For a maximum fill count `B` and time trigger `T`, a lone item waits at most approximately `T` for the application’s batching policy—plus timer and scheduling delay—while a burst can dispatch at `B`. That statement requires the timer to be serviced even when no new item arrives. Checking age only during enqueue leaves the final partial batch stuck.

Batching can improve per-item cache use by processing adjacent descriptors and payloads. It can also enlarge the working set, overflow NIC or storage descriptors, and produce bursty completions. Completion storms contend for the consumer core and make reclamation bursty.

Compare policies under realistic arrival distributions, message sizes, sync requirements, and sustained device load. Report throughput, latency from enqueue to durable or protocol-relevant completion, batch-size distribution, queue high-water marks, CPU use, and loss or rejection. A benchmark that starts timing only after a full batch has formed omits the principal latency cost.

Include recovery traffic in the experiment. A quiet-period batch policy can look excellent until a market-data gap triggers a large replay while synchronous audit records continue. Separate queues and priorities can protect critical records, but strict priority can starve bulk work. Weighted budgets make the tradeoff explicit and measurable.

The right batch is often adaptive within strict bounds: drain already queued work up to a maximum, never wait indefinitely for fullness, and shed or degrade optional work before an unbounded queue forms. Predictability comes from explicit limits and observable overload, not from choosing one magic batch size.

Separate batch formation from device queue depth. A writer can combine 32 records into one buffer while allowing only a small number of buffers outstanding. This amortizes formatting and syscalls without flooding storage. Completion feedback can reduce admission when observed latency or queue occupancy rises, but the control loop itself needs stable bounds and a fail-safe mode.

Retain raw timing and occupancy samples so later kernel, filesystem, and firmware changes can be compared against the same workload contract.

## 25.13 Interview Check

1. Describe the SQ, CQ, SQE, CQE, and `user_data` lifecycle. What exactly does a write CQE guarantee?
2. Why can an `io_uring` operation use a kernel worker, and which tail-latency sources remain even when submission needs no syscall?
3. Compare ordinary descriptors and buffers with registered files, fixed buffers, and provided-buffer rings in ownership, memory, and teardown complexity.
4. Design cancellation-safe buffer reclamation when the target operation can race with its cancel request.
5. Explain why a successful buffered write is not a durability boundary. What additional questions must be answered for crash and power-loss recovery?
6. How do readahead, dirty throttling, and writeback turn sequential file access into latency outliers?
7. Compare `mmap` and `pread` for a large random-access reference file, including faults, error handling, TLB use, and truncation.
8. What constraints must a direct-I/O request meet, and why can `O_DIRECT` improve cache predictability without improving device latency?
9. Draw the copies and ownership transitions for `read` plus `send`, `sendfile`, and a user-buffer zero-copy socket send.
10. How do short `sendfile` or `splice` operations affect state-machine design?
