# Chapter 24 — File Descriptors and Readiness-Based I/O

Linux exposes files, sockets, pipes, event sources, and many devices through small integer file descriptors. The integer is only a process-local handle; the state that controls offsets, blocking, and lifetime sits in kernel objects behind it. Confusing those levels creates offset races, close-on-exec leaks, and use-after-close bugs that survive ordinary testing. This chapter develops the descriptor model and builds nonblocking state machines whose behavior remains correct under short operations, overload, and concurrent close.

## 24.1 Descriptor Numbers and Open File Descriptions

A **file descriptor** is a nonnegative integer indexing a process’s descriptor table. A successful `open`, `socket`, `accept`, `pipe`, or related call installs a table entry and returns its number. The number is not the file or socket itself.

For an opened file, the descriptor entry refers to an **open file description**, Linux’s kernel record for one open instance. That record contains state including the current file offset and file status flags such as `O_APPEND` and `O_NONBLOCK`. The open file description in turn refers to an underlying object such as an inode-backed file, socket, pipe, or anonymous kernel object.

```text
process descriptor table        system-wide kernel objects

fd 3  ----------------------->  open file description A ----> inode X
fd 8  ----------------------->  open file description A ----> inode X
fd 9  ----------------------->  open file description B ----> inode X
```

Descriptors 3 and 8 in this diagram share an open file description. Descriptor 9 reaches the same inode through a different open file description. The distinction controls offset and flag sharing.

Descriptor flags belong to the descriptor table entry. `FD_CLOEXEC` is the important example: it tells Linux to close that descriptor during a successful `execve`. File status flags belong to the open file description. Changing `O_NONBLOCK` through `fcntl(F_SETFL)` affects other descriptors that share that description.

The `fcntl` commands reflect the split. `F_GETFD` and `F_SETFD` inspect descriptor flags; `F_GETFL` and `F_SETFL` inspect file status flags. `F_SETFL` updates only the subset Linux permits after opening, so preserve unrelated bits returned by `F_GETFL`. Access mode bits are not changed by setting status flags.

The kernel normally allocates the lowest available descriptor number. Close descriptor 4 and the next open may immediately return 4. A log message saying “fd 4 failed” therefore needs a timestamp and object identity; the same integer can name many objects during one process lifetime.

Use RAII to express ownership, but keep its destruction semantics visible:

```cpp
#include <unistd.h>

#include <utility>

class UniqueFd {
public:
    explicit UniqueFd(int fd = -1) noexcept : fd_(fd) {}
    ~UniqueFd() { reset(); }

    UniqueFd(const UniqueFd&) = delete;
    UniqueFd& operator=(const UniqueFd&) = delete;

    UniqueFd(UniqueFd&& other) noexcept
        : fd_(std::exchange(other.fd_, -1)) {}

    UniqueFd& operator=(UniqueFd&& other) noexcept {
        if (this != &other) {
            reset(std::exchange(other.fd_, -1));
        }
        return *this;
    }

    [[nodiscard]] int get() const noexcept { return fd_; }

    int release() noexcept { return std::exchange(fd_, -1); }

    void reset(int replacement = -1) noexcept {
        const int old = std::exchange(fd_, replacement);
        if (old >= 0) {
            ::close(old); // close errors require operation-specific policy
        }
    }

private:
    int fd_;
};
```

This wrapper occupies one `int` in a common implementation and does not allocate. Its destructor invokes a system call when owning a descriptor. Silently ignoring a `close` error is often reasonable for sockets but can hide delayed write errors for files. Retrying `close` after `EINTR` is unsafe on Linux because the descriptor may already have been released and reused; other Unix systems specify different behavior. Durable file code should surface write errors earlier through `fsync` or another explicit completion policy.

RAII solves local lifetime, not shared protocol. Passing `get()` to an asynchronous operation does not transfer ownership. Moving the wrapper while another component retains the integer does not preserve that component’s right to use it. Interfaces should state whether they borrow a descriptor for the duration of a call, duplicate it, or take ownership.

`close` normally removes the table entry early in Linux’s close path, then completes filesystem or device cleanup. This explains both immediate number reuse and late error reporting. The destructor must never throw, so a file writer that cares about such errors needs an explicit `finish` operation before RAII fallback cleanup.

## 24.2 Inodes, Sockets, Shared Offsets, and `dup`

An **inode** represents filesystem object metadata and data mapping; an open file description represents one active open of that object. Opening the same pathname twice normally creates two descriptions with independent offsets. Duplicating a descriptor creates a second reference to the same description and therefore the same offset.

```cpp
#include <fcntl.h>
#include <unistd.h>

int main() {
    const int first = ::open("orders.log", O_RDONLY | O_CLOEXEC);
    if (first < 0) return 1;

    const int duplicate = ::dup(first);
    if (duplicate < 0) {
        ::close(first);
        return 1;
    }

    char byte{};
    (void)::read(first, &byte, 1);     // advances shared offset
    (void)::read(duplicate, &byte, 1); // reads the following byte

    ::close(duplicate);
    ::close(first);
}
```

`fork` gives the child descriptors referring to the same open file descriptions as the parent. Their sequential file operations therefore share offsets. Linux made ordinary `read`/`write` offset updates atomic across a shared open file description in kernel 3.14; applications targeting older kernels needed extra care. `pread` and `pwrite` take an explicit offset and do not change the description’s current offset, which is often clearer for concurrent positional I/O.

`dup` chooses the lowest available new descriptor. `dup2(oldfd, newfd)` atomically replaces `newfd` if necessary; implementing the operation as `close(newfd)` followed by `dup(oldfd)` admits a race in which a signal handler or another thread reuses the number. `dup3` adds flags such as `O_CLOEXEC` and rejects `oldfd == newfd`, whereas `dup2` returns `newfd` unchanged in that case.

New descriptors produced by `dup` and `dup2` do not inherit `FD_CLOEXEC`. Use `dup3(..., O_CLOEXEC)` or set the flag with a race-aware design. In a multithreaded process, creating a descriptor and then setting close-on-exec through a second call leaves a window in which another thread can call `fork` plus `exec`. Prefer creation operations with atomic close-on-exec flags: `open(..., O_CLOEXEC)`, `socket(..., SOCK_CLOEXEC, ...)`, `accept4`, `pipe2`, and `dup3`.

Append mode illustrates shared status. With `O_APPEND`, Linux positions each write at end of file as part of the write operation. Duplicates share that flag. Atomic append placement does not make a multi-call logical record atomic, and behavior on network filesystems can differ because a server protocol may not implement append identically. One complete encoded record per suitable `write` has clearer semantics than header and body writes from competing producers.

Sockets do not have a meaningful file offset, but duplicated socket descriptors share the underlying socket state, receive queue, send queue, and status flags. Concurrent readers consume from the same byte stream or datagram queue. This is coordination, not message fan-out.

Closing one duplicate removes one reference. The open file description survives until its last descriptor and other kernel references disappear. That lifetime rule matters for `epoll` in Section 24.12 and in-flight asynchronous operations in Chapter 25.

## 24.3 Descriptor Limits and Reuse Races

Descriptor allocation is bounded by per-process and system-wide resources. `RLIMIT_NOFILE` controls the descriptor-number ceiling for a process. Exhausting it commonly makes creation fail with `EMFILE`; exhausting the system-wide open-file table can produce `ENFILE`. Sockets, pipes, `eventfd` objects, directory descriptors, and ordinary files all consume entries.

Inspect a running process and system configuration without assuming the displayed limit is a capacity target:

```sh
cat /proc/self/limits
ls -1 /proc/self/fd
sysctl fs.file-max
```

Listing `/proc/self/fd` in a shell describes the shell-side command process, not an arbitrary service. For a service PID, inspect `/proc/PID/fd` with appropriate permission. Opening that directory and running tools also consume descriptors.

Raising `RLIMIT_NOFILE` prevents one form of exhaustion but increases possible memory use. Each descriptor has table state; each underlying socket or file has additional kernel memory, queues, protocol state, and application buffers. A million idle connections are not represented by a million integers alone.

Capacity accounting should cover at least:

| Resource | Typical multiplier |
|---|---|
| Descriptor entries | process descriptors and duplicates |
| Socket memory | receive/send buffers and protocol state |
| Epoll state | watched entries and queued events |
| Application state | connection object, parser, output queue |
| Pages | stacks, payload pools, mappings, allocator arenas |

A limit test that opens empty files exercises only the first row. A connection-capacity test must fill realistic queues and include TLS or protocol state when production uses them.

A **descriptor reuse race** occurs when one execution closes a descriptor while another retains only its integer value. The second execution can operate on a newly opened, unrelated object that reused the number:

```text
thread A                         thread B
--------                         --------
remember fd = 7
                                 close(7)
                                 accept(...) -> 7
read(7, ...)  // wrong connection
```

The safe design gives one component ownership and routes all operations through it, or protects lifetime with synchronization. An `(fd, generation)` pair in user-space event data can reject stale callbacks, but it cannot make a raw syscall safe after another thread closes and reuses the number. The owner must prevent that syscall from being issued.

Do not close a descriptor from one thread merely to wake another thread blocked on it and assume a portable outcome. On Linux, the blocking syscall can hold a reference to the underlying open file description and may complete even after another thread closes the descriptor number. Use an explicit cancellation channel such as `eventfd`, a pipe, shutdown protocol, or API-specific cancellation.

Leak tests should include error paths and exec behavior. `ls -l /proc/PID/fd` reveals current descriptors; sanitizers do not generally diagnose kernel-object leaks. Load tests should exercise acceptance failures, connection churn, and configured limits while checking `EMFILE`, queue occupancy, and recovery. Reserve-descriptor techniques can make an accept loop shed connections under `EMFILE`, but they are operational recovery patterns, not a substitute for ownership correctness.

## 24.4 Readiness Versus Completion

A **readiness model** reports that an operation would not currently block, while a **completion model** reports that a submitted operation has finished. `select`, `poll`, and `epoll` are readiness interfaces. `io_uring`, discussed in Chapter 25, can provide completion-oriented operation.

Readable does not mean “a complete application message is available.” A TCP socket can be readable because one byte arrived, because the peer closed its write side, or because an error is pending. Writable means some progress can normally be made without blocking, not that an arbitrarily large buffer fits.

```text
readiness:
    kernel says fd can make progress -> application calls read -> result

completion:
    application submits read -> kernel/worker performs it -> completion result
```

The readiness application owns the retry state machine and buffers. It may receive readiness, lose a race to another reader, and get `EAGAIN`. The notification is a hint about state, not a reservation of bytes.

Readiness conditions are operation-specific:

| Reported condition | What the application may learn by acting |
|---|---|
| stream readable | bytes, orderly shutdown, or pending error |
| listener readable | at least one accept may make progress |
| stream writable | some send progress or a connection error |
| pipe readable | bytes available or all writers closed |
| timer/event fd readable | counter or expiration state available |

Always consume the API result. Treating the event mask as the final status loses information stored in the socket error or returned byte count.

Regular files differ from sockets. Disk files are normally reported as readable and writable because an operation can be initiated, even though the task can later wait for page cache fill, allocation, writeback, or storage. Linux `epoll_ctl` commonly rejects ordinary regular files with `EPERM`. Readiness APIs do not turn storage latency into nonblocking completion.

Readiness reduces unnecessary blocking and lets one thread multiplex many sources. It does not make parsing, callbacks, copying, allocation, or application queues free. Processing every message from one busy socket before returning to the loop can starve other descriptors. Set per-iteration work budgets when fairness matters.

Completion can reduce syscall traffic and express file operations more naturally, but queue management, cancellation, and buffer lifetime become explicit. Choose the model from operation semantics and workload rather than API novelty.

## 24.5 Blocking and Nonblocking Operation

A blocking I/O call may put the calling task to sleep until progress, a signal, an error, or closure occurs. A descriptor whose open file description has `O_NONBLOCK` asks applicable operations to return instead of waiting for conditions such as socket data or buffer space.

Set nonblocking mode at creation when possible:

```cpp
#include <sys/socket.h>

int listener = ::socket(AF_INET, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
```

For an existing descriptor, read flags before updating them:

```cpp
#include <fcntl.h>

bool set_nonblocking(int fd) noexcept {
    const int flags = ::fcntl(fd, F_GETFL, 0);
    return flags >= 0 && ::fcntl(fd, F_SETFL, flags | O_NONBLOCK) == 0;
}
```

Because `O_NONBLOCK` belongs to the open file description, this affects duplicates. `MSG_DONTWAIT` on socket send/receive calls requests nonblocking behavior for one call and avoids changing shared status.

Nonblocking does not mean wait-free. A syscall still crosses the user/kernel boundary, validates arguments, takes locks, walks protocol state, copies data, and may fault on user memory. Linux can block briefly for internal reasons even when the operation will not wait for socket readiness. Tail analysis must include page faults and contention.

Accepted sockets do not portably inherit all listener flags. On Linux, use `accept4` with `SOCK_NONBLOCK | SOCK_CLOEXEC` to establish both properties atomically. Loop after a readiness notification because multiple connections may be queued, and treat `EAGAIN` as “drained for now.”

Connection establishment has nonblocking semantics too. A nonblocking `connect` commonly returns `-1` with `EINPROGRESS`. Writable readiness later means the attempt finished, not necessarily that it succeeded. Query `SO_ERROR` with `getsockopt`; zero indicates success and a nonzero value identifies failure. Sending immediately based only on `EPOLLOUT` can misclassify a refused connection.

Blocking mode remains appropriate for simple dedicated-thread designs when its scheduling and cancellation behavior meet the service objective. A thread per connection consumes stack address space and scheduler resources; a small fixed set of blocking threads may be predictable for a bounded number of file operations. Nonblocking multiplexing trades kernel sleeping semantics for application state-machine complexity.

## 24.6 Short Operations, `EAGAIN`, and Partial Writes

A successful read or write may transfer fewer bytes than requested. The return value, not the request length, is the completed amount. Correct code advances by that amount and retains the remainder.

For a stream read:

- a positive result is the number of bytes received;
- zero means end-of-stream for a TCP connection or ordinary file;
- `-1` with `EAGAIN` or `EWOULDBLOCK` means no progress in nonblocking mode;
- `-1` with `EINTR` means a signal interrupted the call before data transfer;
- other negative results are errors.

Linux defines `EAGAIN` and `EWOULDBLOCK` to the same value, but portable socket code may check both. A zero-length datagram is valid, so `recv` returning zero on a datagram socket is not an end-of-stream indication.

Partial writes occur when only some socket-buffer or pipe capacity is available, a signal interrupts after progress, or an implementation limit applies. Never resend the whole message after a positive short write; that duplicates the prefix.

```cpp
#include <cerrno>
#include <cstddef>
#include <cstdint>
#include <sys/socket.h>

enum class FlushResult { complete, would_block, peer_closed, failed };

FlushResult flush_bytes(int fd, const std::byte* data,
                        std::size_t size, std::size_t& sent) noexcept {
    while (sent < size) {
        const auto n = ::send(fd, data + sent, size - sent,
                              MSG_DONTWAIT | MSG_NOSIGNAL);
        if (n > 0) {
            sent += static_cast<std::size_t>(n);
            continue;
        }
        if (n == 0) {
            return FlushResult::failed;
        }
        if (errno == EINTR) {
            continue;
        }
        if (errno == EAGAIN || errno == EWOULDBLOCK) {
            return FlushResult::would_block;
        }
        if (errno == EPIPE || errno == ECONNRESET) {
            return FlushResult::peer_closed;
        }
        return FlushResult::failed;
    }
    return FlushResult::complete;
}
```

`MSG_NOSIGNAL` is Linux/POSIX socket behavior used here to receive `EPIPE` instead of process-directed `SIGPIPE` when the peer is closed. Platforms differ; some use a socket option. The unusual `send` result of zero with nonzero length is treated conservatively.

`MSG_WAITALL` asks a blocking receive to wait for the requested length, but signals, errors, disconnect, and message boundaries can still produce a shorter result. It does not replace framing logic. `MSG_PEEK` leaves received data queued; repeated peeking adds syscalls and copies and can race with another consumer.

The retry loop must have a scheduling policy. Spinning immediately on `EAGAIN` wastes CPU and can starve the peer or kernel work needed for progress. In a readiness loop, retain state and enable write interest. In a dedicated low-latency thread, bounded busy polling may be considered only with measured CPU, power, and interference costs.

Signals make retry rules subtle. If a call returns a positive count, use that progress even if a signal also arrived; there is no separate `EINTR` to process. Automatically retry only the `-1/EINTR` case. For a timeout loop, recompute the remaining deadline after interruption rather than restarting the full relative timeout indefinitely.

Linux caps the bytes transferred by one `read`-family call below `SSIZE_MAX`, currently at a kernel-defined limit on common systems. Large transfers require looping even for regular files. Bound each request so pointer advancement and size conversion remain valid.

## 24.7 Application Buffering and State Machines

A nonblocking stream protocol requires an application state machine because transport reads and writes do not preserve message boundaries. The state machine owns partial headers, partial payloads, validation, and output that did not fit.

```text
READ_HEADER --enough bytes--> VALIDATE_LENGTH --valid--> READ_BODY
     ^                              |                       |
     |                              +--invalid--> CLOSE     |
     +------------ compact buffer <--complete message------+

WRITE_IDLE --enqueue--> WRITE_PENDING --short/EAGAIN--> WRITE_PENDING
                              |
                              +--all sent--> WRITE_IDLE
```

Use a bounded input buffer and validate lengths before arithmetic or allocation. A four-byte length of `0xffff'ffff` must not cause a huge resize. Decide whether the protocol allows messages spanning the fixed buffer; if so, stream them into a bounded destination or reject them according to the session contract.

Output ownership must survive until bytes are sent. A `std::span` into a stack-local message is invalid once the producer returns. Copying into a per-connection bounded buffer is simple and predictable. Reference-counting a shared payload can reduce copies but adds control-block traffic and makes final destruction part of some thread’s path.

Backpressure crosses component boundaries. If a peer stops reading, its output buffer grows until the configured limit. At that point the system must close, drop replaceable updates, reject new work, or slow upstream producers. An unbounded `std::vector` converts network congestion into allocator work and memory exhaustion.

Subscribe to writable readiness only while output remains. Stream sockets are usually writable most of the time, so permanent `EPOLLOUT` interest can wake the loop continuously. After a short write, enable it; after draining, disable it.

Fairness needs explicit budgeting. A busy feed can always have more bytes. Process at most a configured byte or message count, then service other descriptors. This slightly delays the hottest source while bounding starvation and control-channel latency.

Test state machines with fragmented headers, one-byte reads, coalesced messages, short writes at every offset, `EINTR`, `EAGAIN`, half-close, invalid lengths, and full output queues. Unit tests can inject syscall results through a narrow wrapper; namespace and socket-pair integration tests exercise kernel behavior.

Keep protocol parsing separate from buffer movement. The I/O layer can expose a contiguous readable region, let the parser consume a reported prefix, and compact only when needed. A ring buffer can avoid compaction but makes wrapped messages span two regions. Either design must prevent the parser from retaining views after the underlying buffer is moved or reused.

State storage affects connection density. A fixed 64 KiB input and output buffer per mostly idle connection consumes substantial virtual and potentially resident memory. Pooling smaller common buffers with a bounded large-message path saves memory but adds ownership transitions. Measure actual message distributions and cap the exceptional path.

Timeout state belongs beside protocol state. Idle, handshake, write-stall, and recovery deadlines mean different things. One timer per connection can create kernel and heap overhead; a timer wheel or ordered structure can amortize management. Expiration processing needs a work budget so a mass timeout does not monopolize the event loop.

## 24.8 Scatter/Gather I/O

**Scatter/gather I/O** transfers data between one descriptor and multiple memory regions in one call. `readv` scatters incoming bytes across `iovec` entries; `writev` gathers outgoing bytes. Socket `recvmsg` and `sendmsg` add address, flags, and ancillary-data support.

```cpp
#include <array>
#include <cstddef>
#include <cstdint>
#include <sys/uio.h>

struct Header {
    std::uint32_t length;
    std::uint32_t sequence;
};

ssize_t write_message(int fd, const Header& header,
                      const std::byte* payload,
                      std::size_t payload_size) noexcept {
    std::array<iovec, 2> parts{{
        {const_cast<Header*>(&header), sizeof header},
        {const_cast<std::byte*>(payload), payload_size}
    }};
    return ::writev(fd, parts.data(), static_cast<int>(parts.size()));
}
```

POSIX gives `iovec::iov_base` type `void*`, forcing the `const_cast` for `writev` even though it does not modify buffers. This example does not handle a short write; the return value can land within either vector. Production code must advance across entries without losing the offset. The header’s native object representation is also not a portable wire format; encode a byte header first.

The kernel validates the vector and total length. The number of entries is bounded by `IOV_MAX`/`_SC_IOV_MAX`, and totals must fit applicable return-value limits. One syscall can reduce entry overhead, but it still reads each vector descriptor and copies or references payload according to the operation.

`recvmsg` and `sendmsg` carry ancillary data in a control buffer. Linux uses this channel for timestamps, credentials, packet information, and descriptor passing on Unix sockets. Parse control messages with the documented macros, check `MSG_CTRUNC`, and keep buffer alignment and lifetime valid.

For datagram sockets, one receive operation returns one datagram up to the supplied capacity. If the buffer is short, truncation semantics depend on flags and API; inspect `MSG_TRUNC`. Scatter/gather can place a fixed header and payload in separate storage, but it does not validate either.

Atomicity depends on the destination. A pipe write at most `PIPE_BUF` bytes has POSIX noninterleaving guarantees under specified conditions. A stream socket preserves byte order, not boundaries between separate writers. A datagram send is one datagram or fails rather than sending a partial datagram in the ordinary case, but `sendmmsg` can stop between messages. Scatter/gather does not impose stronger rules than the underlying object.

Measure `writev` against copying small fields into one contiguous buffer. For small messages, one compact copy can improve locality and simplify partial-write state. For large payloads assembled from existing buffers, gathering can save user-space copying. The crossover belongs to the workload and target kernel.

## 24.9 Datagram Batching with `recvmmsg` and `sendmmsg`

Linux-specific `recvmmsg` and `sendmmsg` process arrays of datagrams in one system call. Each `mmsghdr` embeds a `msghdr` plus the completed message length. Batching amortizes syscall, validation, and loop overhead across packets.

```text
user:    [msg0][msg1][msg2][msg3]
                   |
             one recvmmsg
                   |
kernel:  datagram receive queue
```

The application must prebuild buffer and `iovec` arrays and reset fields that the kernel updates before reuse. Every buffer remains owned by the application, while any zero-copy or advanced mechanism can impose additional lifetime rules. A fixed batch avoids allocation but reserves memory per socket or worker.

`recvmmsg` returns the number of messages received. With nonblocking behavior, it can return `-1` and `EAGAIN` when none are available. Once at least one message has been received, later errors may be deferred and the positive count returned. Process exactly that many entries and then call again as policy requires.

`sendmmsg` can send only a prefix of the supplied messages. A positive return is a datagram count, not a byte count. Retain the unsent suffix. Individual `msg_len` fields report bytes for completed datagrams.

Batch size trades syscall reduction against waiting, memory footprint, and fairness. A nonblocking receive should normally take what is queued rather than wait to fill a target batch. A large drain batch can monopolize the event loop and delay order or control sockets. Set a maximum and measure burst distributions.

Batch arrays should be reused, but reset only fields required by the API. Clearing a large matrix of payload and control buffers before every call spends memory bandwidth. Conversely, stale `msg_controllen`, flags, or address lengths can make parsing incorrect. Encapsulate preparation and add tests that reuse the same array across full, partial, and empty calls.

Datagram loss is not reported by `recvmmsg` itself. Sequence numbers detect application-level gaps; `SO_RXQ_OVFL` ancillary data and kernel counters can expose some socket drops. NIC, driver, backlog, socket, and application queues have separate loss points, developed in Chapter 31.

`MSG_DONTWAIT` applies per call. Timestamp and packet-info ancillary data still require per-message control buffers and parsing. `strace -c` can show syscall-count changes, while `perf stat` and end-to-end histograms reveal whether reduced calls improve the intended path. `strace` itself perturbs execution and should not be used for production latency numbers.

## 24.10 `select` and Descriptor-Set Copying

`select` reports readiness through bit sets supplied for read, write, and exception conditions. The caller passes one more than the largest descriptor number. Linux modifies the sets to contain only ready descriptors and can modify the timeout, so the application rebuilds them before every call.

```cpp
fd_set readable;
FD_ZERO(&readable);
FD_SET(listener, &readable);

timeval timeout{.tv_sec = 0, .tv_usec = 500};
const int ready = ::select(listener + 1, &readable, nullptr, nullptr, &timeout);
```

This excerpt omits error and signal handling. `FD_SET` is only valid for descriptor numbers supported by the set representation. On glibc systems, that compile-time limit is normally `FD_SETSIZE`, commonly 1,024. Raising the process descriptor limit does not enlarge existing `fd_set` objects; applying the macro to a larger number is unsafe.

The kernel and user-space wrapper copy and scan bit sets proportional to the represented descriptor range, not merely the ready count. For a few low-numbered descriptors the simplicity can be attractive. For thousands of sparse descriptors, copying and scanning add predictable but unnecessary work.

The exception set is not a general error set. On sockets it commonly relates to out-of-band or exceptional conditions; ordinary errors can appear through read/write results and other readiness. Name the set after the condition the program actually handles rather than calling it `errors`.

Signals create races if an application checks a flag and then enters `select`. `pselect` can atomically substitute a signal mask for the wait and uses a `timespec`. Correct signal integration still requires async-signal-safe handlers or alternatives such as `signalfd`.

Do not treat the returned count as bytes or descriptors to process without checking all sets; it counts ready indications across them. Readiness can become stale before the operation, so each descriptor remains nonblocking and handles `EAGAIN`.

## 24.11 `poll` and Linear Scanning

`poll` replaces fixed-size bit sets with an array of `pollfd` records. Each record contains a descriptor, requested event bits, and returned event bits. A negative descriptor is ignored, which can simplify temporary removal from the set.

```cpp
#include <cerrno>
#include <poll.h>
#include <span>
#include <utility>

int wait_ready(std::span<pollfd> descriptors, int timeout_ms) noexcept {
    if (!std::in_range<nfds_t>(descriptors.size())) {
        errno = EINVAL;
        return -1;
    }
    const auto count = static_cast<nfds_t>(descriptors.size());
    for (;;) {
        const int result = ::poll(descriptors.data(), count, timeout_ms);
        if (result >= 0 || errno != EINTR) {
            return result;
        }
    }
}
```

`nfds_t`, the count type expected by `poll`, may differ from `size_t`; the wrapper validates the conversion. A bounded application will usually impose a much smaller capacity as part of construction.

The application passes the entire array on every call, and Linux scans it to find interests and later the application scans `revents`. Cost is linear in array length even when one descriptor is ready. Unlike `select`, descriptor numbers are not bounded by `FD_SETSIZE`.

`POLLERR`, `POLLHUP`, and `POLLNVAL` can appear in `revents` even when not requested. A hangup does not necessarily mean no readable bytes remain; drain queued stream data before final closure according to protocol. `POLLNVAL` often indicates a lifetime bug or stale descriptor.

`ppoll` offers nanosecond timeout representation and atomic signal-mask substitution. Timer precision does not guarantee wakeup precision: scheduler state, timer slack, and system load affect when the task runs.

For a small fixed set, linear scanning can be cache-friendly and competitive with maintaining a more complex kernel interest structure. Select APIs from measured set size, readiness density, update rate, and lifecycle complexity—not from asymptotic labels alone.

The caller usually keeps its own dense array and parallel connection metadata. Removing an entry by swapping the last record changes indices, so callbacks must not retain array positions without an update protocol. Leaving many negative holes preserves indices but lengthens both kernel and application scans.

## 24.12 `epoll` Interest and Ready Lists

Linux `epoll` maintains an **interest list** of watched open-file references and a **ready list** of entries with pending events. `epoll_ctl` adds, modifies, or removes interests; `epoll_wait` returns ready event records without requiring the application to pass every watched descriptor each time.

```text
application                         kernel epoll instance

epoll_ctl(ADD fd, events, token) -> interest list
socket state change --------------> ready list
epoll_wait(events[]) <------------- ready entries
```

This reduces repeated user/kernel copying and scanning when the watched set is large and sparsely ready. It does not promise constant cost for arbitrary lifecycle patterns, and the application still processes every returned event.

Create the epoll descriptor with `epoll_create1(EPOLL_CLOEXEC)`. The older size argument to `epoll_create` is ignored by modern Linux except for validation, but the returned descriptor still needs close-on-exec handling. The epoll instance itself consumes a descriptor and must have clear RAII ownership.

`epoll_wait` writes up to the supplied maximum event count. A tiny event array increases wait calls during bursts; a huge array increases stack or heap footprint and may extend processing monopolies. Reuse a bounded array and track returned batch sizes. A zero timeout polls current readiness and can burn CPU in a tight loop.

An interest is identified using the descriptor number together with the referenced open file description. Duplicating a descriptor can allow separate registrations with different event masks. Closing one duplicate does not necessarily remove events while another reference to the same open file description remains; explicitly remove registrations before closing when lifecycle clarity matters.

`epoll_event::data` is user-provided and can hold an fd, pointer, or 64-bit token. Storing only the descriptor recreates reuse ambiguity. A stable connection slot plus generation counter can let the dispatch layer reject a stale event after a connection object has been recycled. Pointer tokens require object lifetime to extend through event delivery and all concurrent dispatch.

Errors and hangups are reported even if not placed in the requested mask. `EPOLLRDHUP` helps detect stream peer half-close when requested. Event flags do not replace a final nonblocking I/O attempt and `SO_ERROR` inspection where appropriate.

Multiple threads waiting on one epoll instance can create coordination and fairness issues. Edge-triggered wakeup behavior and `EPOLLEXCLUSIVE` on selected registrations can reduce thundering-herd wakeups, subject to Linux API restrictions. They do not eliminate application synchronization or make several threads safe owners of one connection state machine.

Inspect live registrations through `/proc/PID/fdinfo/EPOLL_FD` on supported Linux kernels. Use `strace -e epoll_ctl,epoll_wait` for functional diagnosis, not timing conclusions. Count returned events, stale-token rejections, loop budgets, and time spent in callbacks.

## 24.13 Level, Edge, and One-Shot Operation

**Level-triggered** operation reports a condition while it remains true. **Edge-triggered** operation reports transitions in readiness state. `EPOLLONESHOT` disables an interest after an event until the application rearms it with `EPOLL_CTL_MOD`.

With level triggering, a socket containing unread data remains eligible for notification. An application can read one message, return to `epoll_wait`, and receive another notification. This is forgiving but can repeat notifications when a handler intentionally postpones work.

With `EPOLLET`, the application must consume available work until nonblocking operations report `EAGAIN`. Reading one message and stopping while bytes remain can leave the connection stuck because no new transition is required to occur.

One-shot mode is useful when a worker takes exclusive ownership of a connection after dispatch. The worker drains and updates state, then rearms the interest. Rearming too early permits concurrent processing; forgetting to rearm loses future notifications. The ownership handoff needs C++ synchronization in addition to epoll operations.

Events can be coalesced, duplicated in application terms, or stale by dispatch time. Design handlers to observe current state rather than assume one event corresponds to one packet. A single event may cover many datagrams or accept queue entries.

`EPOLLONESHOT` is not a completion guarantee. A worker can drain the socket and rearm while another thread closes the connection or changes desired interest. Serialize state transitions through one owner or a versioned command queue. The kernel event mask and the application’s desired mask should be updated as one state-machine action.

Level triggering with bounded work per pass is often the clearest baseline. Edge triggering can reduce repeated event traffic for some workloads, but it transfers strict drain obligations to the application. Benchmark both with identical message, fairness, and overload semantics.

## 24.14 Correct Edge-Triggered Draining

An edge-triggered handler is correct only when every relevant descriptor is nonblocking and every operation is repeated until it cannot progress. `EINTR` retries the operation; `EAGAIN` ends the drain. Other outcomes update lifecycle state.

```cpp
#include <array>
#include <cerrno>
#include <cstddef>
#include <span>
#include <sys/socket.h>

enum class DrainResult { drained, peer_closed, failed };

template<class Consumer>
DrainResult drain_stream(int fd, Consumer&& consume) {
    std::array<std::byte, 16 * 1024> buffer{};

    for (;;) {
        const auto n = ::recv(fd, buffer.data(), buffer.size(), MSG_DONTWAIT);
        if (n > 0) {
            consume(std::span<const std::byte>(
                buffer.data(), static_cast<std::size_t>(n)));
            continue;
        }
        if (n == 0) {
            return DrainResult::peer_closed;
        }
        if (errno == EINTR) {
            continue;
        }
        if (errno == EAGAIN || errno == EWOULDBLOCK) {
            return DrainResult::drained;
        }
        return DrainResult::failed;
    }
}
```

The consumer must synchronously copy or parse the span; it becomes invalid on the next receive and when the function returns. The 16 KiB stack object is fixed but not free: it increases stack requirements and is value-initialized here. A per-connection or per-thread buffer can avoid repeated initialization and preserve partial protocol data.

The same drain rule applies to `accept4`, datagram `recvmsg`/`recvmmsg`, `eventfd` reads, and output sends. For output, stop when the queue is empty as well as on `EAGAIN`, then remove `EPOLLOUT` interest.

Unlimited draining can starve other descriptors under sustained input. Edge correctness says drain to `EAGAIN`; fairness says do not monopolize a loop. Reconciling them may require one-shot dispatch to workers, multiple receive queues, level triggering with budgets, or deliberately rearming after a bounded pass. Returning early under pure edge triggering without arranging another notification is incorrect.

Close races require a single lifecycle owner. Mark the connection closing, remove it from epoll, prevent new operations, and destroy buffers only after callbacks or workers can no longer reference them. A generation token catches late events but does not repair premature memory reclamation.

Integration tests should force fragmentation and backpressure with small socket buffers, send until `EAGAIN`, half-close peers, churn descriptor numbers, and run multiple events per wait. Use `socketpair` for deterministic local tests and network namespaces for TCP-specific behavior. Record loop iterations, syscall results, queue occupancy, and event masks; do not rely on “it survived a load test” as a state-machine proof.

An error handler should continue draining when protocol semantics require queued bytes before close, but it must bound that work and reject malformed tails. `EPOLLHUP` and `EPOLLERR` do not absolve the application from calling `recv` or checking `SO_ERROR`. Conversely, repeatedly rearming a permanently failed descriptor creates a busy loop.

## 24.15 Interview Check

1. Distinguish a descriptor number, descriptor-table entry, open file description, and inode or socket object. Which state does each own?
2. How do two calls to `open` differ from `dup` with respect to offsets and `O_NONBLOCK`? What changes after `fork`?
3. Why is `dup2` safer than `close` followed by `dup`, and why are atomic close-on-exec creation flags important in multithreaded programs?
4. Construct a descriptor reuse race and explain why an fd-generation token detects stale dispatch but cannot make concurrent close safe.
5. Compare readiness and completion. Why does readable TCP state not imply a complete application message, and why are regular files special?
6. Walk through every result of a nonblocking `recv` and `send`, including zero, short progress, `EINTR`, `EAGAIN`, and peer closure.
7. Design bounded input and output state machines for a length-prefixed protocol under a peer that stops reading.
8. How must a partial `writev` result be mapped back onto the `iovec` array? What lifetime rules apply to its buffers?
9. Compare `select`, `poll`, and `epoll` for 16 always-busy descriptors and for 100,000 mostly idle descriptors.
10. Explain interest-list identity, duplicate descriptors, close behavior, and stale `epoll_event::data` tokens.
