# Chapter 29 — TCP Behavior and Tail Latency

TCP gives an application one ordered, reliable byte stream between two endpoints, but it cannot guarantee when a byte will arrive or whether a failed connection delivered the last write to the peer application. Connection setup, partial I/O, receiver and network windows, delayed acknowledgments, retransmission, and kernel buffering all shape the latency distribution. This chapter develops the transport state and Linux socket behavior needed to frame messages correctly, diagnose stalls, and decide where TCP belongs in a low-latency trading system.

## 29.1 Three-Way Handshake and Listen Queues

A TCP connection begins by synchronizing sequence-number spaces in a **three-way handshake**. The active opener sends `SYN` with an initial sequence number, the passive endpoint replies with `SYN+ACK`, and the active endpoint acknowledges it.

```text
active opener                         passive opener
     | SYN, seq=x                           |
     |------------------------------------->|
     | SYN+ACK, seq=y, ack=x+1              |
     |<-------------------------------------|
     | ACK, ack=y+1                         |
     |------------------------------------->|
```

A SYN consumes one sequence number even though it carries no application byte. TCP options such as maximum segment size, window scaling, selective acknowledgment permission, and timestamps are commonly negotiated in SYN packets. Options omitted at setup cannot necessarily be enabled later for that connection.

The initial sequence number is selected by each endpoint; it is not normally zero and is not an application message counter. Sequence randomization and generation are host implementation and security concerns. A packet trace displays relative sequence numbers by default in many analyzers, which can hide the absolute wire value unless configured otherwise.

The handshake normally adds one network round trip before the active opener can know the connection is established. TCP permits data in some handshake variants and extensions, but ordinary application design should not assume that arbitrary initial data is accepted or replay-safe. TLS and application authentication add their own exchanges beyond TCP.

On Linux, a nonblocking `connect` commonly returns `-1` with `errno == EINPROGRESS`. Writability later means setup completed or failed; query `SO_ERROR` to distinguish them:

```cpp
// Excerpt: fd is a nonblocking TCP socket and peer is initialized.
int rc = ::connect(fd, reinterpret_cast<sockaddr*>(&peer), sizeof(peer));
if (rc == -1 && errno != EINPROGRESS) {
    return connect_error(errno);
}

// After readiness notification:
int error{};
socklen_t length = sizeof(error);
::getsockopt(fd, SOL_SOCKET, SO_ERROR, &error, &length);
```

A listening endpoint maintains embryonic connection state and completed connections awaiting `accept`. Linux conceptually separates a SYN queue from the accept queue. The `listen` backlog argument primarily limits completed connections on modern Linux, while sysctls such as `tcp_max_syn_backlog` influence incomplete-handshake capacity. Details and clamping vary by kernel.

`accept` removes one completed connection and returns a new descriptor; the listening socket remains. Linux `accept4` can atomically request `SOCK_NONBLOCK` and `SOCK_CLOEXEC`, avoiding races around later flag changes.

On Linux, the accepted socket does not simply inherit every file-status flag from the listening descriptor in the way some code assumes. Use `accept4` for nonblocking and close-on-exec state, then apply per-connection socket options explicitly. Options inherited at the protocol level and options requiring separate setup are kernel-specific; verify with `getsockopt`.

A full accept queue, SYN flood, packet loss, routing delay, and delayed application acceptance create different setup tails. Monitor both queue occupancy and handshake retransmissions. Precreating a client socket does not pre-establish a connection, and a completed TCP handshake does not authenticate a trading session.

## 29.2 SYN Cookies and Connection Setup

A **SYN cookie** encodes enough connection information into the server's SYN-ACK sequence number to avoid retaining normal embryonic state for a request. If the final ACK returns with a valid cookie, the server reconstructs a connection. Linux can use this defense when its SYN queue is under pressure, according to configuration.

Cookies protect scarce state; they are not a normal latency optimization. Encoding capacity is limited, so option negotiation can be constrained depending on kernel implementation and version. Modern Linux recovers more option information than early schemes, but an application must not infer identical setup properties in cookie and ordinary modes.

Repeated cookie use signals overload, attack, or queue mis-sizing. Inspect Linux counters rather than merely enabling cookies and ignoring the cause:

```bash
nstat -az TcpExtSyncookiesSent TcpExtSyncookiesRecv \
          TcpExtListenOverflows TcpExtListenDrops
ss -ltn
```

Counter availability and naming depend on kernel version. Listen overflow can occur after a successful SYN exchange when the application fails to accept quickly enough; SYN queue pressure is a different stage.

Connection setup includes work outside the handshake. The first attempt can perform DNS resolution in user space, route and policy lookup, neighbor discovery, local ephemeral-port allocation, firewall and connection-tracking work, and device queueing. Keep name resolution and configuration discovery off a critical reconnect path when possible, but do not bypass required security controls.

Handshake packets themselves can be lost. TCP retransmits SYN or SYN-ACK according to host policy, normally with increasing delay between attempts. The application-visible connect timeout is therefore a stack and API policy, not one RTT. An application deadline may cancel sooner, but cancellation and descriptor reuse must be synchronized with the event loop so a late completion is not assigned to a new session object.

A reconnect storm magnifies every cost. Many clients can simultaneously time out, retry, fill accept queues, authenticate, request replay, and allocate session state. Use jittered, bounded retry policy and server admission controls. Trading failover deadlines must include session recovery, not only the SYN/SYN-ACK RTT.

Verify setup under dropped SYN, dropped SYN-ACK, full accept queue, unavailable route, and server restart. A loopback benchmark omits most of the state and path that cause production tails.

## 29.3 FIN, RST, Half-Close, and `TIME_WAIT`

A TCP endpoint performs an orderly send-side close with **FIN**. FIN consumes one sequence number and says that no more bytes follow from that sender. Because the two directions are independent, one side can finish sending while continuing to receive; this is a **half-close**.

```text
application A                 application B
shutdown(A, SHUT_WR)
      | FIN ----------------------> |
      | <--------------------- ACK  |
      | <------------- remaining B data
      | ACK ----------------------> |
      | <--------------------- FIN  |
      | ACK ----------------------> |
```

When `recv` returns zero, the peer's FIN has been consumed and all preceding stream bytes have been delivered to that socket. It is end-of-stream, not a zero-byte application message. A local `shutdown(fd, SHUT_WR)` sends the write-side indication while leaving reads available.

An **RST** aborts a connection. It can arise when no socket matches an incoming segment, an endpoint aborts, or protocol state is invalid. A receiver may observe `ECONNRESET`; unread queued data and unsent data can be lost. Setting an abortive linger policy is OS-specific and should not be used casually to avoid teardown states.

`SO_LINGER` changes close behavior on many socket implementations. With a positive linger interval, a closing call may block while queued data is handled. A zero-linger configuration is commonly used on Linux for abortive reset behavior. Exact semantics have edge cases and are not a portable substitute for application acknowledgments. A critical thread should not discover a blocking linger policy during destruction of an RAII descriptor.

Closing a descriptor releases that process reference to the socket. Other duplicated descriptors can keep it open. Buffered output may continue after `close`, and a successful `close` does not prove peer-application consumption. Applications needing acknowledgment of a logical request require an application protocol response.

The endpoint that actively completes teardown commonly enters **TIME_WAIT**. This state permits retransmission of the final ACK and prevents delayed segments from an old incarnation being mistaken for a new connection with the same four-tuple. Simultaneous close changes the state sequence; do not reduce teardown to an invariant “client always owns TIME_WAIT.”

TIME_WAIT duration and reuse policies are implementation choices constrained by TCP's safety goals. On a client opening many short connections to one peer, ephemeral ports and four-tuples can become scarce. `SO_REUSEADDR` does not grant arbitrary safe reuse of an identical active tuple, and aggressive kernel tuning can trade correctness for apparent capacity.

Long-lived sessions amortize handshakes and teardown but require liveness detection and replay logic. Short connections isolate requests but amplify state, port, handshake, and TLS costs. Choose at the session architecture level.

## 29.4 Byte Streams and Application Framing

TCP transports a **byte stream**. It does not preserve calls to `send`, application records, C++ objects, or message boundaries. Two writes can arrive in one read; one write can require many reads; segmentation observed on one host is not framing.

An application protocol must delimit messages. Common methods are fixed-size records, a length prefix, a delimiter with escaping, or a self-describing schema. A binary trading session often uses a fixed header containing type and length.

```text
+----------------+----------------+--------------------+
| length: u32 BE | type: u16 BE   | payload ...        |
+----------------+----------------+--------------------+
```

The length convention must say whether it includes the header. The parser must reject values below the minimum, above configured capacity, or inconsistent with type. Convert network byte order without unaligned typed loads.

```cpp
// Excerpt: returns frames referring to storage owned by InputBuffer.
std::expected<std::optional<FrameView>, FrameError>
peek_frame(const InputBuffer& input) noexcept {
    if (input.size() < 6) return std::optional<FrameView>{};

    const std::uint32_t length = read_be_u32(input.data());
    if (length < 6 || length > max_frame_size) {
        return std::unexpected{FrameError::bad_length};
    }
    if (input.size() < length) return std::optional<FrameView>{};

    return validate_frame(input.first(length));
}
```

The caller must process the returned view before consuming or compacting `InputBuffer`, because either action may invalidate `FrameView`. A different design can transfer an owned buffer or return offsets into stable storage. Zero-copy parsing is a lifetime decision, not merely a missing `memcpy`.

Nested framing deserves its own bound. A packet may contain a batch of records, each with another length. Validate `offset <= total` and `record_length <= total - offset` rather than computing `offset + record_length` first, which can overflow. Reject trailing partial bytes unless the schema defines padding.

Allocate input capacity before the session. A malicious or corrupt length must not cause unbounded `vector::resize`. If a valid frame exceeds the configured bound, close or reject according to protocol policy and record the declared length in bounded diagnostics.

Framing adds branches, buffer movement, and possibly copies. A ring buffer or two-span parser avoids compaction but complicates wraparound. Benchmark complete messages split at every possible byte boundary; the happy case in which one `recv` contains one message is not a sufficient test.

## 29.5 Partial Reads and Writes

A successful stream I/O call may transfer fewer bytes than requested. **Partial I/O** is normal, not an error. `recv` returns currently available bytes up to the supplied capacity; `send` returns bytes accepted into the local socket path.

```cpp
// Excerpt: nonblocking, bounded write state for one framed message.
WriteResult continue_write(int fd, PendingWrite& pending) noexcept {
    while (pending.remaining() != 0) {
        const ssize_t n = ::send(fd, pending.data(), pending.remaining(),
                                 MSG_DONTWAIT | MSG_NOSIGNAL);
        if (n > 0) {
            pending.consume(static_cast<std::size_t>(n));
            continue;
        }
        if (n == -1 && errno == EINTR) continue;
        if (n == -1 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
            return WriteResult::would_block;
        }
        return WriteResult::failed;
    }
    return WriteResult::complete;
}
```

After a short write, retry only the unsent suffix. Retrying the whole application message duplicates bytes in the stream. Preserve buffer ownership until all bytes are accepted or the connection fails.

On Linux, `MSG_NOSIGNAL` prevents `SIGPIPE` for that send when the peer has closed; the call still reports an error such as `EPIPE`. A process-wide ignored `SIGPIPE` is another policy. Portable libraries need platform-specific handling.

Nonblocking `EAGAIN` means progress would block now. Register write readiness only while output remains; always watching writable sockets can create a busy event loop because they are commonly writable. Read readiness similarly means an operation may make progress, not that one full frame is available.

With edge-triggered `epoll`, drain reads until `EAGAIN` and writes until completion or `EAGAIN`; otherwise no new edge may arrive. Bound per-connection work so one busy stream cannot starve others. That bound means deliberately yielding with data still queued and arranging another opportunity to run.

`EINTR` means a signal interrupted the call before the API completed as reported. Retry policies must preserve the current offset and deadline. Blocking convenience loops can wait indefinitely under a slow peer; a session loop should integrate an absolute timeout and cancellation state.

For a read requesting nonzero capacity, `n > 0` supplies stream bytes, `n == 0` supplies orderly EOF, and `n == -1` supplies an error. A zero-length receive request can return zero without observing EOF. Processing received bytes can yield zero, one, or many frames. Do not spin calling `recv` until a complete frame appears on a blocking descriptor unless the protocol deliberately permits that thread to wait without servicing timers or other connections.

Vectored `readv` and `writev` can fill or drain a wrapped ring without compaction. They retain partial-I/O semantics: advance across iovec boundaries by the exact returned byte count. A helper that assumes the first iovec completed after any positive return will duplicate or skip stream data.

## 29.6 Sequence Numbers, Acknowledgments, and Retransmission

TCP assigns a sequence number to each byte, modulo (2^{32}). A cumulative acknowledgment normally names the next byte the receiver expects. SYN and FIN each consume sequence space. Window and timestamp rules help distinguish acceptable segments as sequence numbers wrap on high-rate connections.

```text
sender transmits bytes [1000, 1499]
receiver ACK = 1500

Meaning: TCP has received the contiguous stream through byte 1499.
It does not mean the peer application parsed or acted on those bytes.
```

TCP detects missing data and retransmits according to its algorithms. It suppresses duplicate bytes and presents an ordered stream to the receiving application. “Reliable” means that, while the connection remains viable, TCP works to deliver accepted stream bytes in order or reports connection failure. It does not make delivery infinitely persistent or resolve ambiguity after failure.

Suppose `send` accepts a new order and the connection resets before the application receives a response. The sender may not know whether the peer application received and acted on the order. Reconnect logic needs application sequence numbers, unique request IDs, acknowledgments, and replay rules. TCP sequence numbers are not exposed as business transaction identifiers.

There are several acknowledgment layers:

```text
local send accepted
    -> peer TCP acknowledged bytes
        -> peer application parsed request
            -> venue accepted/rejected business action
```

Only the last application response answers the business question, and even that response can be lost after the venue acts. Reconciliation by stable IDs and query or replay protocol closes the ambiguity. Treating a TCP ACK as an order acknowledgment is a category error.

The TCP checksum detects accidental corruption over header, payload, and an IP pseudo-header, with limits similar to the discussion in Section 28.2. NIC checksum offload affects capture interpretation. Applications requiring stronger integrity or authentication need protocol-layer checks or cryptography.

Retransmission uses buffered sender data, consuming socket memory until acknowledged or discarded. A sender can have many bytes accepted locally while the peer or network is stalled. Monitoring application write completion alone misses this queued exposure.

Packet captures from both endpoints can confirm sequence, acknowledgment, and retransmission behavior, but capture clocks and offloads differ. Prefer hardware timestamps or carefully synchronized hosts when deriving path latency, and never infer peer application timing from ACK timing.

## 29.7 RTO, Fast Retransmit, and SACK

The **retransmission timeout (RTO)** recovers when acknowledgments do not arrive in time. TCP estimates path round-trip behavior and chooses a timeout with variation and safety margins. Exact minimums, backoff, and implementation algorithms vary. A timeout is therefore a large and variable tail event, not a fixed protocol constant.

After an RTO, the sender retransmits and normally reduces its sending aggressiveness. Repeated failure causes exponential-style backoff in common implementations and eventually connection failure according to system policy. A single lost packet can therefore affect far more than one packet's serialization time.

**Fast retransmit** uses evidence from later-arriving data and duplicate acknowledgments to infer a hole before the RTO. Modern stacks incorporate additional loss-detection algorithms, so the textbook count of duplicate ACKs is a conceptual model rather than a complete description of current Linux behavior.

**Selective acknowledgment (SACK)** lets a receiver report noncontiguous byte ranges already received. The sender can retransmit missing ranges without resending every later byte. SACK is negotiated during setup. It reduces unnecessary work but does not remove head-of-line blocking at the receiving application.

```text
received: [0..999] [2000..2999]
missing:             [1000..1999]

cumulative ACK remains 1000
SACK can report the later [2000..2999] block
application still cannot read those later bytes past the hole
```

Linux versions may implement mechanisms such as RACK and tail-loss probes in addition to classic algorithms. Treat their availability, configuration, and counters as kernel-specific. Do not build an application deadline from an assumed retransmission implementation.

Reordering can resemble loss. A sender that retransmits too aggressively wastes bandwidth; one that waits too long expands completion tails. Modern algorithms use timing and SACK evidence to balance those errors. This is why a packet reordered in a test can produce a retransmission even though no packet was permanently lost, and why a duplicate-segment counter alone is not proof of physical duplication.

An RTO can collapse effective throughput because congestion state changes while queued application data remains. After recovery, later messages may drain in a burst, increasing receiver and application queueing. Report recovery completion and time to return to normal queue depth, not just time until the missing segment first reappears.

To characterize loss tails, inject controlled loss away from production and record retransmission type, RTT estimate, congestion state, and application completion. One average RTT cannot predict a loss recovery percentile.

## 29.8 Receive Windows and Flow Control

TCP **flow control** prevents a sender from overrunning receiver-advertised stream capacity. The receiver announces a receive window, `rwnd`, representing bytes it is prepared to accept beyond the acknowledged point. Window scaling, negotiated in the SYN exchange, permits windows larger than the 16-bit header field directly represents.

The receiver window reflects kernel buffer and protocol policy, not immediate application readiness. A slow application allows its socket queue to fill; advertised space shrinks. When it reaches zero, the sender stops ordinary data transmission and uses persist behavior to probe for a window update.

The advertised window can change between packets and is scaled only after negotiation. Packet analyzers often display a calculated scaled value; raw header fields differ. If window scaling was absent from the handshake capture, later interpretation may be wrong. Capture setup or inspect endpoint state before diagnosing a mysteriously small window.

Zero-window recovery prevents a lost window-update ACK from deadlocking the connection, but it provides no low-latency bound. A receiver that stops reading can stall the sender indefinitely within configured connection timeouts.

**Silly-window syndrome** describes inefficient transmission of tiny increments of newly available window or tiny writes. TCP implementations use sender and receiver avoidance strategies. Exact thresholds are not application contracts.

Large receive buffers allow more in-flight data and help high-bandwidth, long-RTT paths. In a low-latency session they can also hide a slow consumer and accumulate stale messages. Size buffers from burst and path requirements, then monitor queue occupancy and application sequence lag.

Linux autotuning and socket options influence buffer limits. The value returned by `SO_RCVBUF` includes Linux accounting conventions and is not identical to advertised window or readable payload at every instant. `ss -tm` and `TCP_INFO` expose related observations, qualified by kernel version.

Flow control is per connection. One stalled connection does not directly shrink another connection's window, but shared process, NIC, qdisc, and network resources can couple them. Splitting traffic over connections changes ordering and state; it is not free isolation.

Application backpressure should start before the kernel reaches a zero window when possible. A bounded output queue can reject new nonessential work or mark the session unhealthy. Otherwise, a large user queue plus send buffer plus network flight forms one hidden backlog whose oldest business message may be far past its deadline.

## 29.9 Congestion Windows and Congestion Control

TCP **congestion control** limits traffic based on inferred network capacity and congestion. The sender's congestion window, `cwnd`, and the receiver's advertised window jointly constrain outstanding data:

```text
usable flight is bounded by min(cwnd, rwnd),
subject to already outstanding bytes and implementation rules.
```

At connection start or after idle, the sender may use slow-start behavior to grow its sending window from an initial value. In congestion avoidance it grows more cautiously. Loss or explicit congestion notification can reduce sending rate according to the selected algorithm.

The Internet does not reserve latency for a TCP trading flow. Congestion control aims at network stability and sharing, not a maximum completion time. A queue can grow before loss or ECN feedback; retransmission and window reduction then amplify the tail.

Linux supports selectable algorithms, commonly configured globally and sometimes per socket with `TCP_CONGESTION`. Available algorithms depend on kernel build and modules:

```bash
sysctl net.ipv4.tcp_available_congestion_control
sysctl net.ipv4.tcp_congestion_control
ss -ti dst 192.0.2.10
```

Names such as CUBIC or BBR describe families of implementation behavior, not portable socket semantics. Algorithm changes can affect pacing, queue occupancy, throughput, and coexistence with other traffic. Validate them with network owners and realistic competition; do not tune around a private benchmark that owns the link.

ECN allows capable endpoints and routers to signal congestion without first dropping a packet. Negotiation, marking, and response depend on endpoint and network configuration. ECN can reduce loss but cannot remove queueing or guarantee support across a path.

Congestion window is usually maintained in bytes or segment-related internal units depending on implementation, and diagnostics may display segments. Pacing can spread sends even when `cwnd` permits a burst. Qdisc and NIC queues add another layer after TCP. Seeing unused congestion window therefore does not prove that a packet has reached the wire.

For a low-volume order session, congestion window may rarely constrain an isolated write, yet previous unacknowledged data, recovery bursts, or reconnect replay can make it relevant. Diagnose the actual flight and windows before assuming the application write is “too small for congestion control.”

## 29.10 MSS, Nagle, Delayed ACK, and `TCP_NODELAY`

The TCP **maximum segment size (MSS)** is the largest TCP payload an endpoint advertises for received segments, normally derived from interface MTU minus IP and TCP headers. It is not the path MTU itself, and TCP options reduce payload available within a given IP packet.

Nagle's algorithm reduces tiny-segment overhead by allowing a small write to wait while earlier data remains unacknowledged. Delayed acknowledgment allows a receiver to wait briefly for more data or a response to acknowledge efficiently. Their interaction can add visible delay to request/response patterns with small writes.

`TCP_NODELAY` disables Nagle's small-write coalescing for a socket. It does not disable all kernel buffering, segmentation offload, qdisc queueing, interrupt moderation, congestion control, or delayed ACK behavior at the peer.

```cpp
int enabled = 1;
if (::setsockopt(fd, IPPROTO_TCP, TCP_NODELAY,
                 &enabled, sizeof(enabled)) == -1) {
    return socket_error(errno);
}
```

Set it deliberately and verify with `getsockopt`. Even with `TCP_NODELAY`, writing a six-byte header and then its payload in separate syscalls performs extra calls and may produce different segment behavior. Scatter/gather `sendmsg` can express one logical write without concatenating buffers.

Linux offers `TCP_QUICKACK` as a nonportable request to alter acknowledgment behavior. It is not a permanent guarantee that every segment is acknowledged immediately; the stack can return to normal delayed-ACK policy. A sender cannot force the remote application or its kernel to acknowledge on an application deadline.

Disabling Nagle increases packet rate for tiny writes and can waste link capacity. Leaving it enabled can add waiting. Measure representative message sequences, including previous unacknowledged bytes, rather than comparing one write on an idle loopback socket.

The strongest optimization is often protocol-level aggregation: construct the complete bounded order-entry frame and issue one vectored send. This reduces syscall and tiny-write interactions while preserving immediate dispatch. Do not delay an urgent message merely to fill an arbitrary batch; define a maximum batching interval and bypass it for latency-sensitive classes.

MSS can change after path-MTU discovery influences effective segmentation. Encapsulation, tunnels, and TCP options alter available payload. A sender that writes one MSS-sized payload based on a local interface constant is not guaranteed one wire segment across the real route.

## 29.11 Corking, Segmentation, and Receive Offloads

`TCP_CORK` is a Linux option that asks the stack to hold partial frames so the application can assemble a larger segment. It is useful for bulk headers plus payloads but conflicts with an immediate-latency objective if the application forgets to uncork. Linux documents a ceiling on corked waiting, but exact timing is not a deadline and can change with kernel behavior.

`MSG_MORE` supplies a per-send hint that more data follows. It avoids persistent socket option changes but remains a Linux-oriented behavior. For bounded trading messages, a single `sendmsg` with iovecs is often clearer.

Segmentation offloads change where packets are divided. TCP segmentation offload (TSO) lets the host pass a large buffer to the NIC, which emits MSS-sized wire segments. Generic segmentation offload (GSO) performs related work in software later in the path. On receive, GRO or LRO can combine adjacent segments before higher-level processing.

```text
application write: 32 KiB
        |
        v
kernel/GSO representation: one large unit
        |
        v
NIC/TSO: many wire segments
        |
        v
receiver GRO: fewer larger units delivered up-stack
```

TCP still presents the same byte stream. Offloads alter CPU work, batching, timestamps, and packet captures. A capture above TSO may show an object larger than the link MTU; a remote wire capture shows actual segments. LRO can obscure packet-level timing and is often unsuitable where forwarding or precise capture semantics matter.

Offload also changes counter interpretation. One application write, one GSO object, several wire segments, and one GRO receive unit can all be called a “packet” by different tools. State the observation layer before comparing counts. Disabling an offload for diagnosis changes CPU load and potentially queueing, so compare under controlled conditions.

Corking, offload, and batching trade per-packet overhead against waiting. Record application write time, kernel/NIC timestamps where available, segment counts, and receiver delivery time. Changing offloads system-wide affects other workloads and requires operational approval.

## 29.12 Keepalive, Heartbeats, and Half-Open Connections

A **half-open connection** exists when one endpoint believes a connection is alive after the other has lost state or become unreachable—for example, after a host resets without delivering FIN or RST. Silence alone does not let TCP distinguish an idle peer from a failed path.

TCP keepalive sends probes after an idle interval when enabled with `SO_KEEPALIVE`. Linux exposes per-socket controls such as `TCP_KEEPIDLE`, `TCP_KEEPINTVL`, and `TCP_KEEPCNT`. Defaults are often far longer than trading-session liveness requirements and differ by system.

```cpp
// Excerpt: Linux-specific keepalive configuration; check every return value.
int on = 1;
int idle_seconds = 10;
int interval_seconds = 2;
int probes = 3;
::setsockopt(fd, SOL_SOCKET, SO_KEEPALIVE, &on, sizeof(on));
::setsockopt(fd, IPPROTO_TCP, TCP_KEEPIDLE,
             &idle_seconds, sizeof(idle_seconds));
::setsockopt(fd, IPPROTO_TCP, TCP_KEEPINTVL,
             &interval_seconds, sizeof(interval_seconds));
::setsockopt(fd, IPPROTO_TCP, TCP_KEEPCNT, &probes, sizeof(probes));
```

These values guide kernel timers; scheduler delay, retransmission, and system load affect observation time. A production wrapper must validate range and effective settings instead of ignoring errors as the abbreviated excerpt does.

An application heartbeat proves more: the peer session loop can parse a request and produce a response. It can carry session sequence, state, and timestamp information. But heartbeat bytes share TCP's stream. Missing earlier data causes head-of-line blocking, so a heartbeat behind a lost segment cannot bypass it.

Heartbeat design should specify who sends, what constitutes a response, whether ordinary traffic resets the timer, and how simultaneous probes are correlated. Use a monotonic local clock for deadlines. A peer wall-clock timestamp can support diagnostics but should not determine local timeout expiry if clocks can step.

`TCP_USER_TIMEOUT` on Linux can bound how long transmitted data remains unacknowledged before the connection fails under applicable conditions. It interacts with keepalive and retransmission behavior and is not a portable application deadline.

Choose liveness thresholds above justified network and scheduling jitter but below operational risk limits. A timeout should transition the session into explicit uncertain state, stop unsafe order flow, and reconnect with duplicate-suppression rules. Rapid reconnect without reconciliation can duplicate actions.

## 29.13 Head-of-Line Blocking

TCP delivers bytes in order. **Head-of-line blocking** occurs when a missing earlier segment prevents later received bytes from becoming available to the application. The receiver may hold those later bytes in a reassembly queue, but `recv` cannot skip the hole.

```text
wire arrival: segment 1, segment 3, segment 4
missing:               segment 2

application receives segment 1 bytes
segments 3 and 4 wait until segment 2 is recovered
```

This is the cost of one ordered stream. SACK helps the sender know that 3 and 4 arrived, but it does not let the application consume them before 2. A loss therefore adds recovery delay to every later message in the connection.

Application framing can create another layer of blocking. A large low-priority message at the front of the stream must be read and framed before a following urgent message. Separate connections can isolate classes, but they add handshakes, state, buffers, scheduling, and cross-stream ordering problems.

Sender-side queue order creates the same issue before bytes reach TCP. A large write accepted first occupies stream sequence space before a later urgent frame. `TCP_NODELAY` cannot reorder the stream. Priority must be applied before serialization, with bounded queues and a protocol that permits independent ordering domains.

Multistream transports address some transport-level head-of-line issues, but they have different deployment and protocol contracts. Within TCP, mitigation means controlling message size, avoiding unnecessary bulk transfers on urgent sessions, and provisioning separate channels where semantic independence justifies them.

Measure loss tails with application message completion, not packet arrival alone. A capture may show later segments present while the process sees no readable complete frame. Reassembly queue statistics, SACK blocks, retransmissions, and parser state explain the gap.

## 29.14 `TCP_INFO`, `ss`, and Socket Diagnostics

Linux `TCP_INFO` exposes a snapshot of internal connection metrics through `getsockopt`. Fields can include state, retransmissions, RTT estimates, congestion window, unacknowledged segments, delivery information, and more. The structure grows across kernel versions; request the size available to the program and respect the returned length.

```cpp
// Excerpt: Linux-only diagnostic snapshot.
tcp_info info{};
socklen_t size = sizeof(info);
if (::getsockopt(fd, IPPROTO_TCP, TCP_INFO, &info, &size) == 0) {
    record_tcp_state(info, size); // interpret only fields present in size
}
```

Units and meanings come from the matching Linux UAPI and kernel documentation. An RTT field is an estimator used by the stack, not an exchange round-trip or application service time. Congestion window expressed in segments needs MSS context before conversion to bytes.

`ss` displays socket and internal TCP state without instrumenting the process:

```bash
ss -tinm dst 192.0.2.10
nstat -az TcpRetransSegs TcpExtTCPTimeouts
ip -s link show dev eth0
```

Representative `ss -ti` fields may include `rtt`, `rto`, `cwnd`, `ssthresh`, retransmission, pacing, and delivery-rate data, depending on kernel. Do not paste schematic output as measured evidence. Capture the command, timestamp, namespace, kernel, and socket tuple.

Socket memory output can distinguish send-queue payload from allocated kernel memory only approximately because accounting includes protocol overhead and implementation structures. A nonzero send queue indicates bytes not yet fully acknowledged from the local socket's perspective; it still does not identify whether they are waiting for local transmission, receiver window, congestion window, or retransmission. Combine queue state with `TCP_INFO` and a capture.

Packet captures answer different questions: what segments and acknowledgments were visible at a capture point. Application counters show framing, queue depth, and business acknowledgments. NIC and qdisc counters show lower queues and drops. Correlate all of them in one clock domain where possible.

Diagnostics have observer cost. Calling `getsockopt(TCP_INFO)` per message adds a syscall and cache work. Sample outside the critical path or into a bounded telemetry schedule. A flight recorder can snapshot diagnostic state only when a latency threshold is crossed, while accepting that the snapshot occurs after the event.

Snapshots also race. `TCP_INFO`, `ss`, a packet capture, and an application queue counter taken at slightly different instants may describe different phases of one recovery. Attach monotonic timestamps and connection-generation IDs. A four-tuple can be reused after reconnect, so tuple alone is insufficient to correlate long-running diagnostics.

## 29.15 Handshake, Copy, Wakeup, and Retransmission Costs

TCP latency is the sum of work and waiting across layers. A useful model separates connection setup from steady-state transmission and rare recovery:

```text
setup:
route/neighbor + SYN RTT + accept wakeup + TLS/session exchange

steady state:
application framing + syscall/batching + copy/pinning
+ TCP processing + qdisc/NIC queue + wire/switch queue
+ receiver processing + socket wakeup + parsing

tail additions:
sender/receiver buffer stalls + scheduler delay + congestion queue
+ loss detection + retransmission + head-of-line blocking
```

System calls and copies are not the only costs. A blocking receiver can require a scheduler wakeup; a busy-polling receiver consumes a core and can interfere with siblings or power management. A nonblocking event loop can batch work but add queue residence. Kernel zero-copy mechanisms add completion and ownership complexity and may not benefit small messages.

Connection reuse removes repeated handshakes but retains congestion, flow-control, and failure-state history. Reconnect starts new sequence spaces and commonly new congestion state, then triggers TLS and application recovery. “TCP connected” is only one milestone in readiness.

For small writes, count syscalls, iovecs, segments, acknowledgments, wakeups, and frames. For bursts, inspect send queue, unacknowledged bytes, `cwnd`, `rwnd`, qdisc backlog, and receiver queue. For tails, identify whether the trigger was application scheduling, window closure, path queueing, loss detection, or retransmission.

Use application-level latency markers at stable semantic points: request fully enqueued, response frame fully validated, and business state committed. A timestamp before `send` includes work the syscall may not accept; one after `send` excludes queued delivery. Both can be useful, but they answer different questions.

Fault experiments should drop one data segment, one ACK, one SYN, and one FIN separately; pause receiver reads; fill the accept queue; and restart a peer after accepting a request. Each probes a different state machine. Run them in namespaces or a dedicated lab and verify impairment with captures, because a configured loss percentage does not prove which logical packet was dropped.

A defensible benchmark specifies:

- endpoints, route, MTU, and link conditions;
- kernel, congestion algorithm, socket options, and offloads;
- CPU and IRQ placement;
- message sizes, pacing, and connection age;
- whether TLS and application acknowledgments are included;
- timestamp points and clock synchronization; and
- distributions for normal and deliberately impaired paths.

Do not report a universal TCP latency. Report work, queue state, and observed distributions on the target. Then define an application failure policy for the cases TCP deliberately leaves ambiguous: deadline expiry, connection reset after send acceptance, replay after reconnect, and an alive stream carrying stale business state.

TCP is appropriate when ordered reliable delivery and backpressure semantics match the application channel. Market-data fan-out often prefers UDP multicast plus explicit recovery; order-entry sessions often prefer TCP plus application identity and acknowledgments. Neither choice eliminates application-level correctness.

Operational readiness also requires testing reconnect and replay under load, when the new session competes with live parsing, diagnostics, authentication, and accumulated business-state reconciliation.

Those tests must preserve request identity so fault injection cannot create uncontrolled duplicate orders.

## 29.16 Interview Check

1. Trace the three-way handshake and explain which options are negotiated only during setup. What does writability after nonblocking `connect` mean on Linux?
2. Distinguish the SYN queue from the accept queue. What do SYN-cookie and listen-overflow counters reveal about different bottlenecks?
3. Explain FIN half-close, RST, and TIME_WAIT. Why does a successful `close` not prove that a peer application processed the last request?
4. Write the state transitions for a four-byte length-prefixed parser when the prefix and payload arrive across arbitrary partial reads. Which length checks prevent allocation abuse?
5. A nonblocking `send` accepts 300 of 500 bytes. What exactly must the application retain and retry, and how should it react to `EAGAIN`, `EINTR`, and `EPIPE`?
6. What does a cumulative TCP ACK establish, and why is an application request ID still required after an ambiguous connection failure?
7. Compare RTO recovery, fast retransmit, and SACK. Why do later SACKed bytes remain unavailable to the receiving application?
8. Explain how `rwnd` and `cwnd` independently limit a sender. How can a larger receive buffer reduce drops while increasing stale-data residence?
9. What does `TCP_NODELAY` disable, and which batching, delayed-ACK, congestion, offload, and queueing mechanisms remain?
10. Given a latency spike, use `TCP_INFO`, `ss`, application counters, and packet captures to distinguish receiver flow-control stall, congestion, retransmission, and application scheduling delay.
