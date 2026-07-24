# 23. Threads and Synchronization

Threads let independent activities share data without crossing a process boundary. That convenience creates obligations: lifetime must outlast execution, every shared mutation needs a synchronization policy, and blocking behavior must fit the latency budget. C++ supplies RAII thread handles, locks, condition variables, and coordination primitives for making those obligations explicit.

## Concurrency, Parallelism, and the Units of Execution

**Concurrency** structures a program as independently progressing activities. **Parallelism** executes activities physically at the same time. A concurrent program can interleave work on one core; parallel execution requires multiple processing resources.

Processes, threads, and tasks sit at different levels:

| Unit | Address space | Creation cost | Communication | Scheduled by |
|---|---|---|---|---|
| Process | Separate | High | IPC, files, shared memory | Operating system |
| Thread | Shared within process | Moderate | Ordinary memory plus synchronization | Operating system |
| Task | Uses its worker's process | Low once workers exist | Captures, queues, shared state | Application runtime or thread pool |

A process owns an address space and operating-system resources. A thread is one execution stream inside that process. A task is an application-level unit of work assigned to a thread.

Threads in one process can see the same globals, heap allocations, and referenced stack objects. That direct communication is the point of threads and their central danger: two execution streams can touch the same bytes at unpredictable times.

Process isolation makes accidental memory corruption less direct, but crossing the boundary requires an explicit communication mechanism. Threads communicate cheaply through ordinary addresses, so correctness depends on the program consistently identifying which state is immutable, thread-confined, or synchronized.

A task does not necessarily own a thread. A pool can run thousands of short tasks on a fixed set of workers, and a suspended task may later resume on a different worker. Thread-local state therefore belongs to an execution thread, not automatically to a logical request.

More runnable threads do not guarantee more parallelism. Once runnable work exceeds available hardware contexts, the operating system time-slices it, adding scheduler work and disrupting caches. Parallel structure pays only when independent work and hardware capacity both exist.

## Starting Threads: `std::thread` and `std::jthread`

Constructing a `std::thread` starts execution immediately. The resulting object is a move-only handle (Chapter 7) representing the running OS thread.

The handle is **joinable** while it still represents a thread that has not been joined or detached. `join()` waits for that thread to finish. `detach()` disconnects the handle and lets execution continue independently.

```cpp
void perform_work();

void unsafe_scope() {
    std::thread worker{[] {
        perform_work();
    }};
}  // calls std::terminate: worker is still joinable

void explicit_join() {
    std::thread worker{[] {
        perform_work();
    }};
    worker.join();
}
```

`perform_work()` is an ordinary function whose definition is omitted from this focused snippet. Destroying a joinable `std::thread` calls `std::terminate`; it does not silently join.

**Rule.** Every `std::thread` must reach exactly one explicit ownership decision: `join()`, `detach()`, or move its handle to an object that will make that decision.

`join()` is both a lifetime operation and a wait. After it returns, the represented thread has finished and the handle is no longer joinable. Calling `join()` twice, joining a non-joinable handle, or assigning over a joinable `std::thread` violates the handle contract and can throw or terminate depending on the operation.

Moving a thread handle transfers responsibility without moving the running execution itself:

```cpp
void perform_work();

void transfer_join_responsibility() {
    std::thread first{[] {
        perform_work();
    }};
    std::thread owner = std::move(first);

    // first.joinable() == false
    // owner.joinable()
    owner.join();
}
```

The moved-from handle no longer represents a thread. This is the same move-only ownership shape as a resource handle from Chapter 7.

`std::jthread` **(C++20)** makes joining automatic. Its destructor requests cooperative stop and then joins, so normal scope exit, early return, and exception unwinding are safe:

```cpp
void perform_work();

void safe_scope() {
    std::jthread worker{[] {
        perform_work();
    }};
}  // requests stop, then joins
```

A callable can accept the `std::stop_token` carried by its `jthread`. The token reports a stop request; cancellation mechanics belong to Chapter 24.

```cpp
void poll_once();

void poll_feed(std::stop_token stop) {
    while (!stop.stop_requested()) {
        poll_once();
    }
}

void run_feed() {
    std::jthread worker{poll_feed};
}  // requests stop; poll_feed cooperates; destructor joins
```

The stop request does not forcibly interrupt `poll_once()`. The worker must reach a check and return. A blocking operation that never observes the token can still make the `jthread` destructor wait indefinitely.

Declare a `jthread` after the state it uses. Members destroy in reverse declaration order, so placing worker handles last keeps their mutexes, queues, and configuration alive until automatic joins complete.

Thread arguments are **decay-copied** into internal storage. Arrays become pointers, reference qualifiers disappear, and ordinary values are copied or moved. The new thread later invokes its callable with stored values.

```cpp
void increment(int& counter) {
    ++counter;
}

void argument_examples() {
    int counter = 0;

    std::jthread copied{[](int value) {
        return value + 1;  // thread return value is discarded
    }, counter};
    copied.join();
    // counter == 0

    std::jthread referenced{increment, std::ref(counter)};
    referenced.join();
    // counter == 1
}
```

Passing `counter` directly to `increment(int&)` would not merely update a copy: it fails to compile because the stored temporary cannot bind to the required lvalue reference.

```cpp
void invalid_reference_argument() {
    int counter = 0;
    std::jthread worker{increment, counter};  // error: not invocable
}
```

`std::ref(counter)` stores a copyable reference wrapper, preserving reference semantics. That makes the lifetime requirement explicit: `counter` must remain alive until the thread has finished using it.

Lambda capture follows the same ownership question. Capturing by value copies state into the closure stored for the thread; capturing by reference stores a view. A value capture usually gives a background operation the safer lifetime, while a reference capture requires a join before every referenced local dies.

Detachment discards the only standard handle that can join. A detached thread that refers to a local can outlive that local:

```cpp
void publish(int sequence);

void dangling_detach() {
    int sequence = 42;
    std::thread worker{[&sequence] {
        publish(sequence);  // UB if the function has returned
    }};
    worker.detach();
}  // sequence dies while worker may still use it
```

Detach is almost always the wrong lifetime model. A long-lived service thread should be owned by a long-lived RAII object, normally through `std::jthread`.

Detachment also removes structured shutdown. The process can exit while detached work is writing logs or holding library resources, and tests cannot reliably wait for cleanup. If ownership is intended to outlive one scope, move the joinable handle into a service object rather than abandoning it.

Threads do not carry a return-value channel. A thread can publish a result into synchronized shared state; promises and futures provide a direct result channel in Chapter 24.

Join before reading unsynchronized result storage written by the worker. The join establishes the required completion relationship; reading while the worker may still write is a data race. For ongoing producer-consumer communication, one final join is insufficient—the state needs synchronization at each handoff.

**Pitfall.** `std::ref` fixes argument copying, not lifetime. Joining after the referred object dies still leaves the worker with a dangling reference.

## Thread-Local Storage

A `thread_local` object has one instance per thread. Each thread constructs its instance on first odr-use if dynamic initialization is required, and destroys that instance when the thread exits.

Random engines maintain mutable state and are not safe for unsynchronized concurrent access (Chapter 14). One engine per thread removes that sharing:

```cpp
#include <random>

int jittered_price(int price) {
    thread_local std::mt19937 engine{
        std::random_device{}()
    };  // each thread seeds its engine once

    std::uniform_int_distribution<int> jitter{-1, 1};
    return price + jitter(engine);
}
```

Other common uses include:

- Scratch buffers reused by one worker.
- Per-thread free lists feeding an allocation pool (Chapter 17).
- Counters aggregated outside the hot path.

Thread confinement can remove synchronization entirely. A worker can update its own statistics, scratch storage, or free list with plain operations, then publish an aggregate at a controlled boundary. That converts frequent shared writes into infrequent combination work.

The one-instance-per-thread rule also affects identity. If a task migrates between pool workers, it sees the destination worker's TLS object, not the object used by its previous invocation. Do not store request semantics in TLS unless tasks are deliberately pinned to workers.

Thread-local access is not uniformly free. Static TLS in the main executable can often be addressed as a fixed offset from a thread register. Dynamic TLS in a shared library may require a helper such as `__tls_get_addr`; the exact access model depends on the platform, linker, and build mode.

Dynamic initialization also needs a per-thread guard check on access. An expensive constructor costs once for every thread that reaches the declaration, not once for the process.

Large TLS objects multiply memory footprint by the number of participating threads. Prefer a reusable buffer sized for typical work and handle exceptional sizes separately rather than silently reserving the worst case on every worker.

**Pitfall.** Thread-local destructors run during thread teardown. Dependencies among thread-local or static objects can recreate the destruction-order hazards from Chapter 5.

## Data Races and the Mutex Family

Informally, a **data race** occurs when two threads access the same memory location, at least one access writes, and no synchronization orders the accesses. A data race gives the program undefined behavior, not merely an occasionally stale value. The memory model makes this precise in Chapter 25.

This complete program has a data race:

```cpp
#include <iostream>
#include <thread>

int counter = 0;

void increment_many() {
    for (int i = 0; i < 1'000'000; ++i) {
        ++counter;  // UB: unsynchronized read-modify-write
    }
}

int main() {
    std::jthread first{increment_many};
    std::jthread second{increment_many};
    first.join();
    second.join();
    std::cout << counter << '\n';  // no valid value is guaranteed
}
```

`++counter` reads, computes, and writes. Those operations can overlap between the two threads, and the compiler may optimize under the assumption that a data race never occurs.

ThreadSanitizer instruments memory accesses and reports likely races:

```sh
clang++ -std=c++23 -Wall -Wextra -fsanitize=thread -g counter.cpp
./a.out
```

An abbreviated report identifies the conflicting accesses:

```text
WARNING: ThreadSanitizer: data race
  Write of size 4 ... by thread T2:
    #0 increment_many()
  Previous write of size 4 ... by thread T1:
    #0 increment_many()
  Location is global 'counter'
```

Run race tests under realistic concurrency and with enough repeated work to expose rare paths. ThreadSanitizer changes timing and carries substantial overhead, so it is a correctness tool rather than a benchmark configuration. A clean run increases confidence but does not prove the absence of races in unexecuted code.

Protecting the operation with `std::mutex` makes access exclusive:

```cpp
#include <mutex>

int counter = 0;
std::mutex counter_mutex;

void increment_many() {
    for (int i = 0; i < 1'000'000; ++i) {
        std::lock_guard lock{counter_mutex};
        ++counter;
    }
}
```

Every access to guarded state must follow the same locking policy. Locking writers while leaving an unlocked reader still permits a race.

The example acquires the mutex for every increment to make the rule visible, but that granularity creates extreme contention. When semantics allow it, each worker can count locally and add one subtotal under the lock:

```cpp
int counter = 0;
std::mutex counter_mutex;

void increment_batched() {
    int local = 0;
    for (int i = 0; i < 1'000'000; ++i) {
        ++local;
    }

    std::lock_guard lock{counter_mutex};
    counter += local;
}
```

The protected invariant is unchanged, but lock acquisitions fall from one per event to one per batch. Batching trades publication freshness for lower synchronization traffic.

A simple counter can instead use `std::atomic<int>`, an integer whose reads and writes are indivisible and race-free:

```cpp
#include <atomic>

std::atomic<int> counter{0};

void increment_many() {
    for (int i = 0; i < 1'000'000; ++i) {
        counter.fetch_add(1);
    }
}
```

This default atomic operation is enough for the example; its ordering semantics and costs belong to Chapter 25.

A **race condition** is broader than a data race. It is any incorrect result caused by an unfortunate interleaving. A check-then-act transaction can have a race condition even when each access uses a lock or atomic operation individually. A data race is specifically the undefined-behavior case involving unsynchronized memory access.

Atomic operations do not automatically make a compound decision atomic:

```cpp
std::atomic<int> available{1};

bool reserve_broken() {
    if (available.load() > 0) {
        available.fetch_sub(1);
        return true;
    }
    return false;
}
```

Two threads can both observe `1`, both subtract, and both report success. Every access is race-free, but the check and update do not form one transaction. Chapter 25 supplies the atomic vocabulary needed to repair such protocols.

The mutex family offers several locking policies:

| Type | Extra capability | Cost profile | Use |
|---|---|---|---|
| `std::mutex` | Exclusive ownership | Baseline | Default mutual exclusion |
| `std::timed_mutex` | Timed lock attempts | Extra time bookkeeping | Operations with lock timeout |
| `std::recursive_mutex` | Same thread may relock | Count and owner tracking | Legacy lock discipline pending refactor |
| `std::shared_mutex` | Shared readers, exclusive writer | Reader-count contention | Long reads with rare writes |

`std::recursive_mutex` often hides an unclear locking boundary. Prefer a public function that locks once and calls private helpers whose names or contracts state that the lock is already held.

Timed mutexes add a policy choice rather than correcting a deadlock. Timing out can bound a caller's wait, but the program still needs a valid response when acquisition fails. Retrying blindly can turn deadlock pressure into livelock pressure.

**Interview.** A strong answer distinguishes a data race from a race condition. It says that the data race is undefined behavior, then gives an atomic but logically broken check-then-act sequence as a race condition without a data race.

## RAII Lock Wrappers and Multi-Lock Deadlock Avoidance

Do not pair manual `lock()` and `unlock()` calls across ordinary control flow. A lock wrapper makes mutex ownership a scoped resource, so return statements and exceptions release it through RAII (Chapter 5).

| Wrapper | Mutexes | Defer or unlock early? | Movable? | CV-compatible? | Typical use |
|---|---:|---:|---:|---:|---|
| `std::lock_guard` | One | No | No | No | Small lexical critical section |
| `std::unique_lock` | One | Yes | Yes | Yes | Condition waits, deferred locking |
| `std::scoped_lock` | One or more | No | No | No | Deadlock-safe multi-mutex acquisition |

`std::lock_guard` normally compiles to a mutex acquire at construction and release at destruction. `std::unique_lock` also stores whether it currently owns the mutex, enabling deferred construction, moves, and early unlock. A condition variable requires that flexibility.

`std::scoped_lock` **(C++17)** acquires several mutexes with a deadlock-avoidance algorithm rather than committing to one lock and waiting indefinitely for the next. It is the standard answer for a transfer touching two independently locked objects:

```cpp
#include <mutex>
#include <stdexcept>

struct Account {
    int balance;
    std::mutex mutex;
};

bool transfer(Account& from, Account& to, int amount) {
    if (&from == &to) {
        return true;
    }

    std::scoped_lock lock{from.mutex, to.mutex};
    if (from.balance < amount) {
        return false;
    }

    from.balance -= amount;
    to.balance += amount;
    return true;
}
```

Manually imposing one global lock order can also prevent deadlock. `scoped_lock` removes that ordering burden for mutex sets known at the call site.

Conceptually, a multi-lock algorithm attempts the set without waiting forever while holding a partial set. On failure it releases acquired mutexes and retries, avoiding circular hold-and-wait. The standard specifies the deadlock-avoidance result, not one exact retry algorithm.

A **critical section** is code executed while a lock is held. Keep it focused on the state protected by that lock:

1. Compute independent work before acquiring.
2. Acquire the lock.
3. Read or update the guarded state.
4. Copy out any data needed later.
5. Release before formatting, allocation, logging, or I/O.

Allocation can acquire allocator-internal locks (Chapter 17). Holding an application mutex across allocation nests unrelated lock hierarchies, extends hold time, and makes contention harder to reason about. I/O can block for an unbounded period and belongs outside the critical section.

Each mutex needs a written invariant: which data it guards and what must be true whenever the mutex is free. For the account example, each `Account::mutex` guards its own `balance`; a completed transfer preserves total balance across the pair.

The invariant determines lock scope. If two fields must change together, protecting them with unrelated mutexes exposes an intermediate state unless readers acquire both. One mutex guarding the compound invariant can be both simpler and faster than fine-grained locks that every operation must combine.

Copying data out shortens hold time:

```cpp
extern std::mutex state_mutex;
extern std::string shared_status;
std::string format_for_log(const std::string& status);

std::string snapshot_status() {
    std::string status;
    {
        std::lock_guard lock{state_mutex};
        status = shared_status;
    }
    return format_for_log(status);  // formatting outside lock
}
```

The copy may allocate, so for strict hot paths the representation should support bounded or preallocated copying. The ownership pattern remains: retain only what the unlocked work needs.

An unnamed wrapper does not protect the surrounding scope:

```cpp
extern std::mutex state_mutex;
void mutate_shared_state();

void update() {
    std::lock_guard<std::mutex>{state_mutex};  // warning: unused temporary
    // temporary has already unlocked
    mutate_shared_state();
}
```

The braced expression creates and destroys a temporary at the semicolon. A parenthesized spelling can instead be parsed as a declaration, a cousin of the most vexing parse from Chapter 5.

**Pitfall.** Two functions that manually acquire mutexes in opposite orders can deadlock. Put the order in one shared abstraction or use `std::scoped_lock`.

## Reader-Writer Locks, Honestly

`std::shared_mutex` permits many concurrent readers or one exclusive writer. Readers use `std::shared_lock`; writers use `std::unique_lock`.

```cpp
#include <mutex>
#include <shared_mutex>
#include <string>
#include <unordered_map>

class ConfigStore {
public:
    std::string lookup(const std::string& key) const {
        std::shared_lock lock{mutex_};
        return values_.at(key);
    }

    void reload(std::unordered_map<std::string, std::string> next) {
        std::unique_lock lock{mutex_};
        values_ = std::move(next);
    }

private:
    mutable std::shared_mutex mutex_;
    std::unordered_map<std::string, std::string> values_;
};
```

Reader parallelism is not free. Each reader must update shared bookkeeping that records the number of readers. On several cores, that count's cache line moves between writers even though the protected data is read-only.

Readers also interact with arriving writers. A reader-preferring implementation can delay a writer under a continuous read stream; a writer-preferring implementation can delay new readers once a writer queues. The standard interface does not expose a portable fairness selection.

For short critical sections, a plain `std::mutex` can outperform `std::shared_mutex` by serializing less bookkeeping. A reader-writer lock earns its complexity when read sections are long enough to overlap usefully and writes are rare enough not to starve or repeatedly exclude readers.

The exact fairness policy is implementation-dependent. Some implementations may favor readers or writers, so do not infer starvation guarantees from the type name.

**Pitfall.** Measure the workload's read duration and contention. A high reader percentage alone does not establish that `shared_mutex` is faster.

A single-writer, many-reader design can avoid reader locking with a sequence lock; that lock-free alternative appears in Chapter 26.

## Condition Variables: The Canonical Pattern

A condition variable parks a thread until shared state may satisfy a condition. Memorize this shape:

```cpp
extern std::mutex mutex;
extern std::condition_variable condition;
bool predicate_on_guarded_state();
void use_guarded_state();

void wait_canonically() {
    std::unique_lock lock{mutex};
    condition.wait(lock, [] {
        return predicate_on_guarded_state();
    });
    use_guarded_state();
}
```

`wait` atomically releases the mutex and parks the caller. Before returning, it reacquires the mutex. `std::unique_lock` is required because the wait operation must temporarily give up and later regain ownership.

The predicate is part of correctness. A condition-variable wait may wake **spuriously**, with no corresponding notification. The two-argument overload behaves like a loop:

```cpp
extern std::mutex mutex;
extern std::condition_variable condition;
bool predicate_on_guarded_state();
void use_guarded_state();

void wait_explicitly() {
    std::unique_lock lock{mutex};

    while (!predicate_on_guarded_state()) {
        condition.wait(lock);
    }
    use_guarded_state();
}
```

A one-element handoff makes the full protocol concrete:

```cpp
#include <condition_variable>
#include <mutex>

class PriceHandoff {
public:
    void publish(int price) {
        {
            std::lock_guard lock{mutex_};
            price_ = price;
            ready_ = true;
        }
        ready_condition_.notify_one();
    }

    int receive() {
        std::unique_lock lock{mutex_};
        ready_condition_.wait(lock, [this] {
            return ready_;
        });
        ready_ = false;
        return price_;
    }

private:
    std::mutex mutex_;
    std::condition_variable ready_condition_;
    int price_ = 0;
    bool ready_ = false;
};
```

The producer changes `price_` and `ready_` while holding `mutex_`. It unlocks before notifying, so a woken consumer can acquire the mutex instead of waking directly into a blocked lock. The consumer returns from `wait` only while holding the mutex and observing `ready_`.

The protocol has a fixed sequence:

1. The producer locks the predicate's mutex.
2. It changes the guarded data and predicate state.
3. It unlocks, publishing a coherent state to future lock holders.
4. It notifies one or more possible consumers.
5. A consumer wakes, reacquires the mutex, and tests the predicate again.

The ordering between steps 3 and 4 is an optimization choice; changing state under the mutex is the correctness requirement. If a consumer enters after step 3 but before step 4, it sees a true predicate and does not sleep.

This one-slot example assumes the producer does not publish another value until the previous value is consumed. A bounded queue needs separate not-empty and not-full predicates or an equivalent capacity protocol.

Predicates should describe state, not events. “The queue is nonempty” survives scheduling delay; “a notification occurred” does not. Several logical conditions can share one condition variable, but each waiter must recheck the condition relevant to it.

A wait without durable predicate state can lose a wakeup:

```cpp
std::mutex mutex;
std::condition_variable condition;

void send_broken() {
    condition.notify_one();
}

void receive_broken() {
    std::unique_lock lock{mutex};
    // notify may already have happened; no state records it
    condition.wait(lock);
}
```

The failure interleaving is:

1. `send_broken()` notifies while no thread waits.
2. The notification is discarded because condition variables do not store signals.
3. `receive_broken()` starts waiting and may sleep forever.

In the correct version, `ready_` stores the fact that work is available. If publication precedes the wait, the predicate is already true and `wait` does not park.

Use `notify_one()` when one newly available item can satisfy one interchangeable consumer. Use `notify_all()` when a state change may enable several waiters or when different waiters use different predicates. Waking all threads for one item creates a thundering herd.

`notify_one()` does not promise which waiter wakes. If consumers have priorities or distinct responsibilities, one shared condition variable may not express the scheduling policy. Separate queues or conditions can make admission explicit.

A timeout does not remove the predicate requirement. `wait_for` and `wait_until` can return because of notification, a spurious wake, or timeout; the guarded state still decides whether work exists. Timeouts are useful for policy, health checks, and shutdown, not as a repair for missing synchronization.

Notifying while holding the mutex is correct if predicate state was changed under that mutex. Notifying after unlock is the usual latency optimization because it avoids waking a thread that immediately blocks on the same mutex.

**Rule.** Predicate state is always read and changed under the associated mutex. The notification announces a possible change; the state itself carries the truth.

## One-Time Initialization

A function-local static, often called a magic static, initializes exactly once even when several threads call the function concurrently. Prefer it when initialization naturally produces one object:

```cpp
struct Config {
    int venue_count;
};

Config load_config();

Config& config() {
    static Config instance = load_config();
    return instance;
}
```

If `load_config()` throws, initialization is not complete and a later call may retry. After successful initialization, calls pay only the implementation's initialized guard check (Chapters 5 and 19).

`std::call_once` handles initialization that does not fit a static initializer, such as assigning several members:

```cpp
#include <mutex>

void connect(const Config& config);

class Service {
public:
    void initialize() {
        std::call_once(initialized_, [this] {
            config_ = load_config();
            connect(config_);
        });
    }

private:
    std::once_flag initialized_;
    Config config_{};
};
```

Only one invocation completes the callable. If it throws, the flag remains unset and another call can try again.

Concurrent callers block until the successful callable completes, then observe its initialized effects. Put only initialization in that callable; unrelated slow I/O makes every first caller wait behind it.

Neither magic statics nor `call_once` provide reinitialization after success. If configuration must reload, model versions and synchronization explicitly rather than attempting to reset an `once_flag`.

**Pitfall.** A separate `bool initialized` checked without synchronization recreates the data race and partial-publication hazards that `call_once` solves.

## The C++20 Kit: Semaphores, Latches, Barriers, and Atomic Wait

C++20 adds primitives for common coordination shapes. They express more intent than assembling every protocol from a mutex and condition variable.

A `std::counting_semaphore` stores a nonnegative permit count. `acquire()` waits for and consumes one permit; `release()` adds permits. `std::binary_semaphore` is the count-zero-or-one specialization.

Unlike a mutex, a semaphore has no thread ownership: one thread may acquire and another may release. That makes it suitable for signals and resource slots, not for expressing “this thread exclusively owns this critical section.”

```cpp
#include <semaphore>

void enqueue_order();

std::counting_semaphore<64> slots{64};

void send_order() {
    slots.acquire();
    enqueue_order();
}

void on_order_complete() {
    slots.release();
}
```

The permits bound the number of outstanding orders. The queue itself still needs whatever synchronization protects its data.

A semaphore count records available capacity, not the identity of capacity holders. An unmatched release creates an extra permit and breaks the resource bound; exceeding the semaphore's maximum count violates its precondition. Encapsulate acquisition and release with the operation whose capacity they represent.

A `std::latch` is a one-shot countdown. Threads can decrement it, wait for zero, or do both with `arrive_and_wait()`:

```cpp
#include <latch>
#include <thread>
#include <vector>

void prepare_worker(int id);
void measure_worker(int id);

void run_benchmark(int worker_count) {
    std::latch start_gate{worker_count};
    std::vector<std::jthread> workers;
    workers.reserve(static_cast<std::size_t>(worker_count));

    for (int id = 0; id < worker_count; ++id) {
        workers.emplace_back([&start_gate, id] {
            prepare_worker(id);
            start_gate.arrive_and_wait();
            measure_worker(id);
        });
    }
}  // jthreads join
```

After the count reaches zero, a latch remains open and cannot be reset. A `std::barrier` is reusable: all participants arrive at the end of a phase, one completion step runs, and the barrier resets for the next phase.

A latch count usually represents facts that can occur once: workers ready, files loaded, or components stopped. A participant can call `count_down()` without waiting, while a coordinator calls `wait()`. `arrive_and_wait()` combines both sides for a start gate.

```cpp
#include <barrier>

void publish_completed_tick() noexcept;
void simulate_tick(int tick);

std::barrier phase_boundary{
    4,
    []() noexcept {
        publish_completed_tick();
    }
};

void simulate_partition() {
    for (int tick = 0; tick < 100; ++tick) {
        simulate_tick(tick);
        phase_boundary.arrive_and_wait();
    }
}
```

Every participant finishes tick `T` before any passes the boundary into tick `T + 1`.

Barrier participation is a protocol. Every remaining participant must reach each phase, or its peers wait forever. A thread that permanently leaves a phased algorithm uses the barrier's drop operation so later phases expect one fewer participant.

`std::atomic<T>::wait` **(C++20)** blocks while an atomic still equals a supplied old value. A store changes the value, then notification wakes waiters:

```cpp
#include <atomic>

void consume_published_data();
void publish_data();

std::atomic<bool> ready{false};

void consume_when_ready() {
    ready.wait(false);
    consume_published_data();
}

void publish_ready() {
    publish_data();
    ready.store(true);
    ready.notify_all();
}
```

Here `std::atomic<bool>` provides indivisible, race-free flag access. The ordering required to publish `publish_data()` safely is part of Chapter 25; production code must choose it deliberately.

`atomic::wait` first checks in user space and can park when the value remains unchanged, giving it a futex-shaped implementation. It avoids maintaining a separate mutex-protected predicate for state already represented by one atomic value.

| Primitive | Reusable? | Ownership? | Shape | Canonical example |
|---|---:|---|---|---|
| `counting_semaphore` | Yes | None | Permit count | Bounded resource slots |
| `binary_semaphore` | Yes | None | Zero/one signal | Thread handoff |
| `latch` | No | None | Countdown to one event | Benchmark start gate |
| `barrier` | Yes | Participants | Repeated phase boundary | Phased simulation |
| `atomic::wait` | Yes | None | Wait for value change | Compact state flag |

**Pitfall.** A binary semaphore can imitate exclusion but lacks mutex ownership checks and lock-wrapper integration. Use it for signaling, not as a casual mutex replacement.

## Spinning, Parking, and What a Mutex Really Is

A waiting thread can spin or park:

| Strategy | Uncontended cost | Contended wake latency | CPU consumed while waiting | Inversion risk | Use when |
|---|---|---|---|---|---|
| Spin | Atomic fast path | Lowest if holder runs | One logical CPU | High if holder is descheduled | Very short waits, dedicated cores |
| Park | Atomic fast path, then kernel | Scheduler path | None while asleep | Lower CPU waste | Uncertain or long waits |
| Spin then park | Atomic plus bounded loop | Low for short waits | Bounded | Tunable | General adaptive mutex |

Pure spinning repeatedly reads or updates a synchronization word. It avoids sleeping and scheduler wakeup when the holder releases promptly, but burns an entire hardware thread while waiting. If the holder is descheduled on an oversubscribed machine, the spinner can consume the time slice the holder needs to make progress.

Spinning also competes for execution and memory-system resources with the lock holder. A tight exchange loop writes the lock cache line on every attempt, so even waiting can delay the owner. Production locks commonly spin on reads between acquisition attempts to reduce that traffic.

Parking asks the kernel to stop scheduling the waiter. That frees the CPU for useful work but introduces a system call and a scheduling round trip when the thread wakes.

A hybrid spins for a bounded period and parks if the expected short wait becomes long. Adaptive POSIX mutexes implement variants of this heuristic.

Futex-backed mutexes keep the uncontended path in user space. Acquisition commonly uses one compare-and-swap on a lock word; uncontended release updates that word without entering the kernel. On contention, the slow path marks that waiters exist and calls a futex wait operation. Unlock observes the waiter state and issues a futex wake.

The kernel wait checks that the futex word still has the expected value before sleeping. That closes the race between observing a locked word and entering the kernel: if unlock won first, the waiter returns instead of sleeping through the release. The library combines this mechanism with its user-space mutex state.

This minimal spin lock shows the busy-wait shape:

```cpp
#include <atomic>

class SpinLock {
public:
    void lock() noexcept {
        while (locked_.exchange(true)) {
            // spins; default ordering is deliberate here
        }
    }

    void unlock() noexcept {
        locked_.store(false);
    }

private:
    std::atomic<bool> locked_{false};
};
```

The atomic boolean makes individual flag operations indivisible and race-free. Chapter 25 replaces these default operations with an explicitly justified memory-ordering protocol. This code demonstrates spinning; production spin locks also need architecture-aware pause instructions, fairness decisions, and careful measurement.

Low-latency trading systems sometimes spin hot threads pinned to dedicated cores because CPU burn is budgeted and wake latency matters. Core affinity, scheduler policy, and priority inheritance belong to *Linux for Low-Latency Systems*.

Choose based on the wait distribution, not the average critical-section length. A usually short hold with rare blocking I/O can make unbounded spinning disastrous in the tail. Spin-then-park bounds that failure while preserving a fast response for ordinary releases.

**Pitfall.** An uncontended benchmark exercises only the user-space fast path. It says nothing about scheduler delay, waiter fairness, or performance after the holder is descheduled.

## Thread Pools and Task Queues

Creating one thread per task incurs operating-system thread creation and stack setup for every unit of work. Unbounded creation also oversubscribes the available cores. A fixed thread pool pays those costs once and queues subsequent tasks onto persistent workers.

This pool uses one shared queue and `std::jthread` workers:

```cpp
#include <condition_variable>
#include <cstddef>
#include <functional>
#include <mutex>
#include <queue>
#include <stop_token>
#include <thread>
#include <utility>
#include <vector>

class ThreadPool {
public:
    explicit ThreadPool(std::size_t worker_count) {
        workers_.reserve(worker_count);
        for (std::size_t i = 0; i < worker_count; ++i) {
            workers_.emplace_back(
                [this](std::stop_token stop) { run(stop); });
        }
    }

    ~ThreadPool() {
        for (auto& worker : workers_) {
            worker.request_stop();
        }
        ready_.notify_all();
    }

    void submit(std::function<void()> task) {
        {
            std::lock_guard lock{mutex_};
            tasks_.push(std::move(task));
        }
        ready_.notify_one();
    }

private:
    void run(std::stop_token stop) {
        for (;;) {
            std::function<void()> task;
            {
                std::unique_lock lock{mutex_};
                ready_.wait(lock, stop, [this] {
                    return !tasks_.empty();
                });

                if (stop.stop_requested() && tasks_.empty()) {
                    return;
                }
                task = std::move(tasks_.front());
                tasks_.pop();
            }
            task();
        }
    }

    std::mutex mutex_;
    std::condition_variable_any ready_;
    std::queue<std::function<void()>> tasks_;
    std::vector<std::jthread> workers_;
};
```

The wait predicate is “a task exists.” The stop-aware `condition_variable_any` overload also returns when the worker's token receives a stop request. A worker exits only when stopping and no queued task remains; otherwise it removes one task under the lock, releases the lock, and executes outside the critical section.

The lock protects the queue, not task execution. Running a task under `mutex_` would serialize the entire pool and let arbitrary user work block submission. Moving the callable into a local transfers its ownership before the critical section ends.

The destructor requests stop on every worker and wakes sleepers. Member destruction then destroys `workers_` first because it was declared last; each `jthread` joins while the mutex, condition variable, and queue still exist.

This shutdown policy drains tasks already queued. Another valid policy rejects or discards pending work, but the API must state which one it implements. Submission concurrent with destruction needs an additional closed state and caller-side lifetime guarantee; this compact pool assumes owners stop submitting before destruction begins.

Submission copies or moves a callable into `std::function`. That wrapper requires copyable targets and may allocate for large captures (Chapter 21). `std::move_only_function` **(C++23)** accepts move-only tasks and is a better queue element when the target standard library provides it.

```cpp
void publish_mid(int mid);

void submit_example() {
    ThreadPool pool{4};
    int bid = 100;
    int ask = 102;

    pool.submit([bid, ask] {
        int mid = (bid + ask) / 2;
        publish_mid(mid);
    });
}  // pool drains and joins
```

One shared queue is **work sharing**: producers and all workers contend on one mutex, but scheduling is simple and balanced. Production executors often give each worker a deque. The owner pushes and pops at its hot end; an idle worker steals from the opposite, colder end. This spreads contention and preserves the owner's cache locality.

The pool size should reflect runnable CPU work, not incoming task count. CPU-bound workers beyond available cores add preemption; blocking tasks may justify a different pool or an explicit blocking service. Mixing both in one pool lets slow external waits consume every worker.

Queueing also destroys latency when arrival rate exceeds service rate. A bounded queue forces the system to choose: block producers, reject new tasks, shed old work, or degrade computation. Hiding that choice behind an unbounded queue postpones failure while making it larger.

An unbounded task queue does not reject overload; it converts overload into memory growth and rising tail latency. Backpressure policies belong to Chapter 26.

**Pitfall.** Pool tasks that synchronously wait for other tasks in the same saturated pool can deadlock by starvation. Every worker waits while the tasks that would release them remain queued.

## Pathologies

Concurrency failures have distinct mechanisms. Calling all of them “deadlock” hides the fix.

Deadlock requires four conditions:

- **Mutual exclusion:** a resource has one owner at a time.
- **Hold and wait:** an activity holds one resource while waiting for another.
- **No preemption:** another activity cannot forcibly take the resource.
- **Circular wait:** each activity waits for a resource held by the next.

Break any one condition to rule out that deadlock. A global lock order breaks circular wait. `std::scoped_lock` uses an algorithm that avoids holding one mutex indefinitely while blocking on another.

Lock-order rules must include callbacks, error handling, and teardown. A function that calls unknown code while holding a mutex effectively imports that code's lock acquisitions into its own order. Release before callbacks unless the API explicitly makes reentrancy part of the invariant.

Try-lock with backoff can also avoid hold-and-wait:

```cpp
#include <mutex>
#include <thread>

void update_guarded_pair();

void update_pair(std::mutex& first, std::mutex& second) {
    if (&first == &second) {
        std::lock_guard lock{first};
        update_guarded_pair();
        return;
    }

    for (;;) {
        std::unique_lock first_lock{first};
        std::unique_lock second_lock{second, std::try_to_lock};

        if (second_lock.owns_lock()) {
            update_guarded_pair();
            return;
        }

        first_lock.unlock();
        std::this_thread::yield();
        // production retry uses randomized jitter
    }
}
```

The function never waits for `second` while retaining `first`. Opposing callers can nevertheless release and retry in lockstep forever. That is **livelock**: the threads execute, react to each other, and consume CPU, but no useful operation completes. Randomized backoff reduces synchronized retry.

Backoff is a contention policy, not a substitute for a coherent lock order. Random delay improves probability of progress but gives no simple fairness guarantee, and it adds latency variance.

**Priority inversion** occurs when a high-priority thread waits for a lock held by a low-priority thread while medium-priority work prevents the holder from running. Priority inheritance can mitigate it at the operating-system level; configuration belongs to *Linux for Low-Latency Systems*.

A **lock convoy** forms when many threads repeatedly park behind one hot lock. Unlock wakes a waiter, the waiter runs a short critical section, and the next waiter repeats the scheduling cycle. The protected work may be cheap while park and wake dominate total time.

Sharding one lock into independent state can dissolve a convoy if operations rarely need several shards. Batching several updates under one acquisition amortizes wake traffic. Both change the protected invariant, so correctness design comes before the mechanical optimization.

| Pathology | Definition | Detection symptom | Typical fix |
|---|---|---|---|
| Deadlock | Wait cycle; nobody can continue | No progress, blocked stacks form cycle | Lock order, `scoped_lock`, remove hold-and-wait |
| Livelock | Active retries; nobody completes | High CPU, rising retry count | Randomized backoff, serialize arbitration |
| Priority inversion | Urgent waiter blocked behind preempted holder | High-priority latency tracks unrelated work | Short holds, priority inheritance |
| Lock convoy | Waiters parade through one hot lock | Many sleeps/wakes around short holds | Shard state, batch work, reduce contention |

Rare production deadlocks usually expose a lock-order violation on an uncommon error or teardown path. Record lock ownership and blocked stacks rather than concluding that the mutex is randomly slow.

Convoys require a different diagnosis. Measure waiter counts, sleeps, wakeups, and scheduling delay in addition to critical-section duration.

## Latency Lens

- An uncontended futex-backed mutex stays in user space, commonly acquiring with one compare-and-swap; contention adds kernel wait/wake operations and scheduler delay.
- A parked waiter frees its CPU but resumes through the scheduler; a spinner can react immediately to release while consuming a full logical core.
- `shared_mutex` readers update common reader bookkeeping, so its cache line can bounce across cores and make short parallel reads slower than a plain mutex.
- Holding an application lock across allocation nests allocator locks and stretches the critical section by the allocator's variable work.
- Thread creation requires OS setup and stack allocation; a fixed pool removes that work from steady-state task execution.
- First dynamic use of a `thread_local` object runs guarded initialization per thread, and some shared-library TLS models add a helper call to each access.
- Notifying while holding the condition mutex can wake a waiter directly into another blocked acquire; publish under lock, unlock, then notify.
- A parked condition-variable, latch, barrier, or atomic wait reaches kernel-backed wait/wake machinery; choose the primitive that needs the least surrounding protocol.
- Lock convoys turn short protected work into serialized park-and-wake cycles, so waiter and wake counts matter as much as lock hold time.
