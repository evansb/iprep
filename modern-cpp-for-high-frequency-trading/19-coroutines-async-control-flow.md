# Chapter 19 — Coroutines and Asynchronous Control Flow

A C++ coroutine is a function that can suspend and later resume while preserving selected state. It is not a thread, a scheduler, or an I/O system. The compiler transforms the function into a state machine whose storage and ownership must be designed explicitly. That transformation can simplify asynchronous control flow, but hidden frame allocation, dangling references, indirect resumption, and unclear destruction are unacceptable surprises on a latency-critical path.

## 19.1 Coroutine Transformation

A function becomes a **coroutine** when its body uses `co_await`, `co_yield`, or `co_return`. The compiler rewrites it into a resumable state machine and creates a **coroutine frame** to hold state that must survive suspension.

Conceptually, this source:

```cpp
task receive_two(socket& s) {
    auto first = co_await s.read();
    auto second = co_await s.read();
    consume(first, second);
}
```

resembles the following pseudocode:

```text
frame {
    state
    promise
    saved parameter/reference to s
    first, second when live across suspension
    current awaiter
}

resume(frame):
    switch (frame.state):
      0: construct first read awaiter; possibly suspend; state = 1
      1: obtain first result
         construct second read awaiter; possibly suspend; state = 2
      2: obtain second result; consume; complete
```

This is a semantic model, not a mandated layout. The compiler can eliminate fields, merge states, keep values in registers between nonsuspending operations, or inline coroutine machinery when observable behavior permits it.

Calling a coroutine normally starts frame creation and returns the object supplied by its promise. Whether the body runs immediately depends on `initial_suspend`, discussed in Section 19.4. Resuming is ordinary user-space control transfer through a coroutine handle; an external event loop must decide *when* to do it.

The first performance question is therefore not “are coroutines fast?” It is: what is in the frame, where is it stored, which operations suspend, and who schedules and destroys it?

The conceptual creation order matters for error paths. Storage is obtained, parameter copies are established in the frame, the promise is constructed, and `get_return_object` creates the caller-visible object before initial suspension is evaluated. The detailed destruction path depends on which construction step succeeded. Compiler-generated code supplies that cleanup, but a custom allocator and return object must obey the same lifetime.

Coroutine parameters deserve special attention. A by-value parameter is copied or moved into frame state and can own its data. A reference parameter is represented as a reference and can dangle as soon as the caller's object dies. A lambda coroutine is more subtle: invoking a capturing lambda's coroutine call operator can leave the coroutine referring through the lambda's `this` after the closure object has been destroyed. Prefer an ordinary coroutine function that takes needed state by value, or arrange durable ownership explicitly.

## 19.2 `co_await`, `co_yield`, and `co_return`

`co_await expression` invokes the awaiter protocol and may suspend the current coroutine. If it does not suspend, execution continues inline and the result of `await_resume()` becomes the value of the expression.

`co_yield value` is defined in terms of the promise's `yield_value` operation followed by an await. It commonly publishes one value from a generator and suspends until the consumer asks for the next one.

`co_return value` completes the coroutine through `promise.return_value(value)`. A valueless `co_return` uses `promise.return_void()`. Completion then proceeds to final suspension; it does not return to the original caller in the ordinary stack sense.

```cpp
std::generator<int> price_ticks(int low, int high) {
    for (int p = low; p <= high; ++p)
        co_yield p;
    co_return;
}
```

The example uses C++23 `std::generator`, covered in Section 19.12. Each increment of the range's iterator resumes the producer until it yields or completes.

Suspension points divide the function into lifetime regions. A local whose value is needed after a possible suspension generally becomes frame state. A reference remains a reference; the coroutine does not extend the referred object's lifetime. This is a frequent source of asynchronous dangling bugs.

`co_return` does not bypass local cleanup. Ordinary locals leave scope according to the transformed control flow before final suspension. Objects that remain part of the promise or parameter storage live until frame destruction. This difference explains why an open resource held in a local wrapper can close at logical completion while memory retained by the promise persists until the owner destroys the completed frame.

Falling off the end is only valid for a coroutine whose promise supports the corresponding void completion semantics. Use an explicit `co_return` when it makes the completion point clearer, especially when reviewing cleanup and latency-sensitive final actions.

## 19.3 Promise Types and Awaiters

The **promise type** customizes a coroutine's creation, result, suspension, exception, and allocation behavior. It is unrelated to `std::promise`. The compiler obtains it through `std::coroutine_traits<Return, Parameters...>::promise_type`, commonly by finding `Return::promise_type`.

A promise normally supplies:

- `get_return_object()`;
- `initial_suspend()` and `final_suspend()`;
- `return_value(...)` or `return_void()`;
- `unhandled_exception()`;
- optionally `yield_value(...)`, `await_transform(...)`, and allocation functions.

An **awaiter** controls one `co_await`. After any promise-level `await_transform`, the language obtains an awaiter directly or through `operator co_await`, then calls:

```cpp
bool await_ready();
/* void, bool, or coroutine_handle */ await_suspend(coroutine_handle<> current);
Result await_resume();
```

If `await_ready()` is true, no suspension occurs. Otherwise `await_suspend` runs. A `void` result commits to suspension. A `bool` result chooses whether to remain suspended. A coroutine-handle result transfers execution to that coroutine, as Section 19.5 explains. `await_resume` supplies the value or throws when the await completes.

Here is an awaiter that never suspends:

```cpp
struct current_sequence {
    const std::uint64_t* value;

    bool await_ready() const noexcept { return true; }
    void await_suspend(std::coroutine_handle<>) const noexcept {}
    std::uint64_t await_resume() const noexcept { return *value; }
};
```

Because `await_ready` returns true, `await_suspend` is not called. The object still participates in the coroutine transformation. An optimizer may remove all machinery if it can prove the await never suspends.

Awaiter lifetime deserves attention. A temporary awaiter generally lives across the suspension and occupies frame storage. It must not contain references to request buffers that an I/O layer can invalidate before resumption. The registration operation in `await_suspend` must also solve the race between event completion and suspension; “store the handle, then return” is not automatically safe when another thread can complete immediately.

One safe family of registration protocols uses an atomic operation state with values such as `registering`, `suspended`, `completed`, and `cancelled`. Completion that wins before suspension records the result and causes `await_suspend` to return `false`; completion that wins afterward enqueues the saved handle. The exact transitions must guarantee that at most one party resumes and that the frame remains alive through the transition.

```text
awaiting thread                        completion thread
---------------                        -----------------
publish operation state
register callback
commit suspended  <---- race ---->     publish result
return from await_suspend               enqueue exactly once
```

Holding a mutex across the registration decision can simplify correctness when the API permits it. A lock-free state machine is justified only after its lifetime and memory orders are proved. The external operation's callback contract—whether it may run inline during registration—is part of that proof.

## 19.4 Initial and Final Suspension

`initial_suspend()` decides whether the coroutine body starts during the call. Returning `std::suspend_never` makes it **eager**: the body begins immediately. Returning `std::suspend_always` makes it **lazy**: the caller receives the return object before the body runs.

`final_suspend()` runs after normal completion or after `unhandled_exception`. It controls what happens to the completed frame and, often, which awaiting coroutine resumes next.

```text
allocate frame -> construct promise -> get return object
       |
       v
 initial_suspend -- resume --> body -- completion --> final_suspend
                                                   |
                                                   +-- suspended frame awaits destroy
```

A frame suspended at final suspend still owns its promise, parameter copies, and surviving locals until `destroy()` is called. This stable final suspension is convenient for an RAII task owner. If final suspension does not suspend, the frame can destroy itself as completion occurs; any external handle then becomes dangling. The return-object design and final-suspend policy must agree.

It is undefined behavior to resume a coroutine that is suspended at its final suspend point. Check `done()` only on a valid handle referring to a suspended coroutine, and destroy exactly once.

Lazy start can avoid work for a task that is never awaited, but it also means captured references may become stale before the first line executes. Eager start can run arbitrary user code inside what looks like a factory call. Document the policy in the type, not merely in its implementation.

Final suspension is also where continuation ownership is commonly settled. A task that allows exactly one awaiter can store one continuation handle in its promise. A task that allows many awaiters needs a list or shared state, which may allocate and synchronize. Naming both types merely `task<T>` hides a major cost and semantic distinction.

If final suspension resumes a continuation, it must not access a promise after transferring to code that can destroy the just-completed frame. Final-awaiters are small but delicate state machines. Use a reviewed implementation and tests where continuations complete, cancel, and destroy one another synchronously.

## 19.5 Symmetric Transfer

**Symmetric transfer** moves execution directly from one coroutine to another without returning through an accumulating chain of ordinary resume calls. An awaiter's `await_suspend` can return the handle of the next coroutine to resume.

```cpp
std::coroutine_handle<> await_suspend(
    std::coroutine_handle<> awaiting) noexcept {
    continuation = awaiting;
    return child_handle;       // transfer directly to child
}
```

At a task's final suspend, a final awaiter can similarly return the stored continuation. This forms a coroutine-to-coroutine handoff:

```text
parent co_await child --> child runs --> child final_suspend --> parent resumes
```

Without a tail-transfer design, a chain of coroutines that complete synchronously can recursively resume continuations and grow the native call stack. Symmetric transfer lets the implementation continue through the chain without one stack frame per logical task.

The transfer does not select a thread or post work to an event loop. It resumes the target in the current execution context. If resumption must occur on a particular CPU or executor, the awaiter must enqueue the handle there rather than transfer directly. That enqueue introduces synchronization, capacity, and lifetime requirements.

An executor queue also changes progress. A bounded queue can reject a continuation; an unbounded queue can allocate; a parked worker adds wakeup delay. The awaiter needs an explicit failure policy. Terminating because a continuation queue is full may be appropriate for an invariant breach, while dropping a risk-check continuation is not.

Symmetric transfer improves stack behavior, not necessarily branch locality. Each target can still be a different resume function reached indirectly. A chain that crosses many coroutine types may pressure the instruction cache even without growing the native stack.

## 19.6 Destruction and Exception Behavior

Destroying a suspended coroutine frame destroys live frame-resident objects, destroys the promise and parameter copies, and releases frame storage. Destruction is cancellation only in the limited sense that the computation never resumes; it does not automatically cancel a kernel operation, unregister a callback, or prevent another thread from holding the handle.

An exception escaping the coroutine body is caught by coroutine machinery and passed to `promise.unhandled_exception()`. A common promise stores `std::exception_ptr` so an awaiter or result accessor can rethrow later. If `unhandled_exception` terminates instead, that is the task type's policy.

Exceptions during setup require separate attention. Frame allocation can fail before the body runs. Construction of parameter copies or the promise can throw. The return type must not assume it received a live frame if creation failed. A promise may define `get_return_object_on_allocation_failure()` together with a nonthrowing allocation path to return an empty/failure object instead of throwing `std::bad_alloc`.

An in-flight external operation creates a destruction race:

```text
thread A: destroy coroutine frame
thread B: completion callback resumes saved handle  ---> use-after-free
```

Correct cancellation needs a protocol that removes or invalidates the callback and proves no concurrent resumer remains before frame destruction. Reference counting can solve lifetime but adds atomic traffic and may place destruction on the completion thread. Thread confinement can simplify the proof if all registration, completion, and destruction occur on one event-loop thread.

Cancellation is normally a request, not retroactive erasure. A result can race with a stop request. The operation contract must say which outcome wins and whether callbacks can still arrive after cancellation reports success. C++20 stop tokens provide cooperative notification, but they do not cancel a file descriptor or device request by themselves.

Destructors run on the thread that destroys the frame. If a frame owns a large buffer, shared pointer, or descriptor wrapper, cleanup may appear in an executor's completion tail. Move expensive or blocking cleanup to an explicit service when that placement is unacceptable. Destructors used in this path should not throw.

## 19.7 Coroutine-Frame Contents and Size

A coroutine frame commonly contains:

- the promise object;
- copies of by-value parameters and representations of reference parameters;
- state identifying the next resume point;
- locals and temporaries live across a suspension;
- awaiter objects live across a suspension;
- compiler bookkeeping, alignment, and padding.

```text
+---------------------------+
| resume/destroy machinery  |  implementation-specific
| promise                   |
| state and padding         |
| copied parameters         |
| live locals               |
| active awaiter            |
+---------------------------+
```

C++ specifies behavior, not this layout or size. Two compiler versions can produce different frames. Optimization can remove a local or reuse storage for values whose lifetimes do not overlap.

Large locals are especially important. A `std::array<std::byte, 8192>` that remains live across a suspension can enlarge every frame by roughly that payload plus alignment and metadata. A `std::vector` keeps only its small control object in the frame but allocates its elements elsewhere. Moving storage out of the frame may reduce allocation size while adding another allocation and pointer chase.

Limit lexical lifetimes so temporary parsing objects die before suspension. Pass durable ownership when data must survive; do not keep `std::span` or `std::string_view` into a receive buffer that will be recycled. Compiler-specific flags, optimization records, or coroutine-size builtins can help investigate frames, but there is no portable C++23 frame-size query. Allocation instrumentation provides a compiler-independent upper-level observation.

Frame-size reduction begins with liveness, not packing. Move a large temporary into a nested scope that ends before `co_await`; consume a parsed view before suspension; store an index instead of a copied table when the table has durable ownership. Reordering declarations alone does not guarantee a layout improvement because layout is implementation-defined.

Frame count multiplies small inefficiencies. An extra 64 bytes in 100,000 suspended sessions consumes several megabytes before allocator metadata, alignment, and pages. More resident pages increase TLB pressure and make cold resumption more expensive. Track count and bytes by coroutine type rather than only total heap use.

## 19.8 Allocation and Non-Guaranteed Elision

Coroutine frame storage is obtained through an allocation expression unless the implementation elides it. The lookup can find a promise-specific `operator new`; otherwise it uses a global allocation function. Deallocation follows the corresponding coroutine rules.

The standard permits the compiler to embed a frame in the caller's storage when the coroutine lifetime is strictly nested within the caller and the frame size is known at the call site. This allocation elision is not guaranteed. It can disappear after a small refactor, separate compilation, loss of inlining, or compiler change.

Therefore a hot path must be correct and operationally acceptable when allocation occurs. Verify rather than infer:

- override or instrument the promise allocator in a test build;
- count allocations by task type and call site;
- inspect optimized assembly and optimization remarks;
- test with and without LTO and across supported compilers;
- pre-touch pools and exercise exhaustion before production.

Even an elided allocation has memory cost: the frame occupies storage somewhere and can increase the caller frame or enclosing coroutine frame. Elision removes an allocator call; it does not erase suspended state.

A benchmark that observes zero system allocations after warmup may merely be reusing an allocator cache. Count allocation calls at the promise boundary, not only system calls. Likewise, a frame allocated during task construction but excluded from the timed interval still affects end-to-end latency and memory footprint.

When allocation is unavoidable, distinguish average constant-time reuse from a strict bound. A pool can usually return a block quickly yet expand a slab, fault a page, or contend during exhaustion. Preallocate, touch, NUMA-place, and cap it if those events are forbidden after startup.

### Inspecting a transformed coroutine

Use a deliberately small coroutine when learning a compiler's lowering. Compile with optimization and debug information, then locate three paths: initial call, resume, and destroy. Names and splitting are implementation-specific, but allocation and indirect control transfers remain visible.

```sh
clang++ -std=c++23 -O2 -g -S -fverbose-asm task_probe.cpp
objdump -drC task_probe.o
nm -C task_probe.o | grep -E 'resume|destroy|task_probe'
```

The generated initial-call path commonly computes a frame size, obtains storage unless elided, establishes promise and parameter state, and creates the return object. The resume path dispatches on saved state. The destroy path runs live destructors and releases storage. Do not depend on emitted symbol suffixes; they can change between compiler releases.

Add counters to promise allocation rather than globally overriding `operator new`, which mixes unrelated library activity into the result. Record requested bytes and high-water live frames. Build with and without optimization, LTO, and sanitizers because instrumentation can prevent elision or enlarge frames. Production conclusions come from the production-shaped build; instrumented builds answer correctness questions.

To determine which local enlarges a frame, remove or narrow one lifetime at a time and compare allocation-size counters. Inspecting `sizeof(task)` is useless: the return object often holds only a handle while the separate frame contains the suspended state. Likewise, a small frame can own a large heap allocation through a container.

Disassembly cannot prove lifetime correctness. Pair inspection with tests that suspend at every await point and destroy the owner, checking which object destructors run. AddressSanitizer detects many stale-frame accesses after destruction; a custom pool that immediately reuses blocks makes these tests more sensitive. ThreadSanitizer checks synchronization but may require suppressions or runtime integration for a custom scheduler.

Measure allocation elision as an observation, never as an interface guarantee. A compiler may embed a child frame in a parent when it sees strict nesting, then allocate after the child escapes through a generic helper. A continuous benchmark and allocation counter can catch that regression, while the bounded fallback pool preserves correctness and capacity.

## 19.9 Custom Promise Allocation

A promise type can define allocation functions for its coroutine frame. The compiler passes the required frame size and may pass coroutine function arguments to a matching placement form.

```cpp
struct promise_type {
    static void* operator new(std::size_t bytes) {
        return frame_pool::allocate(bytes); // application facility
    }

    static void operator delete(void* p, std::size_t bytes) noexcept {
        frame_pool::deallocate(p, bytes);
    }

    // get_return_object, suspend functions, and result functions follow...
};
```

This is an excerpt: `frame_pool` must honor the alignment required by the allocation request and the implementation's allocation-function contract. Sized and unsized delete overload resolution must be tested with each supported compiler. A simplistic fixed block pool fails when different coroutine instantiations produce different frame sizes or alignments.

A bounded pool provides predictable allocation and can keep frames NUMA-local. It also needs an exhaustion policy. Returning null from an ordinary throwing allocation function is wrong; either throw, use the coroutine allocation-failure customization correctly, or return an explicit failure through a documented design.

Per-thread pools avoid contention but complicate deallocation when completion moves across threads. Returning a frame to its origin pool may require a remote-free queue. A global lock-free pool introduces the reclamation and contention issues from Chapter 17. Custom allocation relocates costs; it does not remove them.

Allocator lifetime must exceed every frame allocated from it. Passing a pointer to a stack arena into a coroutine that outlives the calling scope is the allocator version of a dangling reference. Store durable allocator state in the runtime or require structured nesting that is mechanically enforced.

Size classes can bound fragmentation when frame sizes vary. Generate an inventory of observed frame sizes for supported builds, round into a small number of pools, and retain a general slow path only if policy permits it. Since a compiler upgrade can change sizes, validate the inventory in continuous integration and fail startup cleanly if a required pool cannot serve a type.

## 19.10 Suspension Versus OS Context Switching

Coroutine suspension saves only compiler-selected state in the coroutine frame and transfers control cooperatively. It does not ask the kernel scheduler to save a thread's full register context, change address spaces, or choose another runnable task. A direct suspend/resume path can therefore require much less machinery than an OS context switch.

That comparison is often abused. A coroutine awaiting a socket may still register with `epoll` or `io_uring`, enter the kernel, enqueue work, wake another thread, and suffer scheduler delay. The coroutine syntax does not make I/O completion free.

Conversely, a coroutine that never actually suspends can be optimized close to ordinary control flow. The awaiter protocol still matters: an indirect call, atomic queue operation, allocation, or executor hop can dominate the state-machine transition.

Measure complete paths:

```text
request creation
 -> frame allocation
 -> operation registration
 -> suspension
 -> kernel/device/event delay
 -> completion queue
 -> resumption
 -> frame destruction
```

Report both CPU work and wall-clock waiting. Comparing a coroutine handoff microbenchmark with a contended thread context switch answers only a narrow question.

## 19.11 Resume Indirection, Ownership, and Leaks

`std::coroutine_handle<Promise>` is a small, trivially copyable, non-owning handle to a coroutine frame. Copying a handle does not extend frame lifetime. `resume()` and `destroy()` require a valid handle and a state appropriate for the operation.

An owning task should make destruction explicit. This minimal lazy task is move-only and keeps completed frames suspended until its destructor:

```cpp
#include <coroutine>
#include <exception>
#include <utility>

class lazy_task {
public:
    struct promise_type;
    using handle = std::coroutine_handle<promise_type>;

    struct promise_type {
        std::exception_ptr error;

        lazy_task get_return_object() noexcept {
            return lazy_task{handle::from_promise(*this)};
        }
        std::suspend_always initial_suspend() const noexcept { return {}; }
        std::suspend_always final_suspend() const noexcept { return {}; }
        void return_void() const noexcept {}
        void unhandled_exception() noexcept { error = std::current_exception(); }
    };

    explicit lazy_task(handle h) noexcept : h_(h) {}
    lazy_task(const lazy_task&) = delete;
    lazy_task& operator=(const lazy_task&) = delete;

    lazy_task(lazy_task&& other) noexcept
        : h_(std::exchange(other.h_, {})) {}

    lazy_task& operator=(lazy_task&& other) noexcept {
        if (this != &other) {
            if (h_) h_.destroy();
            h_ = std::exchange(other.h_, {});
        }
        return *this;
    }

    ~lazy_task() {
        if (h_) h_.destroy();
    }

    bool resume() {
        if (!h_ || h_.done()) return false;
        h_.resume();
        if (h_.done() && h_.promise().error)
            std::rethrow_exception(h_.promise().error);
        return !h_.done();
    }

private:
    handle h_{};
};
```

The type is intentionally not awaitable and not thread-safe; it demonstrates ownership, not a production executor. Its stable final suspension makes the handle valid until `destroy`. A real task that can be awaited needs continuation storage, single- versus multiple-await policy, and race-free completion.

Leaking the owner leaks the frame and every resource held by its live objects. Destroying early while an executor retains a copied handle causes use-after-free. Resuming concurrently from two threads can corrupt state. A robust design chooses one of these models explicitly:

- unique task ownership with executor borrowing under a cancellation protocol;
- shared state with reference-counted lifetime;
- event-loop confinement where handles never cross threads;
- detached tasks whose runtime owns them until self-destruction.

Detached tasks are particularly easy to leak when an awaited event never completes. Track outstanding frame counts, age, source location, and cancellation state. C++20 `std::source_location` can label task creation without a manually maintained string, though recording it increases frame or side-table footprint.

### A task lifecycle contract

A production task type should answer these questions in its public contract:

| Question | Example choices |
|---|---|
| start policy | eager or lazy |
| ownership | unique, shared, runtime-detached |
| await count | zero/one or many |
| completion thread | inline, originating executor, selected executor |
| cancellation | cooperative request, kernel cancellation, unsupported |
| result access | once, copied many times, reference with bounded lifetime |
| frame storage | general heap, supplied allocator, fixed pool |
| destruction | owner thread, completion thread, deferred cleanup queue |

These are coupled. A unique, single-await, event-loop-confined task can avoid atomic ownership. A many-await shared task generally needs synchronized state and storage for waiters. Promising executor affinity requires queueing even when the result is already ready, unless the contract explicitly permits inline completion.

Tests should cover every transition: destroy before first resume, cancel while suspended, complete concurrently with cancellation, throw before and after the first suspension, complete synchronously inside registration, move the task owner, and shut down with pending work. Count resumes and destroys to prove both occur at most once.

### Worked design: an asynchronous session reader

Consider a TCP session that reads a fixed header, validates a payload length, reads the payload, and dispatches a decoded message. Coroutine syntax makes the sequential dependency clear:

```cpp
// Pseudocode: task, async_read_exact, and owned_buffer are runtime types.
task<void> read_one(session& s) {
    header_bytes header = co_await async_read_exact<header_bytes>(s.socket());
    const auto length = decode_and_validate_length(header);

    owned_buffer payload = co_await s.buffer_pool().read_exact(
        s.socket(), length);
    message_view message = decode_checked(payload.bytes());
    co_await s.dispatch(message, std::move(payload));
}
```

The code is only safe if its types encode the hidden lifetime. `header_bytes` is a by-value fixed object in the frame. `owned_buffer` retains the payload through dispatch. `message_view` borrows that buffer, so `dispatch` must not store the view after relinquishing the owner. An alternative is to decode into a small owning normalized message before the next suspension.

Length validation must occur before pool allocation or socket reading. It checks protocol maximum, integer conversion, and addition overflow for any framing bytes. A coroutine does not protect against an attacker requesting an enormous frame; the allocation and I/O policy remain ordinary systems design.

The promise uses lazy start and unique ownership. The event-loop runtime temporarily borrows each handle while an operation is registered. Destruction is confined to that event-loop thread. Cancellation follows this sequence:

```text
request stop
 -> mark session stopping
 -> cancel or unregister outstanding read
 -> drain/acknowledge any queued completion
 -> resume task with cancelled result
 -> unwind owning buffers and descriptors
 -> destroy completed frame
```

If the kernel API cannot guarantee that no completion follows cancellation, the operation state remains alive until both the task and completion side release it. That state may be reference-counted even when the task frame itself has unique ownership. Keep the shared object small and account for its atomic traffic.

The event loop uses a bounded ready queue. `await_suspend` registers the operation before committing to suspension and handles inline completion. The completion path enqueues the coroutine at most once. Queue exhaustion is not handled by silently dropping the handle; it triggers a controlled session failure or reserved emergency path. Otherwise one missing resume becomes a permanent frame and socket leak.

Frame allocation comes from a pool prepared on the session's NUMA node. Pool capacity is derived from maximum sessions times the maximum simultaneous tasks per session, plus a bounded shutdown margin. Exhaustion rejects a new session or closes it cleanly. It never falls through to the general heap after startup.

This design still has indirect control transfers, syscalls, buffer-pool operations, and queue synchronization. Measure these components separately, then measure accept-to-dispatch latency end to end. Useful runtime metrics include:

- live and peak frames by task type;
- frame-pool allocation failures and remote frees;
- ready-queue depth and rejected enqueue attempts;
- suspended duration by awaitable kind;
- cancellations, late completions, and duplicate-resume prevention events;
- frame destruction count and age of the oldest live task.

Fault tests complete an operation inline inside registration, complete it from another thread at every state transition, cancel it at every transition, and hold a completion indefinitely. AddressSanitizer can expose use-after-free; ThreadSanitizer can expose missing synchronization; neither proves at-most-once resumption. Assertions and state-transition counters should detect duplicate resume or destroy before memory corruption makes the failure obscure.

Performance tests compare this coroutine implementation with the runtime's callback or explicit-state-machine baseline while using the same allocator, I/O API, queue, and buffer ownership. Otherwise the benchmark attributes unrelated infrastructure changes to coroutine syntax. Inspect the final binary for frame allocation calls, resume indirection, and unexpected exception machinery.

A final review traces one payload through ownership: kernel or socket buffer, owned application buffer, view, dispatched message, and recycle. At every suspension, list the live owners and borrowers. This exercise catches more production bugs than counting `co_await` expressions.

The review should also trace execution authority. At each state, identify which thread may call `resume`, which component owns the handle, and which event permits destruction. If two boxes both believe they own destruction, double free is possible; if neither does, the frame leaks. A one-page state diagram is often more valuable than the surface syntax:

```text
created --start--> registering --commit--> suspended
   |                    |                     |
 destroy          inline completion       completion
   v                    v                     v
destroyed <--------- running <--------- ready queue
                         |
                      final suspend
                         |
                      completed --owner destroy--> destroyed
```

Every arrow that crosses threads needs synchronization and lifetime protection. Every arrow into `destroyed` needs proof that no other arrow can still use the handle. Completion and cancellation races should converge on one transition rather than each independently resuming the task.

Resume itself is often an indirect transfer through compiler-generated machinery. It can affect branch prediction and instruction-cache locality. Grouping homogeneous coroutine types or allowing inlining may help, but measure generated code and the actual executor queue before optimizing the transfer.

## 19.12 C++23 `std::generator`

C++23 `std::generator` is a synchronous coroutine-based view that yields a sequence of values lazily. It is useful when a stateful traversal reads more clearly as a sequence of `co_yield` operations than as a hand-written iterator state machine.

```cpp
#include <generator>
#include <cstdint>

std::generator<std::int64_t> ladder(std::int64_t best,
                                    std::int64_t tick,
                                    int levels) {
    // Preconditions: levels >= 0, tick >= 0, and
    // best - (levels - 1) * tick is representable in int64_t.
    for (int i = 0; i < levels; ++i)
        co_yield best - i * tick;
}

void consume() {
    for (std::int64_t price : ladder(10'000, 5, 4)) {
        // 10000, 9995, 9990, 9985
        use(price);
    }
}
```

The arithmetic preconditions must be checked before constructing this demonstration range; otherwise both the multiplication and subtraction can overflow before a value is yielded. A production price ladder can instead use a checked fixed-point step or prove the level bound from venue configuration. The generator is lazy and models a single-pass input range. Advancing its iterator resumes the coroutine. Yielded values may be exposed by reference depending on the generator's template arguments and the expression yielded, so consumers must not retain references beyond the generator's guarantees.

The facility does not provide asynchronous scheduling. The consumer and generator execute cooperatively in the calling thread. Exceptions stored by the generator promise are propagated as specified when iteration resumes through the failing point.

Frame allocation remains possible. Standard generator supports allocator-aware construction mechanisms, but using a custom allocator does not guarantee fixed capacity or allocation elision. Inspect the library implementation and count allocations for the actual generator type.

Generator references can avoid copies but narrow lifetime. If a generator yields a reference to a local object in its frame, that reference normally remains meaningful only until the generator advances and mutates or destroys the local, or until the generator itself is destroyed. Copy a yielded price or quantity when retaining it beyond the iteration step is necessary.

Nested generators can delegate sequences, but each layer can add frame and resume machinery. For a flat four-level price ladder, a direct loop is clearer about cost. A generator earns its place when it materially clarifies a complex stateful traversal and its measured overhead fits the path.

Library availability can lag the C++23 language mode. Check both the header and the feature-test macro rather than assuming that `-std=c++23` is sufficient:

```cpp
#include <version>

#if defined(__cpp_lib_generator) && __cpp_lib_generator >= 202207L
// <generator> is advertised by this standard library.
#else
// Use a vetted fallback or disable this component.
#endif
```

GCC, Clang, and their selected standard libraries are separate versioned components; Clang may use either libc++ or libstdc++. Record compiler and library versions in the build. For latency-critical tiny ranges, compare `std::generator` against a direct loop and a conventional iterator. Readability may improve while allocation, resume indirection, and frame footprint make it unsuitable for the hottest path.

Availability checks belong in configuration, not scattered business code. A build-system probe can compile a minimal `<generator>` program, record the feature-test value, and select either the standard facility or one vetted compatibility implementation. The fallback must have its own allocation, exception, and reference-lifetime contract; identical spelling does not imply identical cost.

## 19.13 Interview Check

1. Describe the major objects and calls created when a coroutine is invoked, suspends once, completes, and is destroyed.
2. What are the three possible result categories of `await_suspend`, and how do they change control flow?
3. Compare eager and lazy initial suspension with respect to side effects and reference lifetime.
4. Why is a handle-returning `await_suspend` useful in a deeply nested chain of tasks?
5. A coroutine awaits a network read while holding a `std::span` into a reusable receive buffer. Identify the lifetime risk and redesign it.
6. Why may a custom frame allocator improve predictability without eliminating cross-thread synchronization?
7. Explain why permitted coroutine allocation elision cannot be an unverified hot-path requirement.
8. A timeout destroys a task while an I/O completion thread holds its handle. What protocol is needed before destruction?
9. Compare coroutine suspension with an OS context switch without ignoring executor and kernel work.
10. What does C++23 `std::generator` provide, what does it not provide, and how would you check its availability and allocation behavior?
