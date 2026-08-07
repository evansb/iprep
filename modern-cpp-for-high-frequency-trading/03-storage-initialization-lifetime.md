# Chapter 3 — Storage, Initialization, and Lifetime

Low-latency software often treats “where the bytes are” and “whether an object exists there” as the same question. C++ does not. Storage duration determines how long memory is reserved; object lifetime determines when typed access is valid; initialization determines the first value and the work needed to establish it. Confusing these rules produces dangling views, initialization-order failures, unnecessary page traffic, and optimizations that disappear under undefined behavior. This chapter separates the contracts and then connects them to their actual instruction, cache, and tail-latency costs.

## 3.1 Automatic Storage and Stack Frames

An object declared in a block without `static`, `thread_local`, or dynamic allocation normally has **automatic storage duration**. Its storage lasts from entry into the relevant block until control leaves it. The language does not require a machine stack, but mainstream C++ implementations place most automatic objects in a thread's stack frame when they cannot keep them entirely in registers.

```cpp
#include <array>
#include <cstdint>

std::uint64_t checksum(const std::array<std::uint64_t, 64>& words) {
    std::uint64_t sum = 0;            // often held in a register
    std::array<std::uint64_t, 8> lane{}; // may occupy stack storage
    for (std::size_t i = 0; i != words.size(); ++i)
        lane[i % lane.size()] += words[i];
    for (auto value : lane)
        sum += value;
    return sum;
}
```

On common x86-64 ABIs, entering a function may subtract a fixed amount from the stack pointer; returning adds it back. That is not a general-purpose allocation and usually performs no locking or metadata search. An optimizer can eliminate the array, scalar-replace its elements, or inline the entire function under the as-if rule. C++ guarantees only the observable behavior.

Large automatic objects are not free merely because stack-pointer adjustment is cheap. Touching a 1 MiB array writes roughly 16,384 64-byte cache lines and may fault in hundreds of pages. A thread stack often includes a guard region; excessive growth can terminate the process. Recursive call depth makes the bound harder to establish.

The compiler may also insert stack probing for a large frame so that execution cannot jump over an operating-system guard page. Probe policy belongs to the compiler, ABI, and platform, not C++. On x86-64 System V, leaf functions may use a small red-zone region below the current stack pointer; signal and kernel conventions constrain that optimization. These details explain why source-level object size is necessary but insufficient for predicting prologue work.

```cpp
void parse_packet() {
    // Poor hot-path choice: large per-call footprint and implicit zeroing.
    std::array<std::byte, 1 << 20> scratch{};
    // ...
}
```

Prefer a bounded scratch object sized for the protocol, provisioned once per worker, when the maximum is too large for comfortable stack use. The choice is not “stack fast, heap slow.” Ask how many bytes are touched, whether pages are resident, which cache levels are displaced, and whether concurrent invocations multiply the footprint.

Inspect the result rather than inferring it from source:

```sh
g++ -std=c++23 -O3 -Wall -Wextra -S -masm=intel automatic.cpp
g++ -std=c++23 -O2 -Wframe-larger-than=4096 automatic.cpp
```

The frame-size warning catches retained stack storage, not arrays optimized away. Test realistic optimization and instrumentation configurations because sanitizers add frames and red zones.

Automatic lifetime also gives deterministic cleanup. Leaving through a normal return or exception destroys constructed locals in reverse order. That is excellent for locks and descriptor wrappers, but an apparently harmless scope exit can therefore unlock, close, free, or walk a container. The lexical location of destruction is predictable; the amount of work depends on the members.

## 3.2 Static Storage and Initialization Order

Objects declared at namespace scope, objects declared `static`, and certain template static data members have **static storage duration**. Their storage exists for the duration of the program. Initialization and destruction, however, have a defined ordering only within specific limits.

Within one translation unit, dynamically initialized non-inline namespace objects are generally initialized in appearance order. Across translation units, relying on a particular order is usually wrong. If one initializer calls another translation unit before its object has been dynamically initialized, the program may observe only zero initialization or trigger deeper lifetime errors.

Initialization occurs in phases. Static initialization—constant initialization when possible, otherwise zero initialization—precedes dynamic initialization. Consequently, a dynamically initialized integer may temporarily contain zero before its initializer runs. Observing that intermediate state through an ordering bug does not make the program safely initialized; it only makes the failure deceptively repeatable.

```cpp
// venue.cpp
std::string make_venue();
std::string venue = make_venue();

// logger.cpp
extern std::string venue;
Logger logger{venue}; // order relative to venue is not safely implied by files
```

This is the static initialization order problem. Link order may appear to fix it, but link order is not a portable application contract. Prefer constant initialization, values with trivial initialization, or a function that owns a local static when lazy initialization is acceptable.

```cpp
const Logger& logger() {
    static const Logger instance{/* explicit configuration */};
    return instance;
}
```

Static objects occupy data or zero-filled segments in a typical ELF executable. Zero-filled storage need not consume the same amount of space in the executable file, but it contributes to virtual memory and becomes resident when pages are touched. A large static table can improve ownership simplicity while still creating page faults, cache pressure, and startup work.

Destruction has its own ordering hazards. Namespace objects are destroyed after `main` returns, broadly reversing completed initialization relationships. A destructor that calls an already-destroyed global is broken. Long-running trading processes often avoid meaningful work in global destructors: make shutdown an explicit, ordered phase and keep unavoidable static destructors independent.

C++17 inline variables solve multiple-definition mechanics for header-defined state, but they do not turn a dependency graph into an ordered startup sequence. Similarly, templates can create static objects in multiple instantiation contexts with ordering rules that are harder to see in a file-by-file review. A dependency passed through `main` remains more explicit than a constructor that reaches into a registry.

For verification, use `readelf -S` or `size` to inspect ELF sections, and trace constructors under a debugger when ordering matters. Better still, remove the ordering dependency from the design.

## 3.3 Constant Initialization, `constexpr`, and `constinit`

**Constant initialization** establishes a static or thread-storage object from a constant expression before dynamic initialization begins. It prevents the cross-translation-unit race described in Section 3.2 and usually moves work from startup into the executable image or its zero-filled representation.

`constexpr`, introduced in C++11 and expanded in later standards, says that an entity can participate in constant evaluation subject to its rules. It also makes an object `const`. C++20 `constinit` instead requires static or thread storage to be statically initialized, without making the object immutable.

```cpp
#include <array>
#include <cstdint>

constexpr std::array<std::uint32_t, 4> masks{
    0xffu, 0xff00u, 0xff0000u, 0xff000000u
};

constinit std::uint64_t packets_seen = 0; // mutable, no dynamic initializer

// constinit std::uint64_t seed = read_clock(); // ill-formed
```

`constinit` is a diagnostic contract, not a request to optimize. If the initializer cannot be performed statically, compilation fails. This is valuable for registries, lookup metadata, and counters whose availability must not depend on startup order.

Neither `constexpr` nor `constinit` alone determines whether storage lands in a read-only ELF segment. Taking an address, relocation requirements, mutability, and linker decisions affect placement. A `constexpr` function also need not run at compile time when invoked with runtime values. It supplies a path for constant evaluation; only a context requiring a constant expression makes that path mandatory.

Constant evaluation shifts when work occurs, but it does not erase storage. A 4 MiB precomputed table can enlarge the binary, increase mapping and page-cache footprint, cause instruction or data TLB pressure, and lengthen deployment or fault-in time. A computed-at-startup table may use a smaller image but add unpredictable startup work. Measure the operational phase that matters.

```cpp
constexpr auto make_digit_table() {
    std::array<unsigned char, 200> result{};
    for (unsigned i = 0; i != 100; ++i) {
        result[2 * i]     = static_cast<unsigned char>('0' + i / 10);
        result[2 * i + 1] = static_cast<unsigned char>('0' + i % 10);
    }
    return result;
}

inline constexpr auto digit_table = make_digit_table();
```

The `inline` variable facility is C++17. It permits the header definition to denote one entity across translation units. Check symbol and section placement with `nm -C`, `readelf`, or the linker map; do not assume that source-level compile-time computation implies a particular binary representation.

## 3.4 Dynamic Initialization and Function-Local Static Guards

**Dynamic initialization** executes code to initialize a static or thread-storage object when constant initialization is insufficient. It may allocate, take locks, perform I/O, or throw, depending on the initializer.

```cpp
const Config config = load_config("gateway.conf");
```

Such namespace-scope work runs before `main` in the ordinary case, making errors harder to report and startup dependencies harder to control. Prefer an explicit initialization phase when order, failure, and measurement matter.

Since C++11, initialization of a block-scope static is thread-safe. Exactly one thread completes initialization; other threads attempting the declaration wait. If initialization throws, it is considered incomplete and a later call retries. Recursive re-entry into the initialization is not a useful synchronization technique and can fail catastrophically.

```cpp
const DecoderTable& decoder_table() {
    static const DecoderTable table = build_decoder_table();
    return table;
}
```

Common Itanium C++ ABI implementations associate a guard object with `table`. The fast path commonly reads a guard byte and branches; the cold path calls runtime guard-acquire and guard-release functions. The exact representation is ABI-specific, and an optimizer may hoist or remove repeated checks when it can prove initialization.

Completion of the initialization is synchronized with later calls that observe the initialized static. Application code does not need another atomic flag around it. Adding one can create a second protocol with weaker ordering or double initialization. The one-time mechanism also registers destruction where required, so a non-trivial local static may add termination bookkeeping as well as first-use construction.

That hidden branch matters only after context is known. One correctly predicted load-and-branch is often modest, but a first call on the critical path can build a table, allocate, fault pages, and block competing threads. Warm the object during a controlled phase or pass an already-created dependency into the hot path. Do not disable thread-safe statics globally unless the program supplies a valid single-threaded initialization contract.

Inspect the optimized assembly for `__cxa_guard_acquire` on relevant targets. A concurrency test can verify one-time construction, but it cannot prove absence of a race under every schedule; the language guarantee supplies that proof when the code follows the rule.

## 3.5 Thread-Local Storage Models and Costs

An object declared `thread_local` has **thread storage duration**: each thread has a distinct instance whose lifetime normally spans that thread. This removes sharing and coherence traffic for mutable per-thread state, but multiplies memory use and introduces an address-computation mechanism.

```cpp
struct Counters {
    std::uint64_t decoded{};
    std::uint64_t rejected{};
};

thread_local Counters counters;

void record_decode(bool valid) noexcept {
    valid ? ++counters.decoded : ++counters.rejected;
}
```

C++ specifies per-thread identity and initialization behavior, not a TLS instruction sequence. ELF systems support several TLS access models. For a definition known in the main executable, a compiler can commonly use a fixed offset from the thread pointer. Position-independent code in a dynamically loaded object may require a more general sequence or a helper call. Linker relaxation can turn a general model into a cheaper one.

Non-trivial TLS creates more work. Each thread may run a constructor on first odr-use and register a destructor for thread exit. Starting 200 threads with a 64 KiB TLS buffer reserves or commits a multiplied footprint. TLS also complicates aggregation: a monitoring thread cannot read every worker's counters through its own `thread_local` name.

Dynamic libraries and runtime loading make TLS access more interesting. A compiler that cannot assume a fixed module offset may emit a call through `__tls_get_addr` or an equivalent runtime path. The linker can sometimes relax this after seeing the complete program. This is why a standalone object-file disassembly can overstate the final cost, while a microbenchmark linked into the main executable can understate the cost in a plugin.

Use TLS for intentionally partitioned state such as parser scratch space or local histograms, then design an explicit publication path. Avoid silently large instances and hidden allocation in constructors. If a thread must be warmed, touch its TLS on that same thread so first-touch NUMA placement follows the intended CPU.

Compare access sequences with `objdump -dr` in the actual executable and shared-library arrangement. Measure both steady access and worker creation; a microbenchmark that repeatedly increments one resident TLS integer says nothing about construction, pages, or teardown.

## 3.6 Dynamic Storage and Allocator Interaction

**Dynamic storage duration** begins and ends through allocation and deallocation operations, most commonly `new`/`delete` or allocator interfaces. Dynamic lifetime is independent of lexical scope, so ownership must make release explicit.

```cpp
auto order = std::make_unique<Order>(id, price, quantity);
```

The allocation function obtains suitably sized and aligned storage; construction then begins an `Order` lifetime in it. If construction throws, the matching deallocation function releases the storage. `delete` reverses the process: destruction first, deallocation second.

A new-expression is therefore not synonymous with a call to `operator new`. It selects an allocation function, obtains storage, and initializes an object. Placement forms can skip storage acquisition; class-specific allocation functions can change where requests go; over-aligned types can select aligned overloads. Array forms may retain an element count for destruction in implementation-specific metadata, sometimes called an array cookie.

C++ does not prescribe heap metadata, size classes, locks, thread caches, or system calls. A common allocator services small requests from per-thread caches and only occasionally extends an arena or asks the kernel for mappings. Therefore a benchmark can show a cheap median alongside rare refill, synchronization, page-fault, or reclamation spikes. Fragmentation and cross-thread frees affect memory and latency long after a single call.

Dynamic allocation is appropriate when size or lifetime truly is dynamic. It is a poor default for every decoded market-data message. A bounded pool can move capacity decisions and page touching into initialization, but then exhaustion policy becomes part of correctness: reject, shed, overwrite, or leave the hot path. Chapter 10 develops allocator choices in detail.

Separate these costs when measuring:

1. allocator bookkeeping;
2. object construction and destruction;
3. first access to newly mapped pages;
4. cache effects and fragmentation;
5. contention and remote frees.

Tools such as heap profilers show call sites and retained bytes; `perf stat` can report page faults and cache events; allocator-specific statistics can expose refills. None alone proves a worst-case bound.

Allocation failure is part of the contract. Throwing `new` reports failure with `std::bad_alloc`; nothrow forms return null. Linux overcommit can let allocation succeed before later page access encounters severe memory pressure or process termination. A bounded system must validate committed working capacity operationally, not infer it from successful pointer return alone.

## 3.7 Temporary Materialization and Full Expressions

A **temporary object** is an unnamed object created while evaluating an expression. A **full-expression** is an expression that is not a subexpression of another unevaluated full-expression; temporaries are generally destroyed at its end, in reverse completion order.

Since C++17, prvalues are often used to initialize their destination directly rather than first creating a separate temporary. A **temporary materialization conversion** creates a temporary object when a glvalue is needed, for example to bind a reference to a class prvalue.

```cpp
Quote make_quote();

void consume(const Quote&);

consume(make_quote()); // temporary lives through the full-expression
```

Binding a temporary to a local `const` lvalue reference or rvalue reference can extend its lifetime to that reference's lifetime:

```cpp
const Quote& quote = make_quote(); // lifetime extended to quote's scope
```

Lifetime extension does not transit through arbitrary function returns or reference members. Returning a reference parameter bound to a temporary does not grant a new lifetime.

```cpp
const Quote& identity(const Quote& q) { return q; }

const Quote& broken = identity(make_quote()); // dangling after this declaration
```

Binding rules around aggregate reference members and `new`-initializers contain sharp edges. A reference stored in an object is still non-owning; it does not generally turn the referent into a subobject. Prefer an owning value or an interface whose lifetime relationship is visible instead of relying on a rarely remembered exception.

Temporary syntax does not imply expensive runtime work. C++17 guaranteed copy elision and ordinary optimization often construct directly in final storage. Conversely, a compact expression can hide allocation, reference-count updates, or destruction:

```cpp
auto text = std::string{"order="} + std::to_string(id);
```

Count semantic operations first, then inspect assembly and allocation profiles. Breaking an expression into named variables may improve lifetime clarity without changing optimized instructions.

## 3.8 Default, Value, Zero, Direct, Copy, and List Initialization

Initialization syntax selects different language rules and sometimes different overloads. The important forms are not interchangeable.

```cpp
int a;          // default-initialization: indeterminate value
int b{};        // value-initialization: zero
int c = 7;      // copy-initialization
int d(7);       // direct-initialization
int e{7};       // direct-list-initialization
int f = {7};    // copy-list-initialization
```

Reading `a` before assigning an appropriate value is erroneous or undefined depending on the precise C++ version and context; it is never a latency optimization. Braces reject many narrowing conversions:

```cpp
// int ticks{3.5}; // ill-formed: narrowing
int ticks(3.5);    // valid conversion, value becomes 3
```

Zero initialization participates in initialization of static-storage objects and in value initialization. It can be observable work for large automatic or dynamic objects:

```cpp
std::array<std::uint64_t, 1'000'000> histogram{};
```

This establishes every element as zero. An optimizer may remove stores it proves unobservable, but if the array is used, the program must obtain the same values. First writes can consume memory bandwidth, allocate cache lines, and fault pages.

The “most vexing parse” remains a reason to understand grammar:

```cpp
Decoder decoder(); // declares a function, not an object
Decoder decoder{}; // constructs an object
```

List initialization is useful but not universally preferable because `initializer_list` overloads receive special treatment, as Section 3.9 shows. Choose syntax for the intended constructor and verify with compiler diagnostics such as `-Wconversion` and `-Wmissing-field-initializers`.

For class types, default-initialization invokes a selected default constructor; value-initialization can first zero-initialize under its detailed rules and then initialize the class. In-class member initializers supply defaults when a constructor does not explicitly initialize those members. Constructor member-initializer lists override them. Reading the braces without reading the selected constructor is therefore insufficient to count stores.

Aggregate initialization initializes members in declaration order. Missing members are initialized from in-class initializers or from empty lists under the aggregate rules. Those rules have evolved across language versions, so an aggregate API that depends on subtle eligibility can change during a standard-mode upgrade. Compile with the supported modes and use named factories when stable semantics matter more than terse syntax.

## 3.9 `initializer_list` Preference and Move Inhibition

When list-initialization considers constructors, viable `std::initializer_list` constructors receive preference in an early overload-resolution phase. Braces can therefore select a meaning different from parentheses.

```cpp
#include <vector>

std::vector<int> a(4, 9); // four elements, each 9
std::vector<int> b{4, 9}; // two elements: 4 and 9
```

This is a semantic difference, not a formatting preference. It can change capacity, bytes written, and downstream work.

An `initializer_list<T>` is a lightweight view over an underlying array whose elements are `const T`. The view itself commonly contains a pointer and a length, but C++ does not require that representation. Because elements are const, a consumer generally cannot move resources out of them.

The compiler supplies the backing array; this does not by itself imply a heap allocation. The selected container constructor may still allocate destination storage. Separate backing-array materialization, element construction, destination allocation, and copying when explaining the cost.

```cpp
#include <memory>
#include <vector>

// std::vector<std::unique_ptr<int>> p{
//     std::make_unique<int>(1), std::make_unique<int>(2)
// }; // typically ill-formed: elements would need copying

std::vector<std::unique_ptr<int>> p;
p.reserve(2);
p.push_back(std::make_unique<int>(1));
p.push_back(std::make_unique<int>(2));
```

For copyable but expensive objects, list construction may copy where a reserve-and-emplace sequence moves or constructs in place. It may also be perfectly adequate for small configuration tables outside the critical path. Determine ownership and construction count rather than banning braces.

Temporary backing-array lifetime is tied to the `initializer_list` object under specific rules, but storing raw iterators beyond it still risks dangling. Enable warnings and test APIs with move-only types; they expose accidental copy requirements quickly.

## 3.10 Lifetime Beginning and Ending

An object's **lifetime** is the interval during which storage contains that object and operations may treat it as that type. Storage can exist before lifetime begins and after it ends. A valid address alone is not enough.

For a class type, lifetime generally begins when suitably aligned storage exists and initialization is complete, with detailed exceptions for union and implicit-lifetime objects. Lifetime ends when a non-class object is destroyed, when a class destructor call starts, or when its storage is released or reused by another object.

Construction and destruction of complete objects also move through base and member subobject lifetimes. During base construction and destruction, virtual dispatch follows special rules because the most-derived object is not fully available in the ordinary sense. Publishing `this` from a constructor can expose another thread to partially initialized state; lifetime and the memory model must both be satisfied.

```cpp
struct Order {
    std::uint64_t id;
    std::int64_t price;
};

alignas(Order) std::byte bytes[sizeof(Order)]; // storage, no Order yet
```

Accessing `bytes` as an `Order` before a permitted lifetime-starting operation is invalid. After an `Order` is destroyed, reading its members through an old pointer is also invalid even though bytes remain.

Lifetime rules normally generate no instructions by themselves. Their performance effect is indirect but decisive: when the compiler can rely on valid lifetimes and no illegal aliases, it can retain values in registers and eliminate loads. Undefined lifetime access lets it assume the impossible path does not matter, so a debug observation of “the bytes are still there” proves nothing.

Use sanitizers to catch some use-after-free and use-after-scope errors:

```sh
clang++ -std=c++23 -O1 -g -fsanitize=address,undefined lifetime.cpp
```

Sanitizers are incomplete models and change layout and timing. Pair them with code review centered on lifetime transitions.

## 3.11 Implicit-Lifetime Types

An **implicit-lifetime type** is a type for which certain operations can implicitly begin object lifetime in suitable storage. Scalar types and implicit-lifetime class types are central examples. The rules make low-level allocation and byte-oriented I/O workable without requiring placement construction for every trivial record.

Allocation by `malloc` or `operator new`, and certain character or byte array creation operations, can implicitly create objects when doing so yields defined subsequent access. C++23's `std::start_lifetime_as<T>` makes an intended transition explicit where library support is available.

```cpp
#include <cstdlib>

struct WireCounters { // implicit-lifetime type
    std::uint64_t received;
    std::uint64_t dropped;
};

void example() {
    void* raw = std::malloc(sizeof(WireCounters));
    if (!raw) return;
    auto* counters = static_cast<WireCounters*>(raw);
    counters->received = 0;
    counters->dropped = 0;
    std::free(raw);
}
```

These rules do not make arbitrary byte deserialization safe. Alignment must be correct; the byte pattern must represent valid values; padding and endianness remain concerns; and a non-trivial class may require real construction. Copying a network packet into storage does not validate bounds or create portable on-wire layout.

`memcpy` and `memmove` participate in implicit object creation under modern rules for suitable destination storage and implicit-lifetime types. This supports efficient bulk copying of trivial records. It does not invoke a non-trivial constructor, update an external ownership registry, or grant permission to duplicate a resource-owning pointer. The type property and the program invariant must agree.

For protocol parsing, decode fields explicitly or copy bytes into a trivially copyable object with a defined local representation, then convert byte order. The explicit work is often cheap, vectorizable, and easier to verify than relying on packed, aliased overlays.

## 3.12 Placement Construction, `construct_at`, and `destroy_at`

**Placement construction** begins an object's lifetime in storage supplied by the caller. It separates storage management from construction, which is essential for pools, arenas, optional in-place values, and containers.

```cpp
#include <memory>

template<class T>
struct Slot {
    alignas(T) std::byte storage[sizeof(T)];
    bool engaged = false;

    template<class... Args>
    T& emplace(Args&&... args) {
        // Precondition: !engaged.
        T* p = std::construct_at(
            reinterpret_cast<T*>(storage),
            std::forward<Args>(args)...);
        engaged = true;
        return *p;
    }

    void reset() noexcept {
        if (engaged) {
            std::destroy_at(reinterpret_cast<T*>(storage));
            engaged = false;
        }
    }
};
```

C++20 `std::construct_at` is the library spelling of placement construction and works better in generic and constant-evaluation contexts. `std::destroy_at` was introduced in C++17. The storage must be large enough and correctly aligned, and no live conflicting object may occupy it.

Construction can throw. A pool must not mark a slot occupied until construction succeeds, and it must return the slot to its free structure on failure. Destruction may perform arbitrary user code; destructors intended for deterministic hot-path use should normally be `noexcept` and bounded.

The sample omits policy needed in a production slot: `emplace` must reject double construction, `reset` must establish its flag update even when design assumptions change, and the containing `Slot` must destroy an engaged value. A compact primitive is only useful when its state machine is complete:

```text
empty --successful construct--> engaged --destroy--> empty
  ^            |
  +--throw-----+
```

For a trivially destructible type, destruction usually emits no instructions. Generic code still uses `destroy_at` because the compiler can eliminate it when valid. Verify that a pool does not call the general allocator by instrumenting allocation functions or inspecting profiles, and test exception paths even when production types are normally non-throwing.

## 3.13 Storage Reuse and `std::launder`

**Storage reuse** ends one object's lifetime and begins another in the same bytes. Reuse is valid only when alignment, size, construction, and outstanding-reference rules are satisfied.

```cpp
struct Level {
    std::int64_t price;
    std::uint32_t quantity;
};

alignas(Level) std::byte slot[sizeof(Level)];

Level* first = std::construct_at(reinterpret_cast<Level*>(slot), 100, 10);
std::destroy_at(first);
Level* second = std::construct_at(reinterpret_cast<Level*>(slot), 101, 20);
```

In many ordinary cases, the old pointer can transparently refer to the new object of the same type; this is **transparent replaceability**. Exceptions include certain complete `const` objects, base subobjects, and members marked `[[no_unique_address]]` among other detailed cases.

`std::launder`, introduced in C++17, obtains a pointer the optimizer must associate with a newly created object when a reachable object exists at the address but transparent replacement does not suffice. It is not a cache flush, memory fence, or general cure for aliasing.

```cpp
// Schematic low-level case: after valid reconstruction where the old pointer
// is not transparently usable, obtain the new object pointer.
T* current = std::launder(old_pointer);
```

If no `T` is alive at that address, or if alignment and reachability preconditions fail, laundering the pointer does not help. Most application code should encapsulate reuse in a tested container or pool and return the fresh pointer produced by `construct_at`.

Reuse reduces allocation and can keep a fixed working set, but it also retains capacity and can preserve dirty cache lines. Generation counters help detect stale external handles. AddressSanitizer may not detect a stale pointer when storage is immediately reused for the same size, so design-level ownership checks remain necessary.

A handle `{slot_index, generation}` can reject a reference to a previous occupant after the slot is recycled. The generation counter must have a defined wrap policy and be validated before typed access. This costs metadata and a comparison, but turns an unbounded use-after-reuse failure into a detectable stale-handle path.

## 3.14 Union Active Members

A union provides storage large enough and aligned enough for its largest member, but at most one member is generally **active** at a time. Reading an inactive member is not a portable method of type punning.

```cpp
union Payload {
    AddOrder add;
    CancelOrder cancel;

    Payload() {}
    ~Payload() {}
};
```

For non-trivial members, the program must explicitly construct and destroy the selected member and track which one is active.

```cpp
enum class Kind { add, cancel };

struct Message {
    Kind kind;
    Payload payload;

    explicit Message(AddOrder value) : kind(Kind::add) {
        std::construct_at(&payload.add, std::move(value));
    }

    ~Message() {
        if (kind == Kind::add) std::destroy_at(&payload.add);
        else                   std::destroy_at(&payload.cancel);
    }
};
```

This hand-written tagged union has compact inline storage and no required allocation, but every copy, move, assignment, exception path, and destructor must honor the tag. `std::variant` packages those rules and is often the safer choice; Chapter 7 examines its storage and visitation costs.

Some compilers support inactive-member type punning as an extension. That does not make it portable C++. Use `std::bit_cast` for equal-sized trivially copyable values or byte-wise decoding for protocols.

Standard-layout unions have a limited common-initial-sequence permission for standard-layout struct members. It is useful for carefully designed discriminators, not a general license to inspect arbitrary inactive data. Encoding the tag outside the union is usually clearer and avoids depending on this narrow exception.

The runtime cost is the tag branch and the active member's operations, not the abstract union rule. Branch predictability depends on message distribution; a mixed feed can make dispatch less predictable. Measure representative traffic and inspect whether the compiler lowers dispatch to branches or a jump table.

## 3.15 Dangling Pointers, Views, Captures, Ranges, and Iterators

A pointer, reference, iterator, or view is **dangling** when the object or element it designates no longer exists. Non-owning handles do not extend lifetime unless a specific language rule says so.

Returning a local reference is immediately broken:

```cpp
const Order& find_order() {
    Order order{/*...*/};
    return order; // BROKEN: order dies at return
}
```

A reference capture can outlive its source:

```cpp
auto make_handler() {
    std::uint64_t sequence = 0;
    return [&] { return ++sequence; }; // BROKEN
}
```

Capture by value or give the state an owner with sufficient lifetime. `std::string_view` and `std::span` are intentionally non-owning:

```cpp
std::string_view broken_text() {
    return std::string{"temporary"}; // BROKEN
}
```

Container mutation creates another class of dangling handle. `std::vector` reallocation invalidates pointers, references, and iterators to its elements. Erasure has container-specific invalidation rules. Reserving capacity can make a vector stable only until the reserved bound is exceeded; a latency-sensitive system should make that bound and overflow behavior explicit.

| Source | Typical invalidating event | Safer design question |
|---|---|---|
| local object | scope exit | Can the result own a value? |
| `string_view`/`span` | owner destruction or mutation | Which owner travels with the view? |
| `vector` element | reallocation or relevant erase | Is capacity bounded and enforced? |
| lambda reference capture | captured scope exit | Should state be captured by value? |
| lazy range view | source expiry | Is the source a named owner? |

Lazy ranges add composition hazards. A view may store iterators or references into a source. The C++20 `borrowed_range` machinery prevents some obviously unsafe algorithm results, but it cannot infer application ownership. Treat every view as carrying a lifetime dependency.

Asynchronous boundaries amplify the problem. Passing a `span` to a function that queues work is safe only if the referenced buffer outlives completion, not merely the call. A callback that captures a stack buffer by reference has the same defect even when the queue is lock-free. APIs should distinguish synchronous consumption from retention. An owning message, pool handle with generation checking, or completion token tied to buffer release makes the relationship explicit. Copying a small bounded payload may be cheaper and more predictable than coordinating a borrowed buffer across threads.

Concurrency does not extend lifetime automatically. A pointer published with correct release/acquire ordering can still dangle if reclamation happens too early. Chapters 14 and 17 add ordering and reclamation protocols; all three conditions—valid lifetime, valid synchronization, and valid bounds—must hold at once.

That combined proof belongs in the interface contract and in every review of a cross-thread non-owning handle.

Dangling often hides during testing because bytes remain unchanged. It can surface after a compiler upgrade, allocator reuse, or unrelated logging changes. Use lifetime-oriented code review, enable warnings such as Clang's dangling diagnostics where supported, run sanitizers, and make owners visible in interfaces. Safety improves predictability: a stale read is not a rare slow path but unconstrained behavior.

## 3.16 The Cost of Zeroing and Destruction

Zero initialization has work proportional to the bytes whose zero values must become observable. Destruction has work proportional to the object graph and resources released. Neither should be classified solely by syntax.

```cpp
struct BookState {
    std::array<Level, 1'000'000> levels{};
};

BookState state; // potentially substantial initialization writes
```

Compilers commonly emit inline stores for small objects and a `memset` call or loop for larger regions. The first touch of each page may fault and determine NUMA placement. Stores use cache and memory bandwidth and may evict useful state. Explicitly prefaulting and zeroing during startup can move this cost out of live trading, but it still consumes time and should run on the thread or NUMA node that will own the memory.

Avoiding initialization by reading indeterminate values is invalid. Valid alternatives change representation: keep a generation array beside a value array, initialize only active slots, or use an arena whose reset discards a whole phase. Each adds branches, metadata, or more complex invariants.

Destructors range from no work to an unbounded cascade. Destroying a `vector<Trivial>` commonly releases one allocation without per-element calls. Destroying a vector of strings visits elements and may free many allocations. The final `shared_ptr` release can destroy a large graph on whichever thread happens to decrement the count to zero.

Array elements, members, and bases are destroyed in defined reverse relationships after successful construction. Partial construction during an exception destroys only completed subobjects. This deterministic order is a correctness advantage, but it can concentrate cleanup into the throw or scope-exit path. When an error path has a latency objective, include unwinding cleanup in that budget.

For predictable systems, decide where reclamation occurs. Move expensive teardown to a maintenance thread only if ownership transfer is safe and the resulting queue is bounded. Keeping everything forever merely converts latency into memory exhaustion.

Verify initialization with optimized assembly and bandwidth counters, and profile shutdown or steady-state reclamation separately. Benchmark resident reuse, fresh pages, and realistic object contents; they answer different questions.

Consider a market-data worker with 65,536 reusable message slots. Zeroing every slot on every feed reconnect has simple semantics but touches the entire region at once. Leaving old objects alive avoids that burst but may retain resource ownership. Reconstructing only used slots bounds work by traffic, but requires exact engaged-state tracking. A generation-based representation can logically reset entries by incrementing an epoch, provided epoch wrap and stale handles are handled. These are different algorithms, not compiler tuning variants.

A storage decision is ready for a latency-sensitive path only when the following questions have concrete answers:

| Question | Evidence |
|---|---|
| When is storage reserved? | startup trace, allocator profile, or linker map |
| When does each object lifetime begin? | constructor/pool state machine and review |
| Which bytes are first touched, and by which CPU? | page-fault counters and NUMA inspection |
| What ends the lifetime? | explicit owner and destruction path |
| Can construction or destruction allocate, throw, or block? | type contract plus instrumented failure tests |
| Which references survive reuse or reallocation? | invalidation contract and stale-handle tests |

This analysis prevents a common category error: measuring a warm allocator operation while the production tail comes from page commitment or graph destruction. The language rules identify which transformations are valid; hardware and operating-system observations identify their cost.

## 3.17 Interview Check

1. Distinguish storage duration from object lifetime. Give an example in which storage exists but no object is alive in it.
2. Why is a stack allocation often only a stack-pointer adjustment, and why can a large local object still cause severe tail latency?
3. Explain the static initialization order problem and compare constant initialization with a function-local static.
4. What steady-state and first-use work can a thread-safe function-local static introduce on a common Linux C++ ABI?
5. Compare `constexpr` and `constinit`. Which prevents dynamic initialization without making an object immutable?
6. Why can `std::vector<int>{4, 9}` and `std::vector<int>(4, 9)` have different meanings, and how does an `initializer_list` inhibit moves?
7. Diagnose the lifetime bug in a function that returns `std::string_view` into a local `std::string`.
8. State the preconditions for using `std::construct_at` in a pool and explain the exception-safety transition for a free slot.
9. What problem does `std::launder` solve, and which alignment, lifetime, or aliasing errors can it not repair?
10. Design a startup procedure for a per-thread 8 MiB scratch region that avoids first-packet page faults and obtains intended NUMA placement.
