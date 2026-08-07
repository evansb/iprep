# Chapter 13 — Linux Virtual Memory

Virtual memory lets a process work with a private, orderly address space even though its bytes may be scattered across DRAM, shared with another process, backed by a file, or not resident at all. That convenience hides work that is harmless during startup and disastrous on a latency-critical path: page faults, page-table construction, TLB shootdowns, reclaim, and remote-NUMA access. This chapter separates an address from its backing storage, follows a load through translation, and develops a preparation procedure that makes the steady-state memory path deliberately boring.

## 13.1 Virtual Address Spaces and Mappings

A **virtual address space** is the set of virtual addresses that a process may use together with the mappings that give some of those addresses meaning. A pointer in a C++ program normally contains a virtual address. It is not a DRAM location and does not reveal whether a physical page currently backs the address.

Linux gives each process its own user-space mappings. Kernel mappings occupy a separate, protected portion of the architectural address space; the exact split and isolation scheme depend on the architecture and kernel configuration. Two processes can therefore hold the same numerical pointer value and reach different storage. Threads in one process normally share the same address space.

A mapping relates a virtual interval to a backing object and a policy:

```text
virtual interval       kind               sharing
00400000-0042ffff      executable file    private, read/execute
7f20...-7f21...        shared library     private, read/execute
7f30...-7f34...        anonymous          private, read/write
7f40...-7f41...        shared file        shared, read/write
```

An **anonymous** mapping has no ordinary file supplying its initial contents; new pages read as zero. A **file-backed** mapping associates offsets in a file with virtual pages. A private mapping uses copy-on-write semantics for modifications. A shared mapping allows modifications to the page cache to be observed by other mappings of the same file, subject to proper language-level or interprocess synchronization.

`mmap` reserves an address interval and establishes mapping metadata. It usually does not allocate and initialize every physical frame immediately. Reserving 100 GiB of sparse virtual space can therefore succeed without making 100 GiB resident. Whether future writes can all be satisfied is a separate question, especially when overcommit is enabled.

Address-space layout randomization, or ASLR, changes mapping locations between executions. It improves security but means absolute addresses are unsuitable for persistent data structures or shared-memory links. Store offsets from a mapping base instead:

```cpp
struct SharedHeader {
    std::uint64_t orders_offset; // not Order*
    std::uint32_t capacity;
};
```

Relative addressing also permits two processes to map the same object at different bases. It costs an addition when resolving an offset, but removes a brittle placement requirement.

Inspect a live process before theorizing about its layout:

```bash
cat /proc/$PID/maps
less /proc/$PID/smaps
pmap -x $PID
```

`maps` reports intervals and permissions. `smaps` adds accounting per mapping. `/proc/$PID/pagemap` exposes page-level information only subject to kernel permission restrictions; modern kernels deliberately restrict physical-frame information because it has security implications.

Each `maps` row also carries a file offset, device and inode identity, and an optional path. A pathname ending in `(deleted)` means the directory entry disappeared while the process still holds the mapping; the pages and underlying file object can remain usable. Special labels such as `[heap]`, `[stack]`, `[vdso]`, and `[vvar]` identify conventional regions, but an allocator's arenas need not all appear under `[heap]`. Many are anonymous mappings.

The virtual address width is smaller than the pointer's nominal 64 bits on many current processors. Kernels also choose which part of the supported range is available to user space. Never infer usable capacity from `sizeof(void*)`, and never hide application tags in pointer bits without an architecture-, ABI-, and sanitizer-specific contract.

## 13.2 Pages, VMAs, and Protection

A **page** is the unit at which virtual memory is commonly mapped and protected. A virtual address divides into a virtual page number and an offset within that page. Translation changes the page number; the offset is retained.

```text
virtual address:  [ virtual page number | offset ]
                                      translation
physical address: [ physical frame no. | offset ]
```

Linux represents ranges with common properties as **virtual memory areas** (VMAs). A VMA records a start and end address, access permissions, sharing mode, and backing object. VMAs are kernel metadata, not one object per page. Splitting a range with `mprotect`, partially unmapping it, or creating many small mappings can increase VMA count and make mapping operations more expensive.

Typical permissions are read, write, and execute. `mprotect` changes them for page-aligned ranges. The CPU checks permissions during access, and a violation normally becomes `SIGSEGV`. Write xor execute policies reduce the opportunity to inject executable data. A guard page with no access permission can detect stack or buffer growth into a forbidden region.

Permissions are not a C++ synchronization mechanism. Making a mapping read/write says that a hardware access may be permitted. It says nothing about whether two C++ threads may access the same object without a data race. That contract belongs to the C++ memory model in Chapter 14.

Page size is architecture and configuration dependent. A common Linux base-page size on x86-64 is 4 KiB, but code should query rather than assume:

```cpp
#include <unistd.h>

long page_size = ::sysconf(_SC_PAGESIZE);
```

System calls operating on mappings impose alignment rules. `mmap` file offsets must be a multiple of the page size; `munmap` starts on a page boundary; `mprotect` works on whole pages. A buffer can be cache-line aligned without being page aligned, and the two constraints solve different problems.

VMA changes can trigger page-table updates and invalidate translations on CPUs using the address space. A control path may freely create and protect mappings. A hot path should not use `mmap`, `munmap`, or `mprotect` casually: their work depends on mapping shape, resident pages, other threads, and cross-core coordination.

Protection is page-granular, which creates a memory tradeoff. Guarding each small object with inaccessible pages consumes address space, VMAs, and page-table metadata. Guarding a large arena at its ends is cheaper but detects only boundary crossings. Sanitizers use more elaborate shadow-memory schemes and are valuable in test builds, although their layout and latency differ radically from production.

## 13.3 Page Tables, TLBs, and Page Walks

A **page table** is the in-memory translation structure used by the processor under operating-system control. Modern 64-bit processors use multiple levels so that an unmapped region need not consume leaf entries for every possible page. Sparse address spaces save leaf storage, but upper-level tables still consume memory as regions become populated.

Page-table entries contain an address or next-level pointer plus architecture-defined state such as present, writable, user-accessible, accessed, dirty, executable, or huge-page status. Linux interprets and maintains these bits, but their exact names and update behavior differ between x86-64 and ARM64.

Page-table memory is real kernel-accounted memory. Mapping 1 TiB does not allocate a leaf entry for every potential page, but touching a dense 1 TiB with base pages requires hundreds of millions of translations and substantial page-table storage. Huge pages reduce that metadata as well as increasing TLB reach. `/proc/$PID/status` exposes `VmPTE` on many kernels; it is useful when diagnosing processes with large or fragmented mappings.

Walking several table levels for every load would be prohibitive. A **translation lookaside buffer** (TLB) caches recent translations. Processors commonly have separate first-level instruction and data TLBs and shared higher-level translation caches. Exact capacities and associativities are microarchitecture properties, not Linux or C++ guarantees.

On a TLB hit, address translation participates in the cache lookup with little visible extra work. On a miss, hardware usually walks page tables. The entries themselves must be fetched through the cache hierarchy. A walk can therefore incur several dependent memory accesses, although page-walk caches and overlapping execution reduce the cost in favorable cases. A page walk that finds an absent or disallowed entry raises an exception and enters the kernel; that is a page fault, discussed next.

Large pages increase **TLB reach**: the amount of virtual memory described by a fixed number of TLB entries. They can also eliminate a page-table level for the mapped range. They do not make ordinary data-cache lines larger and do not fix poor data locality within a page.

Address-space identifiers—PCIDs on x86 and ASIDs on ARM—let cached translations be tagged by address space, reducing the need to discard all TLB entries on each context switch. Support and policy depend on processor and kernel. They reduce flushes; they do not abolish invalidation.

When Linux removes a mapping or changes a translation, another core may still have the old entry cached. The kernel performs a **TLB shootdown**, commonly sending interprocessor interrupts and waiting for affected CPUs to invalidate entries. The cost grows with participating CPUs and their responsiveness. Frequent mapping changes in a many-threaded process can therefore produce long, irregular pauses outside the thread that requested the change.

Useful observations include:

```bash
perf stat -e dTLB-loads,dTLB-load-misses,iTLB-load-misses ./engine
perf stat -e minor-faults,major-faults ./engine
```

Event names and availability vary by CPU and kernel. `perf list | grep -i tlb` shows what the target exposes. Interpret a TLB miss count with elapsed work and memory-access patterns; the number alone is not a latency measurement.

TLB pressure depends on access order. A sequential pass through compact records consumes one new translation only at page boundaries, and hardware can overlap some walks. A pointer-chasing structure that touches one node on each of many pages defeats spatial locality and serializes translation with the dependent load. The same number of bytes can therefore produce very different page-walk work.

A controlled translation experiment allocates a region larger than the relevant TLB reach, prefaults it, and visits one fixed offset per page in a permuted order. Prefaulting removes page faults from the timed phase; permutation reduces sequential prefetch effects. Repeat with base and huge pages while keeping the bytes and useful work constant. Report cycles per access and supported TLB/page-walk counters, but do not label their difference “the TLB latency”: cache state, walk overlap, and the permutation all contribute.

Page-table changes deserve a different experiment. Repeatedly mapping and unmapping while worker threads share the address space measures VMA and shootdown behavior, not ordinary lookup. Record worker latency as well as the control thread's syscall duration. The worst disturbance may appear on a remote worker interrupted to invalidate a translation.

## 13.4 Demand Paging and Minor Faults

**Demand paging** defers construction of a usable page mapping until an access requires it. The first access traps into the kernel, which validates the VMA, finds or allocates backing, installs a page-table entry, and resumes the instruction.

A **minor fault** requires no storage read. It is still not minor in the sense of “free.” The fault crosses into the kernel, takes memory-management locks, may allocate a physical frame and page-table page, updates accounting, and invalidates or fills translations.

Fresh anonymous memory illustrates lazy population. Linux may initially satisfy reads using a shared read-only zero page. The first write then allocates a private zeroed frame and maps it writable. Details vary by architecture and kernel policy, but the important distinction remains: the successful `mmap` or heap allocation did not prove that writable pages were resident.

Copy-on-write creates another minor-fault path. After `fork`, parent and child initially share physical pages read-only. A write allocates and copies a page. A private writable file mapping behaves similarly when modified. Copy-on-write avoids eager copying, but moves copy latency to the first write.

Linux may fault around the requested page, and file access may trigger readahead. These heuristics improve throughput for sequential work but make the exact fault work dependent on surrounding access. Automatic stack growth also faults as new stack pages are touched; a guard region bounds that growth.

Prefaulting means touching pages before the critical interval. A single byte per base page is enough to force an anonymous writable page to be instantiated:

```cpp
#include <cstddef>
#include <span>

void prefault_writable(std::span<std::byte> memory, std::size_t page_size) {
    for (std::size_t i = 0; i < memory.size(); i += page_size) {
        memory[i] = std::byte{0};
    }
    if (!memory.empty()) {
        memory.back() = std::byte{0};
    }
}
```

This loop modifies data, so use it only on storage whose contents may be initialized. Run it from a thread pinned to the intended NUMA node if first-touch placement matters. Touching a page once does not guarantee it will remain resident indefinitely.

`MAP_POPULATE` and advice such as `MADV_POPULATE_READ` or `MADV_POPULATE_WRITE` can request population on supporting Linux versions. They can move fault work into the call, but they do not replace error checking or placement verification, and behavior differs for anonymous and file-backed mappings. An explicit application touch has the advantage of following the same read or write intent as later code.

`mincore` can report whether pages of a mapping are currently resident, but residency can change immediately after the query. It also does not say which NUMA node holds a page, whether its translation is in a TLB, or whether its data is in a CPU cache. It is a diagnostic snapshot, not a reservation.

The steady-state goal of a low-latency process is normally zero faults on critical threads. Verify rather than assume:

```bash
perf stat -e page-faults,minor-faults,major-faults -- ./engine
pidstat -r -p $PID 1
```

## 13.5 Major Faults and File-Backed Pages

A **major fault** requires the kernel to obtain page contents from storage before the faulting instruction can continue. The request may queue behind device work and filesystem activity. Its latency distribution is consequently much wider than that of an ordinary memory access or a minor fault.

File-backed mappings use the Linux page cache in the normal buffered-I/O path. If the needed page is already cached, establishing a process mapping can cause a minor fault. If it is absent, the kernel schedules I/O and the fault is major. “Memory mapped” does not mean “already in memory.”

Readahead may bring adjacent pages into cache. Fault-around may map neighboring cached pages. These mechanisms reward sequential access, but a random lookup into a large cold file can still fault independently. Applications that require deterministic lookup latency should load and validate required data before entering the critical phase, then monitor residency and memory pressure.

Dirty shared file-backed pages eventually require writeback. A store usually dirties cache memory; it does not wait for stable storage. Writeback can later consume memory bandwidth, device bandwidth, and kernel work. It may throttle dirtying tasks under pressure. Persistence boundaries are covered in Section 13.12.

A file can be truncated while another process retains a mapping beyond the new end. Accessing pages no longer backed by the file can raise `SIGBUS`. Mapping lifetime, file length, and protocol version are therefore part of a shared-memory design contract.

File-cache residency competes with anonymous memory and other file data. Opening and reading a file during startup can warm it, but an unrelated workload may later evict clean pages. If a critical structure must remain independent of file-cache eviction, copy its validated contents into prepared anonymous memory or lock a carefully bounded mapping where policy permits. That choice consumes private memory and startup bandwidth in return for a clearer residency contract.

Major-fault counters help identify the symptom, while block and filesystem tracing can identify the source:

```bash
perf stat -e major-faults ./reader
iostat -xz 1
```

Do not run high-volume tracing on a production hot path without quantifying its observer effect.

## 13.6 Anonymous Allocation, `brk`, and `mmap`

Linux exposes mapping primitives; a C++ allocator builds allocation policy on top. Historically, `brk` extends one contiguous process heap. `mmap` creates independent mappings, and `munmap` removes them. General-purpose allocators commonly obtain arenas through both mechanisms and serve small allocations from already acquired chunks.

The exact threshold at which an allocator uses a direct mapping is allocator configuration, not a C++ or Linux promise. Consequently, `new` may reuse a warm size-class block, extend an arena, call `mmap`, fault new pages, or take allocator locks. A benchmark that measures only the warm reuse case has not characterized the worst case.

Mapping flags define important semantics. Exactly one of `MAP_PRIVATE` and `MAP_SHARED` selects copy-on-write or shared updates. `MAP_ANONYMOUS` removes an ordinary file from the backing. `MAP_FIXED` can replace existing mappings at the requested address and is dangerous in a live process; Linux's `MAP_FIXED_NOREPLACE` is safer when a design must attempt a fixed range because it fails on collision. Most applications should let the kernel choose an address and use offsets internally.

The principal mapping operations are:

| Operation | Purpose | Latency risks |
|---|---|---|
| `mmap` | Create a mapping | VMA work; later faults; possible file work |
| `munmap` | Remove a mapping | page-table teardown; shootdowns; deferred cleanup |
| `mprotect` | Change permissions | VMA splits/merges; page-table updates; shootdowns |
| `mremap` | Resize or move a mapping | metadata changes; movement or page-table work |
| `madvise` | Give a usage hint or request an action | semantics and work depend on advice and kernel |

Overcommit lets Linux promise more anonymous virtual memory than it could necessarily back at once. Policy is controlled by kernel settings and cgroups. A successful allocation may therefore be followed by failure when pages are first written, or by an OOM decision under later pressure. A bounded HFT design reserves capacity, touches it, and treats any failure during preparation as a startup failure rather than postponing it to order processing.

`madvise` spans hints and destructive requests. `MADV_SEQUENTIAL` or `MADV_RANDOM` informs file access heuristics; `MADV_DONTNEED` permits contents or residency to be discarded according to mapping type; huge-page advice influences THP eligibility. The return from `madvise` confirms that the request was accepted, not that future access has a fixed latency. Record advice in the allocation abstraction rather than scattering it across business logic.

Mapping granularity also affects memory footprint. Thousands of tiny direct mappings consume VMA metadata, page tables, and at least page-granular virtual ranges. Pools and arenas trade individual deallocation for compact metadata and predictable reuse, as described in Chapter 10.

Unmapping a range invalidates every pointer, reference, iterator, and view into it immediately from the application's perspective. Linux may defer some physical cleanup, but C++ lifetime does not wait for that cleanup. A mapping abstraction should own the base and length, prevent concurrent unmapping, destroy nontrivial objects before releasing storage, and make partial-range operations explicit.

## 13.7 Resident, Proportional, Shared, and Virtual Memory

**Virtual size** counts mapped address ranges. **Resident set size** (RSS) estimates pages of a process currently resident in physical memory. Neither equals “bytes owned exclusively by live C++ objects.”

A shared page may appear in the RSS of every mapping process. **Proportional set size** (PSS) divides the page approximately among sharers, producing a more useful aggregate-accounting measure. **Unique set size** is the private resident portion. `/proc/$PID/smaps_rollup` provides an efficient process-level summary on kernels that support it.

RSS itself has measurement caveats. Some fast kernel interfaces use sampled or asynchronously updated counters, while `smaps` walks mappings and is more expensive. Exact totals can change during collection. Use inexpensive counters for monitoring and detailed mapping inspection for diagnosis; do not put repeated `smaps` scans on a critical host without measuring the cost.

```bash
cat /proc/$PID/status | grep -E 'Vm(Size|RSS|HWM)'
cat /proc/$PID/smaps_rollup
```

The categories matter:

- anonymous versus file-backed identifies the backing policy;
- clean versus dirty predicts whether a page may be dropped or needs writeback/swap;
- private versus shared describes accounting and mapping semantics;
- high-water marks show peaks, not current use.

An allocator may retain freed blocks in arenas. Those pages remain mapped and perhaps resident even when no live allocation uses them. This can improve subsequent allocation latency while making RSS much larger than the live object graph. Conversely, a huge virtual reservation can have a small RSS because most pages were never touched.

Cgroups impose another accounting boundary. A process may have ample host memory but face a cgroup limit, reclaim, throttling, or cgroup-local OOM. Inspect the cgroup v2 files that apply to the service, including `memory.current`, `memory.events`, and `memory.pressure`, rather than relying only on host-wide `free` output.

Memory metrics are samples of a changing system. They can identify a footprint trend or fault correlation, but they do not prove that a particular load hit DRAM or cache. Hardware counters and access-specific experiments answer that different question.

Capacity planning should include more than user RSS: page tables, socket buffers, pinned DMA memory, huge-page pools, filesystem cache needed by the service, and kernel slab objects also consume host or cgroup resources. A process can remain below its RSS budget while the machine enters pressure because these surrounding consumers grew.

## 13.8 Reclaim, Swapping, and Memory Pressure

**Reclaim** frees physical frames by evicting or writing back resident pages. Clean file-cache pages can be dropped and read again later. Dirty file-backed pages require writeback. Anonymous pages normally require swap storage to be evicted without being discarded.

Linux uses generations or LRU-like active/inactive policies depending on kernel configuration. Background reclaim attempts to maintain free memory. If it falls behind, an allocating thread may enter direct reclaim and perform work before its allocation completes. Compaction may move pages to create physically contiguous ranges, notably for some huge-page requests.

The tail risk is broader than “my process swapped.” A latency-critical thread can encounter:

- direct reclaim while allocating a page or kernel object;
- contention and memory-bandwidth pressure caused by other reclaim;
- writeback throttling;
- compaction activity;
- a later major fault because a needed file page was dropped;
- cgroup-local pressure despite free memory elsewhere.

Pressure stall information (PSI) reports time in which tasks are delayed by resource pressure:

```bash
cat /proc/pressure/memory
cat /sys/fs/cgroup/memory.pressure
```

The OOM killer is a last-resort policy, not capacity control. Host OOM and cgroup OOM can choose different victims and may kill a process after a large delay. A service should maintain headroom, set appropriate limits, and fail bounded startup reservations early.

Kernel counters provide context for a latency spike:

```bash
vmstat 1
grep -E 'pgfault|pgmajfault|pgscan|pgsteal|compact' /proc/vmstat
cat /proc/pressure/memory
```

`pgscan` and `pgsteal` indicate reclaim scanning and reclaimed pages; compaction counters identify attempts to create contiguous memory. Names vary across kernel versions, and host-wide events do not establish causation for one process. Compare cgroup and per-process evidence, then use carefully scoped tracing if the correlation warrants it.

Swap disabled is not equivalent to reclaim disabled. The kernel can still drop clean file cache, write back dirty data, compact memory, and invoke direct reclaim. It may also have fewer options for anonymous pressure, reaching OOM sooner. The correct objective is adequate headroom and bounded allocation behavior, not a slogan about one kernel setting.

`mlock` and `mlockall` prevent selected pages from being reclaimed once resident, subject to permissions and `RLIMIT_MEMLOCK`. Locking does not automatically fault every future page, prevent all page-table misses, stop NUMA migration under every policy, or eliminate kernel interference. Locking excessive memory harms the rest of the system and can increase global pressure. Use it only for justified mappings, prefault them, check return values, and monitor the operational effect.

With `mlockall`, flags matter. Locking current mappings does not automatically cover mappings created later; locking future mappings can make a later allocation fail when the lock limit would be exceeded. Stack growth is especially dangerous if future locking and strict limits meet an unprepared call path. Deploy with explicit limits, bounded stacks, and a tested failure policy.

## 13.9 Transparent and Explicit Huge Pages

A **huge page** maps more bytes per translation than a base page. On x86-64, common sizes include 2 MiB and 1 GiB in addition to 4 KiB base pages, but availability and naming are architecture dependent.

Transparent Huge Pages (THP) let Linux promote eligible ordinary mappings, automatically or under advice. Explicit hugetlb mappings reserve pages from configured huge-page pools and provide stronger control over size and availability. These are different mechanisms with different failure and accounting behavior.

Benefits come from translation:

- more memory covered by each TLB entry;
- fewer leaf page-table entries;
- fewer TLB misses for large, dense working sets.

Costs come from granularity and management:

- internal waste when only a small fraction is used;
- larger zeroing or copy-on-write work;
- allocation or compaction stalls;
- promotion, collapse, and splitting activity;
- fewer independently placeable units for NUMA policy.

THP policy may be `always`, `madvise`, or `never`, with additional per-size controls on newer kernels. Read the live system rather than assuming a distribution default:

```bash
cat /sys/kernel/mm/transparent_hugepage/enabled
grep -E 'AnonHugePages|FilePmdMapped|ShmemPmdMapped' /proc/$PID/smaps
```

Huge pages help only when translation pressure matters. Benchmark the real working set, measure TLB misses, and include startup and fault behavior. A lower mean with occasional collapse stalls may be the wrong trade for a strict tail objective. Explicit hugetlb pages can improve predictability after successful reservation and prefaulting, but deployment must provision and monitor the pool.

Page size can alter contention granularity in the kernel and blast radius on faults without changing cache coherence granularity. A copy-on-write fault on a huge mapping can entail more work or force a split. Likewise, pinning one byte may account or lock a whole large page. Capacity calculations must use the actual mapping size, not the bytes of live objects inside it.

## 13.10 NUMA Topology and First-Touch Placement

A **NUMA node** groups CPUs and memory for which access is relatively local. A CPU can access memory attached to another node, but the path usually has higher latency and consumes interconnect bandwidth. Exact distances belong to the machine topology.

Linux commonly places a new anonymous page according to the policy of the thread that first writes it. This **first-touch** behavior means the thread that initializes a pool influences its physical placement. A single startup thread touching all pools on node 0 can make later threads on node 1 perform remote accesses.

```text
NIC queue 3 -> CPU 19 (node 1) -> order pool on node 1   desired
                              \-> order pool on node 0   remote path
```

Use `lscpu`, `numactl --hardware`, and sysfs to learn topology. `numactl` can bind CPUs and memory for an experiment:

```bash
numactl --cpunodebind=1 --membind=1 ./engine
numastat -p $PID
```

At the API level, `set_mempolicy` establishes a thread policy and `mbind` applies policy to a range. Binding favors selected nodes; interleaving distributes pages across nodes and can increase aggregate bandwidth at the expense of per-access locality. Cpusets and cgroup policies may further restrict allowable CPUs and memory nodes.

Thread migration can turn local memory remote after initialization. Automatic NUMA balancing may sample accesses and migrate pages or tasks to improve throughput, introducing faults and migration work. Whether to disable it is an operational decision requiring measurement; a dedicated, pinned deployment differs from a shared general-purpose host.

Placement policy is not retroactive in every use. Setting a policy before future allocation guides new faults; it does not necessarily move already resident pages. `mbind` can request a policy and, with appropriate flags and permissions, migration, but migration itself copies pages and changes mappings. Perform it during preparation and verify the result rather than attempting repair during the session.

For a packet-processing pipeline, co-locate the NIC receive queue, its interrupt or polling thread, the hot data, and the consumer where the architecture permits. Avoid assuming that CPU affinity alone moves existing pages. Verify placement through `numastat`, `/proc/$PID/numa_maps`, and counters such as local and remote DRAM events when the CPU exposes them.

## 13.11 Cacheability and Mapping Attributes

A mapping's **cacheability** controls how processor caches interact with accesses. Normal DRAM mappings are coherent and cacheable on mainstream Linux systems. Device mappings may use uncacheable, write-combining, or architecture-specific attributes whose ordering and access rules differ sharply.

Two shared mappings of the same normal physical page participate in hardware cache coherence. If one core writes a cache line, coherence eventually makes the new line contents available to another core. This does not make unsynchronized C++ access legal. Hardware coherence answers which bytes caches contain; the C++ memory model answers which interthread observations the program may rely on.

A private mapping initially may refer to the same physical page as another mapping. On write, copy-on-write gives the writer a distinct page. It is then not a communication channel. A shared mapping is required for page-based IPC, along with atomics or process-shared synchronization primitives whose implementation supports the mapping and processes involved.

Alignment operates at several layers:

- page alignment controls mapping boundaries and protection;
- cache-line alignment can isolate independently written state;
- object alignment is required by the C++ type;
- device interfaces may impose DMA alignment.

Shared memory does not prevent false sharing. Two processes repeatedly updating different atomics in one cache line can bounce ownership between sockets exactly as two threads can. Separate writer-owned fields by the measured cache-line size when justified, and verify layout with `sizeof`, `alignof`, and offsets.

DMA introduces another owner. A NIC writes receive buffers without executing CPU stores. Drivers and user-space frameworks establish DMA mappings and the device/CPU synchronization required by the platform. On cache-coherent server systems much of this is hardware-supported, but buffer ownership still controls when software may read or reuse a descriptor. Ordinary C++ atomics coordinate CPU threads; they do not program a device or substitute for its API's DMA barriers.

Do not access memory-mapped device registers as ordinary RAM based only on `volatile`. Device APIs require specified widths, barriers, and accessors; kernel drivers normally provide them. `volatile` expresses observable accesses in C++, not cache coherence, atomicity, DMA synchronization, or interthread ordering.

## 13.12 Shared Mappings, Consistency, and Persistence

**Visibility** means another execution agent can observe a value. **Durability** means the value survives the relevant power-loss or crash model. Cache coherence can support visibility; it does not establish either C++ synchronization or durable storage.

For shared memory between processes, use a protocol with versioning, initialization state, ownership, and synchronization. A common pattern places fixed-width offsets and lock-free atomics in a shared header, but it is valid only if the atomic type is lock-free and suitable across processes on the target implementation. A non-lock-free `std::atomic` may use process-private locks and is not automatically an interprocess primitive.

For a shared file mapping, stores dirty page-cache pages. `msync` requests synchronization of a mapped range; `fsync` operates on a file descriptor and includes filesystem-defined metadata obligations. Precise crash guarantees depend on filesystem, mount mode, storage device, controller cache, and hardware. A successful store, cache-line eviction, or another process seeing the value does not alone prove persistence.

```text
C++ store
   -> CPU cache/coherence
   -> dirty page-cache page
   -> filesystem writeback
   -> block layer / device cache
   -> durable medium
```

Each arrow has its own ordering and failure contract. Persistent-memory systems add cache-line writeback instructions and persistence barriers, but their correct use depends on the platform's persistence domain and a crash-consistent data layout. Treat this as a separate storage protocol, not as ordinary shared-memory synchronization with one extra fence.

A robust append or snapshot format uses checksums or length validation, generation numbers, and a commit marker written in an ordered way. Recovery must tolerate interruption at every write boundary. Latency-sensitive applications often move durable logging to another bounded pipeline so storage stalls do not enter the market-data or order-entry critical path.

## 13.13 Locking, Prefaulting, and Preparing HFT Memory

**Memory preparation** moves optional and variable kernel work out of the critical interval, then verifies that the intended state was achieved. It is a lifecycle phase, not a single system call.

A defensible startup sequence is:

1. Establish CPU affinity and memory policy for the initializing thread.
2. Allocate fixed-capacity pools, rings, stacks, and lookup tables.
3. Initialize every object whose construction might allocate or fault.
4. Write one location in every required page to establish backing and NUMA placement.
5. Request huge pages or selected locks where deployment policy justifies them; check every result.
6. Warm allocator size classes and code paths that are legitimately part of steady state.
7. Record RSS, NUMA placement, page size, and huge-page status.
8. Begin the critical phase and continuously monitor violations.

Preparation must cover thread stacks and thread-local storage as well as heaps. Creating a thread reserves a stack mapping, but deep later call paths can touch new stack pages. Exercise the maximum intended stack depth without invoking undefined behavior. Dynamic libraries, lazy symbol binding, logging buffers, and one-time local-static initialization can also introduce first-use work.

Monitor at least minor and major faults, RSS and high-water marks, TLB misses, local versus remote memory events, reclaim/PSI, cgroup memory events, and allocation failures. Correlate counters with latency timestamps; a system-wide count does not identify the critical thread by itself.

Preparation should have an explicit failure mode. If a page cannot be populated, a lock limit is too low, a huge-page pool is exhausted, or binding selects no online node, continuing with an unprepared fallback silently changes the latency contract. A trading service may refuse to become ready, reduce a declared capacity, or enter a non-trading mode. The policy belongs in deployment configuration and must be visible in health checks.

A pre-session audit can combine several views:

```bash
# Run after allocation and touching, before admitting traffic.
grep -E 'VmRSS|VmHWM|VmLck|VmPTE' /proc/$PID/status
grep -E 'AnonHugePages|Locked|Rss|Pss' /proc/$PID/smaps_rollup
cat /proc/$PID/numa_maps
numastat -p $PID
cat /proc/$PID/stat | awk '{print "minor=" $10, "major=" $12}'
```

Field availability varies by kernel. The `/proc/$PID/stat` counters are cumulative and the parsing shown assumes a simple command name; production tooling should use a robust parser. Save a baseline, then alert on deltas during the critical window. A zero major-fault count with rising minor faults is still a violation of a strict prefaulting objective.

Testing should deliberately invalidate each assumption. Start once with insufficient `RLIMIT_MEMLOCK`, once without the huge-page pool, once under the wrong NUMA binding, and once near the cgroup memory limit. Verify that startup fails or degrades exactly as designed. A happy-path prefault test proves much less than a controlled failure test.

The predictable fast path performs loads and stores through existing mappings to resident, locally placed pages. It avoids VMA changes, arena expansion, page faults, reclaim, compaction, and cross-core TLB invalidation. None of this guarantees that a load hits L1, but it removes several much larger and less bounded sources of delay.

## 13.14 Interview Check

1. A process successfully reserves a 64 GiB anonymous mapping. Which resources have definitely been committed, and what work can still occur on the first write to each page?
2. Explain the difference among virtual size, RSS, and PSS for ten processes mapping the same read-only file.
3. Trace a load that misses the data TLB but finds a present page-table entry. How is that different from a minor page fault?
4. Why can `munmap` in one thread delay threads running on other cores in the same process?
5. Compare Transparent Huge Pages with explicit hugetlb pages for a fixed, prefaulted order-book arena. Which benefits and tail risks would you measure?
6. An engine is CPU-pinned to NUMA node 1, but `numastat` reports most private memory on node 0. Give a likely cause and a correction procedure.
7. Why do hardware cache coherence and a shared mapping not make concurrent non-atomic C++ accesses correct?
8. A memory-mapped log entry is visible to another process. What additional contracts are needed before calling it durable after power loss?
9. Design a startup verification checklist for a service that must encounter no page faults while processing messages.
