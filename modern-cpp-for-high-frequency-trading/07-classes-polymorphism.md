# Chapter 7 — Classes and Polymorphism

A class can make a latency-sensitive system easier to reason about, or it can hide construction, allocation, indirection, and lifetime work behind a harmless-looking expression. Polymorphism has the same double edge: it can separate stable interfaces from changing implementations, but different forms place their costs in different locations. This chapter establishes what C++ actually guarantees, shows the layouts commonly produced by current ABIs, and compares runtime dispatch, compile-time dispatch, variants, and type erasure using semantics, memory, latency, predictability, and verification.

## 7.1 Construction Order and Encapsulation

Construction follows declaration order, not the order written in a constructor's member-initializer list. Virtual bases are initialized first by the most-derived constructor, then direct bases, then non-static data members in declaration order, and finally the constructor body runs. Destruction reverses the completed construction order.

```cpp
#include <cstdint>

class Order {
    std::uint64_t id_;
    std::int64_t price_ticks_;
    std::uint32_t quantity_;

public:
    Order(std::uint32_t quantity, std::int64_t price, std::uint64_t id)
        // Actual order is id_, price_ticks_, quantity_.
        : quantity_{quantity}, price_ticks_{price}, id_{id} {}
};
```

The initializer list invites the reader to infer the wrong order. A compiler with `-Wall -Wextra -Wreorder` diagnoses it. Write initializers in declaration order even though changing their textual order cannot change the language rule.

The rule matters when one initializer refers to another member. In the following class, `end_` is initialized before `begin_`, so reading `begin_` has undefined behavior even though the initializer list looks sequential.

```cpp
// BROKEN
class Window {
    const char* end_;       // initialized first
    const char* begin_;     // initialized second

public:
    Window(const char* p, std::size_t n)
        : begin_{p}, end_{begin_ + n} {}
};
```

Reorder the declarations or compute both values only from constructor parameters. Encapsulation does not relax lifetime or initialization rules; private state can be invalid just as easily as public state.

A constructor establishes a class invariant: the conditions every public operation may rely on. For a bounded order, those might be a nonzero quantity and a price within configured limits. Validating once at construction can remove repeated checks from later operations, but only if mutation cannot violate the invariant. A setter that accepts arbitrary values gives the checks back.

Encapsulation also controls where work occurs. A value-like class with three integers normally embeds those integers directly and needs no allocation. A constructor that copies a `std::string`, builds a map, registers with a service, or locks a mutex performs much more work. None of that cost is visible at the call site:

```cpp
Order order{100, 12'345, 91};  // fixed work in this design
```

For hot-path types, make construction requirements visible in the type and keep invariants cheap to establish. If setup is expensive, separate a configuration or factory phase from the object used on the critical path. Verify assumptions with `sizeof(Order)`, compiler warnings, allocation instrumentation, and a profile of representative construction—not with the apparent simplicity of the syntax.

## 7.2 Delegating and Inheriting Constructors

A **delegating constructor** invokes another constructor of the same class. It centralizes invariant establishment and prevents nearly identical constructors from drifting apart.

```cpp
#include <cstdint>

class PriceBand {
    std::int64_t low_;
    std::int64_t high_;

public:
    PriceBand(std::int64_t low, std::int64_t high)
        : low_{low}, high_{high} {
        if (low > high) {
            throw "invalid price band"; // illustrative; Chapter 9 discusses errors
        }
    }

    explicit PriceBand(std::int64_t center)
        : PriceBand{center, center} {}
};
```

The delegated-to constructor initializes the complete object. The delegating constructor cannot also initialize members; its body begins only after the target constructor has returned. Delegation does not create a second object and, by itself, does not imply allocation.

An **inheriting constructor** makes selected base constructors candidates for constructing a derived class:

```cpp
struct ChannelConfig {
    ChannelConfig(int cpu, int queue) : cpu{cpu}, queue{queue} {}
    int cpu;
    int queue;
};

struct FeedConfig : ChannelConfig {
    using ChannelConfig::ChannelConfig;
    bool validate_sequence = true;
};
```

`FeedConfig{3, 1}` initializes `ChannelConfig` through the inherited constructor and default-initializes the added member. Constructor inheritance is concise, but it can expose combinations that do not establish the derived class's intended invariant. It also couples the derived interface to changes in the base constructor set. If `FeedConfig` requires additional validation or derived-specific arguments, define its constructors explicitly.

Both features primarily reduce source duplication. They do not promise faster code. Compilers commonly inline small constructor chains, but a nontrivial body, exception path, or separately compiled constructor may remain as a call. Inspect optimized output when constructor cost matters. More important, inspect what each constructor does: member initialization, validation, allocation, logging, and registration dominate the syntactic mechanism.

## 7.3 Explicit Construction, Conversion, and `explicit(bool)`

A single-argument constructor or conversion operator can define an implicit conversion unless it is `explicit`. Implicit conversions participate in overload resolution and can create temporaries, copy data, allocate, or select an unintended overload.

```cpp
#include <cstdint>

class Price {
public:
    explicit constexpr Price(std::int64_t ticks) : ticks_{ticks} {}
    explicit constexpr operator std::int64_t() const { return ticks_; }

private:
    std::int64_t ticks_;
};

void submit(Price price);

// submit(12500);       // rejected
submit(Price{12500});   // conversion is visible
```

Strong domain types prevent quantity, price, sequence number, and timestamp values from being interchanged merely because they share an integer representation. A small wrapper is normally optimized to the underlying integer when passed and returned, but that is an optimization result, not a license to ignore its semantics. Check calling-convention behavior in generated assembly for important interfaces.

C++20 added conditionally explicit constructors and conversion operators through `explicit(constant-expression)`. A wrapper can allow implicit conversion only when its wrapped type does:

```cpp
#include <concepts>
#include <utility>

template<class T>
class Box {
public:
    template<class U>
    explicit(!std::convertible_to<U, T>)
    Box(U&& value) : value_(std::forward<U>(value)) {}

private:
    T value_;
};
```

This is one declaration rather than two constrained overloads. Its condition is evaluated at compile time; it adds no runtime branch. It can, however, increase overload-resolution work and diagnostics complexity.

Conversion operators deserve the same scrutiny as constructors. `explicit operator bool` supports contextual Boolean use such as `if (result)` without enabling arbitrary integer arithmetic. Conversion to an owning string or container can allocate; conversion to a view can dangle. Name expensive or lifetime-sensitive transformations—`to_string()`, `copy_payload()`, or `view()`—rather than hiding them in an implicit operator.

To find hidden conversions, enable conversion warnings, temporarily mark suspect constructors `explicit`, and inspect allocation traces. A profile that attributes work to a copy constructor may be revealing an unintended conversion several frames higher.

## 7.4 Inheritance Forms and Object Layout

Inheritance defines an is-a relationship and a set of access rules. Public inheritance preserves the public interface of the base. Protected and private inheritance restrict that interface and are often implementation techniques rather than substitutability relationships. Multiple inheritance combines several bases. Virtual inheritance arranges for one shared virtual base in the most-derived object.

C++ specifies base-subobject behavior, construction order, access, and pointer conversions. It does not prescribe byte layout, vtable shape, or metadata placement. Under the Itanium C++ ABI used by GCC and Clang on many Unix-like targets, a simple polymorphic object commonly starts with a hidden virtual-table pointer, followed by base and member data with alignment padding. MSVC's ABI makes related but different choices.

Consider two independently useful interfaces:

```cpp
struct MarketDataSink {
    virtual void on_message(const char*, std::size_t) = 0;
    virtual ~MarketDataSink() = default;
};

struct HealthSource {
    virtual bool healthy() const noexcept = 0;
    virtual ~HealthSource() = default;
};

class FeedHandler final : public MarketDataSink, public HealthSource {
public:
    void on_message(const char*, std::size_t) override {}
    bool healthy() const noexcept override { return true; }
};
```

A common implementation gives `FeedHandler` enough metadata to dispatch through both base subobjects. That can mean multiple hidden pointers and adjustment thunks. Converting `FeedHandler*` to `HealthSource*` may change the numeric address so it points at the `HealthSource` subobject.

Virtual inheritance is more involved because the location of a shared virtual base can depend on the most-derived type. Access may require loading an offset from class metadata. Construction responsibility also moves to the most-derived constructor. Use virtual inheritance when the object model requires shared identity, not as a routine reuse tool.

Access control does not by itself alter representation. Changing public inheritance to private inheritance changes which conversions and members are accessible, but an implementation may choose the same layout. Empty bases can sometimes occupy no extra bytes under an empty-base optimization, while distinct base subobjects still have identity requirements. Section 5.4 explains the related `[[no_unique_address]]` facility. Verify the exact deployed class rather than extrapolating from a toy hierarchy.

Layout stability matters at binary boundaries. Adding a virtual member, changing base order, or inserting data can alter object size, offsets, vtable slots, and mangled interfaces under a particular ABI. The C++ standard offers no general stable class ABI. Separately built components must share compatible compiler, standard-library, flags, and interface-version assumptions, or communicate through a deliberately versioned boundary.

Object size affects cache density. If a book entry grows from 32 to 40 bytes because of metadata and padding, fewer entries fit in each cache line and page. Yet flattening every abstraction can grow code or duplicate state. Measure the complete structure with `sizeof`, `alignof`, and arrays of representative objects. Clang's `-Xclang -fdump-record-layouts` and GCC's class-dump facilities can show a compiler's chosen layout. Treat that output as evidence for a particular toolchain and ABI, not as portable C++ law.

## 7.5 Slicing and Virtual Destructors

**Slicing** occurs when a derived object is copied into a base object by value. Only the base subobject is copied; derived state and derived identity are absent from the result.

```cpp
struct Event {
    std::uint64_t sequence{};
};

struct Trade : Event {
    std::int64_t price_ticks{};
};

Trade trade{{42}, 12'500};
Event event = trade; // event contains only sequence
```

Slicing is well-defined, but it is often a design bug when the base is intended to be polymorphic. Avoid accepting a polymorphic base by value. Use a reference or pointer for non-owning access, or an explicit value-polymorphic wrapper when copying dynamic values is required.

Deleting a derived object through a base pointer requires a virtual base destructor unless a more specialized destruction protocol is used. Without it, behavior is undefined.

```cpp
struct Decoder {
    virtual void decode() = 0;
    virtual ~Decoder() = default; // required for delete through Decoder*
};
```

A virtual destructor can add polymorphic metadata to a class that otherwise had none. It also makes destruction a virtual call when the dynamic type is not known. If objects are never owned through the interface, an alternative is a protected nonvirtual destructor. That prevents ordinary `delete interface_ptr` while avoiding a virtual destruction contract:

```cpp
struct Observer {
    virtual void update() = 0;

protected:
    ~Observer() = default;
};
```

This design is appropriate only when ownership is controlled elsewhere. It is not a workaround for an unclear lifetime model.

Destructor latency includes member cleanup, not just dispatch. Destroying an object can free memory, close a file, unregister a callback, or release the last shared reference. If destruction occurs on a market-data thread, those operations join its tail-latency budget. Arrange ownership so expensive reclamation happens in a controlled phase or on an appropriate thread, while preserving correctness.

## 7.6 Base-Pointer Adjustment

A pointer to a base subobject need not have the same numeric value as a pointer to the complete object. C++ pointer conversion performs the required adjustment. The adjustment is commonly a compile-time constant for nonvirtual bases and may require metadata lookup for virtual bases.

```cpp
#include <cstdio>

struct A { virtual ~A() = default; };
struct B { virtual ~B() = default; };
struct D final : A, B {};

int main() {
    D object;
    D* d = &object;
    A* a = d;
    B* b = d;
    std::printf("%p %p %p\n", static_cast<void*>(d),
                static_cast<void*>(a), static_cast<void*>(b));
}
```

On a typical multiple-inheritance layout, `a` may equal `d` while `b` points farther into the object. The printed relationship is implementation-specific. The program must not infer portable offsets from it.

Adjustment also appears during dispatch. Calling an override through a secondary-base pointer may enter a small compiler-generated thunk that adjusts `this` before reaching the final function. Covariant return types can require return-pointer adjustment. These are usually a few instructions, but they add dependencies and can inhibit inlining when the dynamic target is unknown.

Pointer adjustment is why erasing an object as a bare `void*` and later applying an assumed offset is fragile. Store the correctly converted interface pointer, or store a type-specific function that knows how to recover and operate on the object. The compiler's conversion embodies ABI knowledge that application code should not duplicate.

Use `-O2 -S`, `objdump -drC`, or Compiler Explorer to locate adjustment instructions and thunks. Then assess them in context. A cache miss caused by dispersed object allocation usually matters more than one address addition; an indirect call in a tight mixed-type loop may matter more than either.

## 7.7 Virtual Functions, Vtables, and Vptrs

A virtual call selects the final overrider according to an object's dynamic type. That semantic guarantee does not require a vtable. A common implementation stores a hidden **vptr** in each polymorphic subobject; it points to a **vtable** containing function addresses and ABI metadata.

Schematic common implementation:

```text
object                         class metadata
+-------------------+         +------------------------+
| vptr -------------+-------->| offset/type metadata   |
| member data       |         | &Handler::on_message   |
+-------------------+         | &Handler::~Handler     |
                              +------------------------+
```

A virtual call then resembles this pseudocode:

```cpp
// POSSIBLE IMPLEMENTATION, not source-level C++
auto table = object->hidden_vptr;
auto target = table->on_message_slot;
target(object, data, size);
```

The path loads the vptr, loads a function address, and performs an indirect branch. If objects are cold, the first load can miss in cache. If calls alternate unpredictably among many types, the indirect-branch predictor can miss. Because the target is not statically known, the compiler may be unable to inline it, losing constant propagation and cross-call optimization.

None of these outcomes is inevitable. A monomorphic call site repeatedly seeing one type is often predicted well. Whole-program analysis may prove the target and replace the virtual call. The relevant comparison is not “virtual call versus one instruction”; it is the complete implementation with its layout, allocation pattern, call-site type distribution, and optimization boundary.

Virtual interfaces can improve binary boundaries and reduce template duplication. A non-template implementation compiled once may occupy less instruction cache than many specialized instantiations. They also permit independent implementation changes when an ABI is maintained carefully.

Dispatch and ownership are independent choices. A `Decoder&` performs virtual dispatch without owning anything. A `std::unique_ptr<Decoder>` adds ownership but normally no reference count. A `std::shared_ptr<Decoder>` adds a control block and atomic ownership traffic in common implementations. Benchmarking “virtual objects” created afresh on every iteration mostly benchmarks allocation and reclamation. Construct the object graph outside the measured region unless construction is the operation under study.

Data placement can also turn one nominal call into several cache misses. An array of owning pointers places the pointers contiguously but usually leaves pointed-to objects wherever the allocator put them. A pool can group equal-sized concrete objects, improving locality without changing dispatch semantics. Conversely, copying all objects into a compact variant array may enlarge every slot to the largest alternative. The call mechanism and storage strategy must be chosen together.

Verify a suspected dispatch cost by first inspecting optimized assembly. Then benchmark realistic type sequences and object placement. Record branches and branch misses with, for example:

```sh
perf stat -e cycles,instructions,branches,branch-misses,cache-misses ./dispatch_bench
```

Counters are evidence about that benchmark on that machine. They do not establish a universal cost for virtual functions.

## 7.8 Devirtualization and `final`

**Devirtualization** replaces a virtual dispatch with a direct call when the compiler proves the dynamic target. Once direct, the call may be inlined and optimized with its caller.

```cpp
struct RiskCheck {
    virtual bool allow(std::int64_t price, int quantity) const = 0;
    virtual ~RiskCheck() = default;
};

class Limits final : public RiskCheck {
public:
    bool allow(std::int64_t price, int quantity) const override {
        return quantity > 0 && price <= max_price_;
    }
private:
    std::int64_t max_price_ = 100'000;
};

bool submit(const Limits& limits, std::int64_t price, int quantity) {
    return limits.allow(price, quantity); // exact dynamic type is evident
}
```

The static type at this call site is `Limits`, so a compiler can call `Limits::allow` directly. `final` on a class states that no class can derive from it. `final` on a virtual member states that later overrides are forbidden. Both can strengthen devirtualization proofs, especially when the compiler sees only part of the hierarchy.

Link-time optimization can devirtualize across translation units. Profile-guided optimization can enable guarded devirtualization: test for a common target, take an inlined fast path, and retain a virtual fallback. The guard adds a branch, so its value depends on the observed type distribution and on profile representativeness.

Do not mark a class `final` merely as a performance ritual. It changes the extension contract. Use it when the design is closed, then let optimization benefit. Likewise, moving a small virtual member definition into a header may improve visibility but increases coupling and recompilation.

Clang's optimization records (`-fsave-optimization-record`) and GCC's optimization reports can explain whether devirtualization occurred. Assembly provides the final check: a direct `call`, inlined operations, or an indirect `call *...` reveal different outcomes.

## 7.9 RTTI, `dynamic_cast`, and `typeid`

Run-time type information, or **RTTI**, represents dynamic type identity for polymorphic classes. `dynamic_cast` performs checked conversions, while `typeid` obtains a `std::type_info` describing an expression's type under specified rules.

Downcasting a base pointer is checked and returns null on failure. Downcasting a reference throws `std::bad_cast` on failure. Cross-casting between base subobjects is also supported.

```cpp
void inspect(MarketDataSink* sink) {
    if (auto* health = dynamic_cast<HealthSource*>(sink)) {
        (void)health->healthy();
    }
}
```

The standard specifies the result, not the search algorithm. A common ABI consults type metadata associated with the virtual table and may traverse hierarchy information. Cost depends on hierarchy shape, cast direction, success, and cache state. It should not be assumed constant merely because the syntax is a single expression.

For a polymorphic glvalue, `typeid(expression)` reports the dynamic type. For a pointer expression it reports the pointer's static type unless the pointer is dereferenced. Applying `typeid(*p)` to a null pointer to polymorphic type throws `std::bad_typeid`.

Repeated `dynamic_cast` in a per-message loop often signals that the interface lacks an operation or that the representation should make alternatives explicit. A `std::variant` may suit a closed set of message types; a virtual function may suit an open set. At plugin or diagnostic boundaries, RTTI can still be the correct and simplest tool.

Disabling RTTI with compiler flags changes available language facilities and may conflict with libraries. It also does not remove virtual dispatch itself. Make that build decision at the system boundary, not as a local micro-optimization. Verify RTTI footprint with symbol and section tools such as `nm -C` and `size`, and benchmark actual casts if they remain on a critical path.

## 7.10 Templates, Concepts, CRTP, and Static Dispatch

**Static polymorphism** selects behavior during compilation. Templates express operations over types, concepts constrain acceptable types, and the curiously recurring template pattern (CRTP) lets a base template refer to a derived type.

```cpp
#include <concepts>
#include <cstddef>

template<class T>
concept MessageHandler = requires(T handler, const char* data, std::size_t size) {
    { handler.on_message(data, size) } noexcept -> std::same_as<void>;
};

template<MessageHandler Handler>
void drain(Handler& handler, const char* data, std::size_t size) noexcept {
    handler.on_message(data, size);
}
```

For each used `Handler`, the compiler forms a specialization. The target is known, so inlining and constant propagation are possible. The concept checks the interface at compile time and usually introduces no runtime representation.

CRTP is useful when shared base operations need to call derived behavior without a virtual function:

```cpp
template<class Derived>
class Sequenced {
public:
    void accept(std::uint64_t sequence) {
        static_cast<Derived&>(*this).on_sequence(sequence);
    }
};

class Feed final : public Sequenced<Feed> {
public:
    void on_sequence(std::uint64_t sequence) { last_ = sequence; }
private:
    std::uint64_t last_{};
};
```

CRTP does not dynamically verify that `Derived` is the most-derived object. Misuse can produce confusing diagnostics or unsafe casts. A concept can document required operations, but ordinary free-function templates are often simpler than a CRTP hierarchy.

Static dispatch trades runtime flexibility for compile-time knowledge. It can remove indirect branches and enable specialization. It can also instantiate the same algorithm for many types, increasing compile time, compiler memory, executable size, and instruction-cache pressure. Chapter 8 develops these costs in detail.

A concept checks expressions, not intent. The `MessageHandler` concept proves that a syntactically suitable non-throwing member exists and returns `void`. It cannot prove that the handler consumes the buffer before it becomes invalid, validates message lengths, or completes in bounded time. Those requirements belong in interface documentation, construction invariants, and tests. Static typing is one layer of correctness, not a latency contract.

Templates also propagate concrete types through an architecture. If a session type contains its decoder, risk policy, and transport as template parameters, every combination is a different type. That can be useful for a small fixed product matrix. For hundreds of configurations it can create a combinatorial build and test surface. Erase one boundary where variation no longer enables optimization, or store runtime policy data inside a smaller number of compiled strategies.

Choose static polymorphism when the type set is naturally known at compilation and specialization adds value. It is awkward across stable binary plugin interfaces or when implementations are selected after deployment. In those settings, a narrow runtime boundary around larger statically optimized components is often effective.

## 7.11 `std::variant` Storage and Visitation

`std::variant<Ts...>` stores exactly one alternative from a closed type set. Its object contains storage large and aligned enough for the largest alternative plus a discriminator that identifies the active one, with implementation-dependent padding.

```cpp
#include <cstdint>
#include <variant>

struct AddOrder { std::uint64_t id; std::int64_t price; };
struct CancelOrder { std::uint64_t id; };
using Message = std::variant<AddOrder, CancelOrder>;

std::uint64_t order_id(const Message& message) {
    return std::visit([](const auto& value) { return value.id; }, message);
}
```

The payload is inline; constructing the variant does not inherently allocate. Its size can surprise: one rare large alternative enlarges every element in a `std::vector<Message>`. A separate out-of-line representation may save cache space at the cost of allocation or indirection.

Visitation dispatches using the discriminator. An implementation may generate a jump table, comparisons, or another scheme. With a small alternative set and an inlinable visitor, the generated code can be compact and expose each case to optimization. With many variants and overloaded visitors, instantiation count can grow combinatorially.

A variant can become `valueless_by_exception` if changing alternatives fails in circumstances specified by the operation and types involved. `std::visit` then throws `std::bad_variant_access`. For a non-throwing hot-path design, use alternatives with non-throwing moves and establish an explicit error policy.

Variants suit protocol messages and states whose alternatives are closed and centrally known. Adding an alternative forces visitors to be reconsidered and can trigger broad recompilation. That is often an advantage for exhaustive correctness, but it is not an extensible plugin mechanism.

Measure `sizeof(Message)`, inspect the generated visitation path, and test realistic discriminator distributions. A predictable run of one message kind behaves differently from uniformly mixed alternatives. Compare complete designs, including allocation and cache density, rather than just dispatch instructions.

## 7.12 `std::any` and General Type Erasure

`std::any` owns one copyable value of almost any type and exposes it through checked `any_cast`. It performs general type erasure: the static type disappears behind a uniform holder, while implementation-specific metadata retains destruction, copying, movement, and type identity operations.

```cpp
#include <any>
#include <cstdint>

std::any value = std::uint64_t{42};
if (auto* sequence = std::any_cast<std::uint64_t>(&value)) {
    ++*sequence;
}
```

An empty `any` owns nothing. An `any` with a value may use implementation-dependent inline storage for a sufficiently small, suitably movable type; otherwise it allocates. The standard does not specify the inline-buffer size or require such an optimization. Copying can copy the contained value and may allocate. Pointer-form `any_cast` returns null on mismatch; value/reference forms can throw `std::bad_any_cast`.

Unlike `std::variant`, `any` has no closed list and no built-in exhaustive visitation. The consumer must know what type to request or maintain another dispatch mechanism. That flexibility is useful for configuration, extension metadata, and control-plane values. It is usually undesirable in a fixed-format packet loop because type checks, indirect management operations, possible allocation, and failure policy are hidden.

General type erasure can preserve value semantics without exposing implementation types, but the erased contract should be narrower than “anything” when performance matters. A purpose-built wrapper can expose `decode`, `size`, or `invoke` directly and can specify capacity and non-allocating requirements. Section 7.13 builds that spectrum.

Verify library behavior rather than assuming it. Instrument `operator new`, test copy and move paths, print `sizeof(std::any)`, and inspect standard-library sources for the deployed version. An implementation change can shift which types fit inline without changing source compatibility.

## 7.13 Virtual Interfaces, Function Tables, and Small-Buffer Erasure

Type erasure separates an interface from the concrete type implementing it. A virtual base class is one form. A manually assembled function table plus an object pointer is another. A value-like wrapper can additionally own the erased object in an inline buffer.

A minimal non-owning erased handler can contain two machine-word-sized fields on common targets:

```cpp
#include <cstddef>

class HandlerRef {
public:
    template<class T>
    explicit HandlerRef(T& object) noexcept
        : object_{&object},
          call_{[](void* p, const char* data, std::size_t size) noexcept {
              static_cast<T*>(p)->on_message(data, size);
          }} {}

    void on_message(const char* data, std::size_t size) const noexcept {
        call_(object_, data, size);
    }

private:
    void* object_;
    void (*call_)(void*, const char*, std::size_t) noexcept;
};
```

`HandlerRef` does not own the object. Its lifetime must not exceed the referred object. The templated constructor creates a type-specific adapter, and calls use one function-pointer indirection. There is no required allocation. Unlike a base-class pointer, it can refer to a type that did not opt into a hierarchy.

An owning erased wrapper must also store operations for destruction and movement, and for copying if it promises copyability. A **small-buffer optimization** embeds storage in the wrapper for objects satisfying size, alignment, and move requirements. Larger objects need heap storage or must be rejected.

```text
owning erased value
+----------------------+
| operation table ptr  |
| state/discriminator  |
| inline bytes ...     |  <- object here, or a heap pointer
+----------------------+
```

Buffer size is a system choice. A larger buffer avoids more allocations but enlarges every wrapper, consumes cache capacity, and increases copy traffic. A fixed-capacity wrapper that rejects oversized types provides more predictable behavior than silently allocating. C++23 `std::move_only_function` is a standardized callable-erasure facility, discussed in Section 6.14; its allocation and inline-storage details remain implementation-dependent.

The operation table for a move-only wrapper commonly needs functions equivalent to these:

```cpp
// POSSIBLE IMPLEMENTATION
struct Operations {
    void (*invoke)(void*, const char*, std::size_t) noexcept;
    void (*move_construct)(void* destination, void* source) noexcept;
    void (*destroy)(void*) noexcept;
};
```

If the wrapper is copyable, it also needs a copy operation and a policy for copy failure. The implementation must construct objects with correct alignment, begin and end lifetimes correctly, destroy exactly the active object, and leave a moved-from wrapper destructible. Merely copying the inline bytes is invalid for a non-trivially copyable target. These requirements make a home-grown wrapper a small container implementation, not just a clever function pointer.

An erased reference has a different failure mode: lifetime. It should usually be non-null by construction, non-owning in its name or documentation, and cheap to copy. If an empty state is necessary, every call needs either a branch, a precondition, or defined termination behavior. Pick one; do not leave the state accidental.

Virtual interfaces offer language-supported inheritance and familiar ownership patterns. Manual function tables can adapt unrelated types and control representation. Small-buffer values offer value semantics but require careful lifetime, exception, alignment, and move design. Test every representation boundary: empty state, moved-from state, over-aligned objects, throwing constructors, and capacity overflow.

## 7.14 C++23 Explicit Object Parameters

C++23 permits a non-static member-like function to declare its object parameter explicitly. The feature is often called **deducing `this`**, though the parameter is written as an ordinary first parameter rather than using the keyword `this`.

```cpp
#include <utility>

struct Quote {
    long bid_ticks;
    long ask_ticks;

    template<class Self>
    decltype(auto) bid(this Self&& self) noexcept {
        return std::forward<Self>(self).bid_ticks;
    }
};
```

One template can preserve the constness and value category of the object instead of spelling four overloads for `&`, `const&`, `&&`, and `const&&`. It is also useful in CRTP-like mixins because the deduced object type can be the derived type.

Preserving value category also preserves its hazards. Calling `Quote{...}.bid()` returns an rvalue reference to a member of a temporary in this example; keeping that reference past the full expression would dangle. If an accessor should always return a value, declare that return policy explicitly rather than forwarding mechanically. Less duplicated code is not a substitute for a deliberate lifetime contract.

An explicit-object member function has restrictions: it is not virtual, has no implicit `this`, and accesses members through the named object parameter. Its address behaves like a pointer to an ordinary function rather than a traditional pointer-to-member function. These differences affect adapters and overload sets.

The feature can reduce source duplication, but each distinct deduced `Self` may instantiate a specialization. A broadly used accessor can therefore add compile work and code variants, although trivial bodies are commonly inlined and merged. If forwarding the value category is not semantically needed, a conventional `const` member can be clearer and produce fewer instantiations.

Compiler and standard-library support for C++23 features has arrived incrementally. Check the feature-test macro `__cpp_explicit_this_parameter` and the exact GCC or Clang version used by the project. Keep a conventional-overload fallback when the deployed toolchain does not support the syntax.

## 7.15 Static Call, Subscript, and Multidimensional Subscript Operators

C++23 allows `operator()` and `operator[]` to be declared `static`, and permits `operator[]` to accept multiple arguments. These changes can express stateless policies and multidimensional indexing without an implicit object parameter.

```cpp
#include <cstddef>
#include <span>

struct RowMajorIndex {
    static constexpr std::size_t operator()(std::size_t row,
                                             std::size_t column,
                                             std::size_t width) noexcept {
        return row * width + column;
    }
};

class PriceGrid {
public:
    PriceGrid(std::span<long> values, std::size_t columns)
        : values_{values}, columns_{columns} {}

    long& operator[](std::size_t row, std::size_t column) noexcept {
        return values_[row * columns_ + column];
    }

private:
    std::span<long> values_;
    std::size_t columns_;
};
```

The static call operator can be invoked through an object-like expression in generic code while making clear that no object state is used. This may simplify callable representation: an empty stateless policy need not supply an implicit object address to its body. The optimizer could already remove that overhead for an ordinary empty functor, so the feature is chiefly a semantic and interface improvement, not a guaranteed speedup.

Multidimensional subscript syntax avoids nested proxy objects that libraries historically used to support `grid[row][column]`. A direct `grid[row, column]` call can compute one offset and return a reference. It performs no bounds checking unless the implementation adds checks. Overflow in `row * columns_` and out-of-range access remain correctness hazards; a checked control-plane API and an invariant-protected hot API can separate policies explicitly.

`std::mdspan`, covered in Section 11.5, generalizes non-owning multidimensional access with mapping and accessor policies. Use a custom operator when the domain type needs stronger invariants or a smaller interface.

As with explicit object parameters, confirm C++23 compiler support. Compile representative generic uses, because parser support alone does not guarantee that every library adapter recognizes the newer callable form.

## 7.16 Allocation, Indirection, Code Size, and Cache Tradeoffs

No polymorphism mechanism minimizes every cost. The useful question is where each design stores type information and when it pays for flexibility.

| Mechanism | Type set | Typical object cost | Dispatch | Main predictability risk |
|---|---|---|---|---|
| Virtual interface | Open | vptr per polymorphic subobject; ownership separate | Indirect call unless devirtualized | Allocation pattern and target variation |
| Function-table reference | Open | Object pointer plus operation pointer/table | Indirect call | Dangling non-owning object |
| Small-buffer erasure | Open within capacity | Table/state plus fixed inline buffer | Indirect call | Oversize policy or fallback allocation |
| Template/concept | Closed at build time | Usually no dispatch metadata | Direct/inlinable | Code duplication and rebuild cost |
| `std::variant` | Closed in source | Largest alternative plus discriminator | Discriminator-based branch/table | Large footprint and alternative distribution |
| `std::any` | Open | Holder metadata; possible inline payload | Type check plus erased management | Allocation and bad-cast path |

Object layout and executable layout interact. Replacing a virtual call with a template can eliminate an indirect branch and reveal constants, yet duplicating a large handler for twenty message types may evict other hot code from the instruction cache. Replacing a variant with pointers can shrink each queue slot, yet scatter payloads across the heap and add data-cache and TLB misses.

Consider a gateway supporting three wire protocols and four risk policies. A fully templated pipeline can produce twelve specialized loops. If protocol decoding dominates and risk checks are nearly identical, specializing both axes repeats too much code. A hybrid can specialize the three decoders while passing each decoded order to one compact risk function. Another hybrid chooses one of twelve function pointers at startup, then calls a stable target in the event loop. The dynamic choice occurs once; the steady-state branch predictor sees one target.

Binary boundaries add another constraint. Exporting C++ class templates or standard-library types across separately deployed shared objects couples both sides to compiler and library ABI details. A narrow C-compatible table or a versioned abstract interface can make plugin deployment safer, even if the implementation behind that boundary is heavily templated. The boundary's indirect call may be negligible when each call performs meaningful parsing, validation, or I/O.

Tail behavior matters more than an isolated median call. Hidden allocation, first-touch page faults, exception paths, branch-target variation, cache-line contention, and reclamation can dominate. Fix capacities and ownership where possible. Partition cold control-plane extensibility from hot data-plane operations. A common design uses runtime selection once during startup, then stores a stable function pointer or invokes a statically specialized loop for the session.

Concurrency can change the comparison again. Immutable operation tables and vtables are naturally shared, but the objects they reference may contain mutable counters or state that causes cache-line contention. A compact variant moved through a single-producer/single-consumer queue transfers the whole payload and can avoid shared ownership, but large slots increase copying and ring footprint. A pointer queue transfers one word but requires a reclamation protocol and sends the consumer to another memory location. Dispatch benchmarks that omit the handoff miss these system costs.

Evaluate candidates with the same workload and semantics:

1. Record `sizeof`, alignment, allocation count, and number of live objects.
2. Inspect optimized assembly for indirect calls, duplicated bodies, and inlining.
3. Measure cycles, instructions, branches, branch misses, cache misses, and code size.
4. Vary type distribution, object placement, working-set size, and error paths.
5. Include build time and binary deployment constraints in the decision.

The abstraction is not free merely because the benchmark cannot isolate its call instruction. Nor is it expensive merely because it uses a virtual function. The complete data flow decides.

## 7.17 Interview Check

1. State the construction order for virtual bases, direct bases, members, and the constructor body. Why can an out-of-order initializer list conceal undefined behavior?
2. Compare a delegating constructor with an inherited constructor. Which one establishes the complete object's invariants, and when can constructor inheritance expose an invalid interface?
3. Explain how an unintended implicit conversion can add hidden latency. What API changes and tools would reveal it?
4. Why may converting a derived pointer to a secondary-base pointer change its numeric address? Distinguish the C++ guarantee from a common ABI implementation.
5. What goes wrong when a derived object is deleted through a base pointer without a virtual destructor? When is a protected nonvirtual destructor appropriate?
6. Given a mixed stream of polymorphic objects, describe the loads and branch commonly involved in a virtual call and the conditions under which a compiler can devirtualize it.
7. Compare virtual dispatch, a template, `std::variant`, and a small-buffer erased wrapper for a market-data decoder whose implementation set is either closed or loaded as plugins.
8. Why can `std::variant` avoid allocation yet still have a poor cache footprint? What measurements would establish whether visitation is a bottleneck?
9. Design a fixed-capacity type-erased callable that never allocates. What must its contract say about size, alignment, movement, destruction, and overflow?
10. Explain the source-code benefit and possible instantiation cost of a C++23 explicit object parameter. How would you support a compiler that lacks the feature?
