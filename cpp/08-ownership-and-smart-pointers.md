# 8. Ownership and Smart Pointers

An owning handle answers one question: who ends this object's lifetime? C++ makes that answer visible in types, so destruction follows control flow even through moves and exceptions. Clear ownership also removes unnecessary allocation and reference-count traffic from latency-sensitive code.

## Owners and Views

An **owner** is responsible for ending an object's lifetime. A **view**, also called a borrow, uses an object during a lifetime guaranteed by an owner.

Every object needs one clear answer to “who destroys this?” If the answer is nobody, the object leaks. If the answer is two independent owners, destruction happens twice and the program has undefined behavior.

Raw pointers and references are idiomatic non-owning views:

```cpp
#include <iostream>
#include <string>

struct OrderBook {
    std::string symbol;
    int bid_orders;
};

struct Logger {
    void write(const std::string& message) const {
        std::cout << message << '\n';
    }
};

void fill_report(const OrderBook& book, Logger* maybe_log) {
    std::cout << book.symbol << ": " << book.bid_orders << '\n';
    if (maybe_log != nullptr) {
        maybe_log->write("report complete");
    }
}

int main() {
    OrderBook book{"EUR/USD", 17};
    Logger logger;
    fill_report(book, &logger);  // neither parameter owns its argument
}
```

The parameter forms communicate different view contracts:

| Parameter | Contract |
|---|---|
| `T&` | Required, mutable view |
| `const T&` | Required, read-only view |
| `T*` | Nullable or rebindable view |
| `const T*` | Nullable, read-only view |

Ownership belongs in a signature only when the call transfers or shares ownership. A legacy factory such as `OrderBook* create_book()` leaves its caller guessing: must it call `delete`, invoke a library-specific cleanup function, or merely observe the result? The type does not say.

The slogan “never use raw pointers” is therefore wrong. The useful rule is narrower: do not use owning raw pointers in application code. `new T{...}` allocates storage and constructs a `T` there; the allocation machinery belongs to Chapter 17. Prefer an RAII owner rather than matching a naked `new` with a distant `delete`.

**Pitfall.** A raw pointer data member is ambiguous. Document it explicitly as a non-owning view or replace it with an ownership type; never make readers infer its role from destructor code.

Views inherit the lifetime constraints from Chapter 5. A pointer returned into a local object dangles as soon as that local object dies.

## RAII Owners and the Decision Table

A smart pointer applies RAII (Chapter 5) to a heap object. Its destructor releases the object, and its move operations transfer the handle as described in Chapter 7. The type system carries the ownership policy through returns, members, and exceptional exits.

Prefer a value. If the object must live separately on the heap, prefer `std::unique_ptr`. Use `std::shared_ptr` only when the last user cannot be known in advance, and use `std::weak_ptr` to observe shared state without prolonging it.

| Type | Owns? | Nullable? | Copyable? | Overhead | Use for |
|---|---:|---:|---:|---|---|
| `T` | Yes, directly | No | If `T` permits | Object itself | Default local/member representation |
| `T&` | No | No | Handle copies implicitly | None | Required view |
| `T*` | No | Yes | Yes | One pointer | Optional or rebindable view |
| `std::unique_ptr<T>` | Yes, exclusively | Yes | No; movable | Usually one pointer | Heap object with one owner |
| `std::shared_ptr<T>` | Yes, jointly | Yes | Yes | Two-pointer handle plus control block | Genuinely shared, indeterminate lifetime |
| `std::weak_ptr<T>` | No | Yes/expired | Yes | Two-pointer handle plus control block activity | Non-owning observation of shared state |

This table is a design order, not a menu of equivalent styles. Moving down introduces more flexible lifetime management and more runtime machinery.

## `unique_ptr`: The Default Owner

`std::unique_ptr<T>` is a move-only owner. Copying is deleted, moving transfers the object, and destruction calls the configured deleter. A class that stores `unique_ptr` members usually needs no hand-written destructor or move operation: the rule of zero applies.

Create one with `std::make_unique<T>(arguments)`. It is exception-safe when construction appears among other evaluated arguments (Chapter 6), and a code search for `make_unique` finds ownership creation directly.

```cpp
#include <memory>
#include <string>
#include <utility>

struct Config {
    bool passive;
};

struct Strategy {
    virtual ~Strategy() = default;
    virtual int quote() const = 0;
};

struct PassiveStrategy final : Strategy {
    int quote() const override { return 101; }
};

struct AggressiveStrategy final : Strategy {
    int quote() const override { return 102; }
};

std::unique_ptr<Strategy> make_strategy(const Config& config) {
    if (config.passive) {
        return std::make_unique<PassiveStrategy>();
    }
    return std::make_unique<AggressiveStrategy>();
}

void inspect(const Strategy& strategy) {
    (void)strategy.quote();
}

void maybe_trace(const Strategy* strategy) {
    if (strategy != nullptr) {
        (void)strategy->quote();
    }
}

struct Engine {
    std::unique_ptr<Strategy> strategy;
};

void start_engine(std::unique_ptr<Strategy> strategy) {
    Engine engine{std::move(strategy)};
    inspect(*engine.strategy);
}

void configure(const Config& config) {
    auto strategy = make_strategy(config);
    inspect(*strategy);
    maybe_trace(strategy.get());
    start_engine(std::move(strategy));
}

static_assert(sizeof(std::unique_ptr<Strategy>) == sizeof(Strategy*));
```

The factory returns by value. Copy elision and cheap moves make this the normal factory idiom (Chapter 7). `Strategy` has a virtual destructor because a `unique_ptr<Strategy>` can destroy a derived object through the base pointer (Chapter 4).

For the default deleter, major standard-library implementations make `unique_ptr<T>` pointer-sized. Its destructor typically inlines to the same null check and `delete` that careful manual code would perform.

How a function accepts the handle states what it does to ownership:

| Signature | Meaning | Caller writes |
|---|---|---|
| `void adopt(std::unique_ptr<T>)` | Transfer ownership into the call | `adopt(std::move(p))` |
| `void replace(std::unique_ptr<T>&)` | May reseat the caller's owner | `replace(p)` |
| `void use(T&)` / `void use(T*)` | Borrow the object | `use(*p)` / `use(p.get())` |
| `std::unique_ptr<T> make()` | Return a new owner | `auto p = make()` |

A `unique_ptr<T>&` parameter is rare and should attract scrutiny. If the function changes `T`, it needs `T&`; if it consumes the owner, it needs `unique_ptr<T>` by value. A reference to the handle is appropriate only when reseating that exact handle is part of the contract.

`.get()` exposes the stored raw pointer without changing ownership. `.release()` is different: it returns the pointer and leaves the `unique_ptr` empty without deleting the object. Use `release()` only when immediately handing ownership to an API whose contract says it will release the resource.

**Pitfall.** A raw pointer obtained from `.get()` dangles when its `unique_ptr` destroys or replaces the object. Never store that view beyond the owner's guaranteed lifetime.

**Pitfall.** Constructing two `unique_ptr`s from the same raw pointer creates two owners. Both invoke deletion, so the second destruction has undefined behavior.

**Rule.** Every successful call to `.release()` must have a receiving owner. Discarding the returned pointer leaks the object.

## Custom Deleters

A deleter is the policy for releasing a resource. The default invokes `delete`, but a C library may require a function such as `std::fclose`.

```cpp
#include <cstdio>
#include <memory>

struct FCloser {
    void operator()(std::FILE* file) const noexcept {
        if (file != nullptr) {
            std::fclose(file);
        }
    }
};

using CompactFile = std::unique_ptr<std::FILE, FCloser>;
using FunctionFile =
    std::unique_ptr<std::FILE, decltype(&std::fclose)>;

CompactFile open_compact(const char* path) {
    return CompactFile{std::fopen(path, "rb")};
}

FunctionFile open_with_function(const char* path) {
    return FunctionFile{std::fopen(path, "rb"), &std::fclose};
}

static_assert(sizeof(CompactFile) == sizeof(void*));
static_assert(sizeof(FunctionFile) == 2 * sizeof(void*));
```

The empty `FCloser` carries no per-handle state, so implementations can store it without increasing the handle size. A function-pointer deleter needs another pointer. A stateful deleter adds whatever state it stores.

A captureless lambda can also provide a zero-state deleter:

```cpp
constexpr auto close_file = [](std::FILE* file) noexcept {
    if (file != nullptr) {
        std::fclose(file);
    }
};

using LambdaFile =
    std::unique_ptr<std::FILE, decltype(close_file)>;

static_assert(sizeof(LambdaFile) == sizeof(void*));
```

Lambda mechanics appear in Chapter 9. The important ownership fact is that `unique_ptr` stores its deleter, and the deleter's type is part of the `unique_ptr` type. `unique_ptr<T, FCloser>` and `unique_ptr<T, OtherCloser>` are different, generally non-assignable types.

This wrapper is Chapter 5's `FileHandle` expressed in one line of ownership machinery. The same pattern handles sockets, directory handles, and library objects with dedicated cleanup functions.

A `shared_ptr` also accepts a custom deleter, but stores that deleter in its type-erased control block. Changing the deleter does not change the `shared_ptr<T>` handle type or size.

**Pitfall.** Giving a C-API pointer to a default `unique_ptr` may pair its creation with the wrong release operation. Applying `delete` to storage returned by `malloc`, or to a handle requiring a library cleanup call, has undefined behavior; Chapter 17 covers allocation and deallocation pairs.

## `shared_ptr`: Control Blocks and Refcounts

`std::shared_ptr<T>` represents shared ownership. The last owning handle destroys the object. That requires bookkeeping outside the handle itself: a **control block** tracks owners and observers.

```text
shared_ptr<T>
+----------------+       +------------------------------+
| object pointer | ----> | T object                     |
| control pointer| --+   +------------------------------+
+----------------+   |
                   \->   +------------------------------+
                         | strong count | weak count    |
                         | deleter      | allocator data|
                         +------------------------------+
```

Some constructions place the object inside the control-block allocation instead:

```text
+-------------------------------------------------------+
| strong count | weak count | deleter | T object storage|
+-------------------------------------------------------+
```

The **strong count** records owning `shared_ptr`s. The **weak count** supports `weak_ptr` observers and control-block lifetime. A typical `shared_ptr` handle stores an object pointer and a control-block pointer:

```cpp
#include <iostream>
#include <memory>

struct MarketData {
    int sequence = 0;
};

int main() {
    auto data = std::make_shared<MarketData>();
    std::cout << data.use_count() << '\n';  // prints: 1

    {
        auto copy = data;                   // strong-count increment
        std::cout << data.use_count() << '\n';  // prints: 2
    }                                      // strong-count decrement

    std::cout << data.use_count() << '\n';  // prints: 1
}

static_assert(sizeof(std::shared_ptr<MarketData>) ==
              2 * sizeof(void*));
```

Each copy performs a thread-safe read-modify-write on the strong count, commonly called an atomic increment. This is costlier than plain arithmetic; Chapter 25 explains the mechanism. Each destruction performs the corresponding decrement and branches on whether it removed the final owner.

The count's thread safety protects ownership bookkeeping only. It does not make concurrent access to the `MarketData` object safe; Chapters 23–25 cover synchronization.

Construction determines allocation shape:

| Spelling | Allocations | Layout | Caveat |
|---|---:|---|---|
| `std::shared_ptr<T>(new T(args))` | Usually two | Object separate from control block | Extra allocation; object storage can free before weak observers die |
| `std::make_shared<T>(args)` | Usually one | Object embedded beside bookkeeping | Whole allocation remains while weak observers remain |

`std::make_shared` is the default. One allocation means less allocator work, and adjacent object and bookkeeping storage often improve locality. The separate-allocation spelling remains useful for the weak-retention case discussed later.

**Pitfall.** Two `shared_ptr`s independently constructed from the same raw pointer create two control blocks, each convinced it owns the object. This ends in double deletion.

**Pitfall.** Passing `shared_ptr` by value everywhere creates reference-count traffic everywhere. Pass `const std::shared_ptr<T>&` when a function genuinely needs the shared handle without taking a new share; better, pass `T&` when it only uses the object.

## Aliasing and `enable_shared_from_this`

The aliasing constructor creates a `shared_ptr` that shares one owner's control block but stores a different object pointer. It can expose a subobject while keeping the containing object alive.

```cpp
#include <cstdint>
#include <memory>

struct Message {
    std::uint64_t sequence;
    std::uint16_t flags;
};

auto message = std::make_shared<Message>(Message{42, 3});
std::shared_ptr<std::uint16_t> flags{message, &message->flags};

// flags points at Message::flags but owns the Message allocation.
// message.use_count() == 2
```

The `flags` handle dereferences to the two-byte member, but its strong count belongs to `message`. This is useful when downstream code needs one field from a shared message without copying it.

It also means a tiny alias can pin a large allocation. Ownership follows the control block, not the stored pointer.

An object that must produce a `shared_ptr` to itself inherits from `std::enable_shared_from_this`:

```cpp
#include <memory>

struct Registry;

struct Session : std::enable_shared_from_this<Session> {
    void register_self(Registry& registry);

    std::shared_ptr<Session> wrong() {
        return std::shared_ptr<Session>(this);
        // UB later: a second control block causes double deletion
    }
};

struct Registry {
    std::shared_ptr<Session> current;
};

void Session::register_self(Registry& registry) {
    registry.current = shared_from_this();  // shares existing block
}

void connect(Registry& registry) {
    auto session = std::make_shared<Session>();
    session->register_self(registry);
}
```

The inheritance names the class's own type; Chapter 9 explains this class-template pattern. `shared_from_this()` finds the existing control block instead of inventing a second one.

The object must already belong to a `shared_ptr`. Calling `shared_from_this()` on a stack object, or before the first `shared_ptr` has established ownership, throws `std::bad_weak_ptr` (C++17). A constructor is therefore too early.

**Rule.** Never create a fresh `shared_ptr` from `this`. Use `shared_from_this()` only after external shared ownership exists.

## `weak_ptr` and Ownership Cycles

Reference counts cannot collect cycles. If a parent and child own each other with `shared_ptr`, each keeps the other's strong count above zero after all outside owners disappear.

```cpp
#include <iostream>
#include <memory>

struct Child;

struct Parent {
    std::shared_ptr<Child> child;
    ~Parent() { std::cout << "~Parent\n"; }
};

struct Child {
    std::shared_ptr<Parent> parent;
    ~Child() { std::cout << "~Child\n"; }
};

void leak_cycle() {
    auto parent = std::make_shared<Parent>();
    auto child = std::make_shared<Child>();
    parent->child = child;
    child->parent = parent;
}  // prints nothing: both objects leak
```

One direction must be an observation rather than ownership. `std::weak_ptr<T>` refers to a shared control block without increasing its strong count:

```cpp
#include <iostream>
#include <memory>

struct Child;

struct Parent {
    std::shared_ptr<Child> child;
    ~Parent() { std::cout << "~Parent\n"; }
};

struct Child {
    std::weak_ptr<Parent> parent;
    ~Child() { std::cout << "~Child\n"; }

    void report_parent() const {
        if (auto owner = parent.lock()) {
            std::cout << "parent alive\n";
        }
    }
};

void use_tree() {
    auto parent = std::make_shared<Parent>();
    auto child = std::make_shared<Child>();
    parent->child = child;
    child->parent = parent;
    child->report_parent();  // prints: parent alive
}  // prints: ~Parent
   // prints: ~Child
```

`lock()` attempts to produce a new `shared_ptr`. It returns an empty handle if the strong count has already reached zero. Testing and acquiring ownership happen as one operation, so the returned owner keeps the object alive through the guarded body.

| Property | `shared_ptr<T>` | `weak_ptr<T>` |
|---|---|---|
| Owns / affects strong count | Yes | No |
| Direct member access | `p->member` | Not available |
| Keeps object alive | Yes | No |
| Safe access | Dereference nonempty handle | Call `lock()`, test result |
| Typical role | Shared lifetime | Cycle-breaking link or cache observer |

A cache can store `weak_ptr` entries so lookup can reuse an object that someone else still owns without making the cache pin every object forever.

**Pitfall.** Do not call `expired()` and then call `lock()` as a check-then-use sequence. The object may expire between those operations when threads are involved; use the result of one `lock()` call.

A `weak_ptr` can observe only an object with a shared control block. It cannot be constructed as an observer of a stack object or an object owned solely by `unique_ptr`.

## The `make_shared` Weak-Retention Gotcha

Destruction and deallocation are separate events. When the last strong owner disappears, `shared_ptr` runs the object's destructor. The control block remains until the last `weak_ptr` disappears.

With `make_shared`, the object storage and control block occupy one allocation. That allocation cannot be released while weak observers need its control block, even though the object inside it has already been destroyed.

```cpp
#include <array>
#include <memory>

struct Snapshot {
    std::array<char, 1'000'000> bytes;
};

void retain_storage() {
    std::weak_ptr<Snapshot> observer;
    {
        auto snapshot = std::make_shared<Snapshot>();
        observer = snapshot;
    }  // Snapshot destructor runs; combined allocation remains

    observer.reset();  // weak count falls; allocation can be freed
}
```

This is retention, not an object-lifetime leak. A memory profiler can show the block as still allocated even though `Snapshot` is no longer alive.

With `std::shared_ptr<Snapshot>(new Snapshot)`, the object's separate allocation is released when the strong count reaches zero. Only the smaller control-block allocation remains for weak observers.

Use the two-allocation form when objects are large and `weak_ptr`s routinely outlive all owners. Otherwise, `make_shared` remains the better default because it saves an allocation and improves locality.

**Note.** “Destroyed” means the C++ object lifetime ended. “Deallocated” means its storage returned to the allocator; the two events need not coincide.

## Intrusive Reference Counting

An intrusive reference-counted object stores the count inside itself. The handle calls `add_ref()` when it acquires a share and `release()` when it gives one up.

```cpp
#include <cassert>
#include <cstddef>
#include <utility>

class RefCounted {
public:
    void add_ref() noexcept { ++references_; }

    void release() noexcept {
        assert(references_ > 0);
        if (--references_ == 0) {
            delete this;
        }
    }

protected:
    virtual ~RefCounted() = default;

private:
    std::size_t references_ = 0;
};

class OrderBook final : public RefCounted {
public:
    explicit OrderBook(int levels) : levels_(levels) {}
    int levels() const noexcept { return levels_; }

private:
    int levels_;
};

class IntrusiveBookPtr {
public:
    explicit IntrusiveBookPtr(OrderBook* pointer = nullptr)
        : pointer_(pointer) {
        if (pointer_ != nullptr) {
            pointer_->add_ref();
        }
    }

    IntrusiveBookPtr(const IntrusiveBookPtr& other)
        : IntrusiveBookPtr(other.pointer_) {}

    IntrusiveBookPtr(IntrusiveBookPtr&& other) noexcept
        : pointer_(std::exchange(other.pointer_, nullptr)) {}

    ~IntrusiveBookPtr() {
        if (pointer_ != nullptr) {
            pointer_->release();
        }
    }

    OrderBook& operator*() const noexcept { return *pointer_; }
    OrderBook* operator->() const noexcept { return pointer_; }

private:
    OrderBook* pointer_;
};

void inspect_book() {
    IntrusiveBookPtr first{new OrderBook{10}};
    {
        IntrusiveBookPtr second = first;  // add_ref
        assert(second->levels() == 10);
    }                                    // release
}                                        // release, then delete

static_assert(sizeof(IntrusiveBookPtr) == sizeof(void*));
```

This concrete handle shows the mechanics without introducing the class templates of Chapter 9. A reusable `IntrusivePtr<T>` generalizes the same operations; `boost::intrusive_ptr` is a widely used production implementation.

Unlike `shared_ptr`, an intrusive handle needs no separate control block. It is one word, and creating the first owner requires one object allocation. Because the count belongs to the object, member code can safely create another intrusive handle from `this`: every handle reaches the same count.

| Aspect | `shared_ptr` | Intrusive reference count |
|---|---|---|
| Allocations | One with `make_shared`, otherwise two | One object allocation |
| Handle size | Usually two pointers | One pointer |
| Weak observation | Built-in `weak_ptr` | No general built-in support |
| Count location | Separate control block | Inside object |
| Cache behavior | May touch another cache line | Count shares object's locality |
| Increment policy | Thread-safe RMW | Plain or thread-safe, by design |
| Adoption cost | Works with unmodified types | Type must provide count and retain/release |

The sketch uses a plain count and is therefore suitable only where all handle operations are confined to one thread. A production type can choose thread-safe increments when ownership crosses threads. That choice matters: `shared_ptr` cannot opt out of thread-safe count updates, even in a single-threaded pipeline.

Trading systems use intrusive handles because the object and count need one allocation, each handle is one word, and the count is often already hot with the object. Pool and arena allocation can remove the remaining per-object heap operation (Chapters 17–18).

**Pitfall.** Never mix intrusive handles with manual `delete`. The last `release()` is the sole destruction authority.

**Pitfall.** A base that performs `delete this` needs a virtual destructor when derived objects are owned through that base interface (Chapter 4).

## Smart Pointers on the Hot Path

Keep ownership at lifetime boundaries and use views while processing:

- Construct and connect owners during startup, configuration, and session setup.
- Store exclusive heap objects in `unique_ptr`.
- Pass `T&` or `T*` through the tick path.
- Share ownership only across a boundary whose completion order is genuinely unknown.
- Arrange pools and arenas outside the event loop when allocation cannot be avoided (Chapters 17–18).

A hot function that accepts `shared_ptr` by value creates ownership traffic even when it merely reads:

```cpp
#include <memory>

struct OrderBook {
    int best_bid() const noexcept { return 101; }
};

int price_bad(std::shared_ptr<const OrderBook> book) {
    return book->best_bid();
}  // count increment at call, decrement at return

int price_hot(const OrderBook& book) noexcept {
    return book.best_bid();
}  // no allocation and no reference-count operation

void on_tick(const std::shared_ptr<OrderBook>& owner) {
    (void)price_bad(owner);
    (void)price_hot(*owner);
}
```

`unique_ptr` has no reference count, and its default deletion normally inlines. As a by-value parameter it is nevertheless a non-trivially copyable class; common calling conventions pass such objects indirectly in memory rather than like a raw pointer in a register (Chapter 3). Take a view if transfer is not the operation.

A `shared_ptr` copy performs the thread-safe strong-count increment. Its destructor decrements and branches on last ownership. Under contention, updating that shared count moves its cache line between cores. A `weak_ptr::lock()` must conditionally acquire a strong reference, requiring a compare-and-swap-shaped atomic operation; Chapter 25 makes these costs precise.

An in-flight message shared with another subsystem may justify shared ownership because neither completion order controls the lifetime. Within each processing stage, functions should still borrow the message rather than copy its `shared_ptr`.

**Pitfall.** A `const std::shared_ptr<T>&` avoids a copy inside the callee but still advertises shared ownership at the interface. Prefer `const T&` unless the function examines, stores, or changes the ownership handle.

**Pitfall.** A `shared_ptr` makes its count safe to update from multiple threads. It does not make `*pointer` safe for concurrent mutation.

## Latency Lens

- A default `unique_ptr` is pointer-sized and its destructor normally inlines to manual deletion; by-value transfer can still use an indirect calling convention rather than a raw-pointer register.
- Every `shared_ptr` copy and destruction updates the control block with a thread-safe read-modify-write; contended across cores, that produces cache-line movement.
- `make_shared` combines object and bookkeeping allocation and improves locality, but the combined storage remains allocated until the last `weak_ptr` dies.
- A two-allocation `shared_ptr<T>(new T)` adds allocator work and separates object from count, potentially adding a cache miss during ownership operations.
- An aliasing `shared_ptr` to one small member keeps its entire owner and allocation alive.
- `weak_ptr::lock()` must test and conditionally increment the strong count, touching the shared control-block cache line.
- Intrusive counts permit one-word handles, one allocation, count locality, and plain increments in single-threaded stages.
- Build ownership at startup and pass `T&` or `T*` through preallocated hot-path objects to eliminate per-event refcount and allocator traffic.
