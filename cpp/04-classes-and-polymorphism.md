# 4. Classes and Polymorphism

A C++ class can be a compact value, an invariant boundary, or one participant in a runtime-polymorphic hierarchy. Those roles have different layout, lifetime, and dispatch costs. Good designs choose the role explicitly instead of importing reference semantics and inheritance habits from another language.

## Classes for Java and Python refugees

The first difference is physical: a C++ variable of class type normally contains the object itself.

| Concept | Java/Python | C++ |
|---|---|---|
| What a variable holds | object reference | value, pointer, or reference as declared |
| Universal base class | `Object` / `object` | none |
| Destruction | garbage collection; finalization nondeterministic | deterministic at scope exit |
| Methods virtual by default | Java: mostly; Python: dynamic | no |
| `class` versus `struct` | different constructs or no direct match | default access only |
| Equality | `.equals` / `__eq__` | define `operator==` |

Both `class` and `struct` define types. An **object** is an instance of a type with storage: in `Order order{...};`, `order` is the object, not a reference to an object somewhere else.

```cpp
#include <cstdint>
#include <iostream>
#include <string>

class Order {
public:
    Order(std::string symbol, std::int64_t quantity)
        : symbol_{symbol}, quantity_{quantity} {}

    void add_quantity(std::int64_t delta) {
        this->quantity_ += delta;  // this is an Order*
    }

    const std::string& symbol() const {
        return symbol_;
    }

    std::int64_t quantity() const;

private:
    std::string symbol_;
    std::int64_t quantity_;
};

std::int64_t Order::quantity() const {
    return quantity_;
}

int main() {
    Order order{"EURUSD", 200};
    order.add_quantity(50);

    const Order& snapshot = order;
    std::cout << snapshot.symbol() << ' '
              << snapshot.quantity() << '\n';  // prints: EURUSD 250
    // snapshot.add_quantity(10);  // error: non-const member on const object
}
```

A member function belongs to the class's scope and receives an implicit pointer named `this`. `this` is a pointer rather than a reference; write it explicitly only when disambiguation helps.

The trailing `const` on `symbol()` and `quantity()` qualifies the object observed through `this`. Such a **const member function** can be called through a `const Order&` and cannot modify ordinary data members. A non-const member function requires a non-const object.

`Order::quantity` is the out-of-class definition syntax. The `Order::` scope qualifier says which class owns the function.

`class` members are private by default; `struct` members are public by default. Otherwise the constructs have the same capabilities. Convention uses a `struct` for passive data whose fields are independently valid and a `class` when operations must preserve an invariant.

```cpp
struct TopOfBook {
    std::int64_t bid_ticks;
    std::int64_t ask_ticks;
};
```

There is no benefit in hiding these two independent fields behind mechanical getters and setters. If a pair of fields must obey `bid_ticks <= ask_ticks`, however, a class can enforce that relationship.

Assignment and parameter passing follow the declared form rather than a universal reference model:

```cpp
void adjust_copy(Order order) {
    order.add_quantity(10);
}

void adjust_original(Order& order) {
    order.add_quantity(10);
}

void value_semantics_demo() {
    Order order{"EURUSD", 100};
    adjust_copy(order);
    std::cout << order.quantity() << '\n';  // prints: 100
    adjust_original(order);
    std::cout << order.quantity() << '\n';  // prints: 110
}
```

The first parameter is a separate `Order` value. The second is an alias to the caller's object. C++ makes that choice visible in the type instead of making every class variable reference-like.

## Invariants and access control

An **invariant** is a condition that holds after construction and after every public operation. Encapsulation puts all state-changing paths behind one boundary, making illegal states unrepresentable outside that boundary.

Prices remain integer ticks, continuing Chapter 2's rule against floating-point order prices:

```cpp
class Price {
public:
    explicit Price(std::int64_t ticks) : ticks_{ticks} {
        if (ticks < 0) {
            std::terminate();
        }
    }

    std::int64_t ticks() const {
        return ticks_;
    }

    friend Price operator+(Price lhs, Price rhs) {
        if (rhs.ticks_ > INT64_MAX - lhs.ticks_) {
            std::terminate();
        }
        return Price{lhs.ticks_ + rhs.ticks_};
    }

    friend bool operator==(Price, Price) = default;

    friend std::ostream& operator<<(std::ostream& output, Price price) {
        return output << price.ticks_;
    }

private:
    std::int64_t ticks_;
};
```

Every constructed `Price` is nonnegative. Addition checks both the domain rule and signed overflow before constructing the result, so callers never need a second validation pass.

The access labels have distinct roles:

- `public` names form the interface available to every caller.
- `private` names are accessible to the class and its friends.
- `protected` names are also accessible to derived classes; inheritance uses this sparingly.
- A `friend` declaration grants selected non-member code access to private state.

The two hidden-friend operators are found through argument-dependent lookup from Chapter 3. `friend` does not make them member functions; it gives these particular functions the access needed to implement the type's natural operations.

The constructor terminates on failure only to keep this chapter independent of error-handling machinery. Chapter 6 replaces that policy with exceptions or returned error values where appropriate.

**Pitfall.** Public fields plus “remember to validate” make the invariant the responsibility of every caller. One unchecked assignment invalidates assumptions everywhere downstream.

Avoid reflexive getter/setter pairs. If every private field has an unrestricted setter, the type is a public `struct` wearing access labels without enforcing anything.

## Constructors, destructors, and member initializer lists

A constructor establishes an object's initial invariant. A destructor, written `~Type()`, is the deterministic teardown hook: it runs when an automatic object leaves scope.

Objects constructed in the same scope are destroyed in reverse construction order:

```cpp
class Trace {
public:
    explicit Trace(const char* name) : name_{name} {
        std::cout << "ctor " << name_ << '\n';
    }

    ~Trace() {
        std::cout << "dtor " << name_ << '\n';
    }

private:
    const char* name_;
};

void order_demo() {
    Trace first{"A"};   // prints: ctor A
    Trace second{"B"};  // prints: ctor B
}                      // prints: dtor B, then dtor A
```

Members follow the same stack-like rule. They are initialized in declaration order and destroyed in reverse declaration order. The containing destructor body runs before its members are destroyed.

A **member initializer list** appears between the constructor signature and body. It initializes members directly:

```cpp
class InitializedOrder {
public:
    InitializedOrder(const std::string& symbol, std::int64_t quantity)
        : symbol_{symbol}, quantity_{quantity} {}

private:
    std::string symbol_;
    std::int64_t quantity_;
};

class AssignedOrder {
public:
    AssignedOrder(const std::string& symbol, std::int64_t quantity) {
        symbol_ = symbol;
        quantity_ = quantity;
    }

private:
    std::string symbol_;
    std::int64_t quantity_{};
};
```

`InitializedOrder` constructs `symbol_` from `symbol`. `AssignedOrder` first constructs an empty `std::string`, then assigns to it. The second form performs extra work and cannot be used for `const` or reference members, which must be bound during initialization.

The written order of the initializer list does not control initialization:

```cpp
class BrokenOrder {
public:
    explicit BrokenOrder(std::int64_t quantity)
        : quantity_{quantity}, doubled_{quantity_ * 2} {}
        // warning: -Wreorder; doubled_ initializes before quantity_

private:
    std::int64_t doubled_;
    std::int64_t quantity_;
};
```

`doubled_` is declared first, so its initializer reads `quantity_` before `quantity_` is initialized. That read has undefined behavior. Declare members in dependency order and write the initializer list in that same order.

Declaring any constructor prevents the compiler from implicitly declaring a default constructor. If a type with `Price(std::int64_t)` also needs `Price{}`, that default behavior must be declared deliberately and must choose a valid price.

**Rule.** Member declaration order is construction order. Treat `-Wreorder` as a correctness warning, not a formatting complaint.

## Special member functions and the rules

C++ recognizes six operations as **special member functions**:

| Operation | Signature shape | Purpose |
|---|---|---|
| default constructor | `T()` | construct without arguments |
| destructor | `~T()` | deterministic cleanup |
| copy constructor | `T(const T&)` | create from another object |
| copy assignment | `T& operator=(const T&)` | replace from another object |
| move constructor | `T(T&&)` | cheap ownership transfer |
| move assignment | `T& operator=(T&&)` | replace by ownership transfer |

Chapter 7 explains move operations and their implementations. Here the important question is whether an operation exists.

The compiler's declarations depend on what the class declares itself. In this table, “other constructor” excludes copy and move constructors; “implicit” means compiler-declared, and “user” means the row's declaration.

| User declares | Default ctor | Copy ctor | Copy assign | Move ctor | Move assign | Destructor |
|---|---|---|---|---|---|---|
| nothing | implicit | implicit | implicit | implicit | implicit | implicit |
| other constructor | no | implicit | implicit | implicit | implicit | implicit |
| destructor | implicit | deprecated | deprecated | no | no | user |
| copy constructor | no | user | deprecated | no | no | implicit |
| copy assignment | implicit | deprecated | user | no | no | implicit |
| move constructor | no | deleted | deleted | user | no | implicit |
| move assignment | implicit | deleted | deleted | no | user | implicit |

“Deprecated” means the copy operation is still implicitly generated, but relying on that generation is deprecated because another resource-sensitive operation was declared. “Deleted” means overload resolution can find the implicit function, but calling it is a compile error.

A user declaration includes `= default` and `= delete`. Declaring a destructor as `~T() = default` therefore still suppresses implicit moves.

Two consequences are worth memorizing:

- A custom ordinary constructor removes only the implicit default constructor; it does not suppress copy or move operations.
- A declared copy operation suppresses both implicit moves, while a declared move operation causes the implicit copies to be deleted.
- A declared destructor leaves legacy implicit copies available but deprecated and prevents implicit moves.

The matrix describes declarations, not whether member-wise generation eventually succeeds. If a member cannot be copied, an implicitly declared copy operation can itself be defined as deleted when used.

The **rule of zero** is the preferred design: if members manage their own behavior, declare none of the copy, move, or destruction operations.

```cpp
class Order {
public:
    Order(std::string symbol, Price price, std::int64_t quantity)
        : symbol_{symbol}, price_{price}, quantity_{quantity} {}

private:
    std::string symbol_;
    Price price_;
    std::int64_t quantity_;
};
```

`std::string` and `Price` already know how to copy, move, and destroy themselves. The compiler-generated `Order` operations apply the corresponding operation to each member.

The **rule of three** says that a class needing a custom destructor, copy constructor, or copy assignment probably needs all three. The **rule of five** adds the two move operations. Declare, default, or delete the whole resource-management set so a later reader does not have to reconstruct the suppression matrix; Chapter 7 supplies correct move implementations.

`= default` requests the compiler's normal implementation explicitly. It can preserve properties that a hand-written no-op body loses; Chapter 16 makes triviality precise.

`= delete` says an operation must not exist:

```cpp
class ConnectionHandle {
public:
    explicit ConnectionHandle(int descriptor)
        : descriptor_{descriptor} {}

    ConnectionHandle(const ConnectionHandle&) = delete;
    ConnectionHandle& operator=(const ConnectionHandle&) = delete;

private:
    int descriptor_;
};

void copy_connection(const ConnectionHandle& connection) {
    // ConnectionHandle copy{connection};  // error: deleted copy constructor
    (void)connection;
}
```

The parameter remains valid because binding a reference does not copy. The same technique can delete one overload while leaving another available:

```cpp
void set_quantity(std::int64_t quantity) {
    std::cout << quantity << '\n';
}

void set_quantity(double) = delete;

void deleted_overload_demo() {
    set_quantity(std::int64_t{250});  // prints: 250
    // set_quantity(250.5);  // error: call to deleted overload
}
```

Deleted functions still participate in overload resolution. The `double` call selects the exact deleted match and fails instead of silently converting to `std::int64_t`.

**Pitfall.** Adding a logging destructor suppresses both implicit move operations, even when every member is movable. A container can then copy elements during relocation; Chapter 7 shows the resulting performance cliff.

## Converting and explicit constructors

A constructor callable with one argument defines a user-defined conversion unless it is marked `explicit`. That conversion participates in overload resolution from Chapter 3.

```cpp
class Order {
public:
    Order(std::int64_t quantity) : quantity_{quantity} {}

    std::int64_t quantity() const {
        return quantity_;
    }

private:
    std::int64_t quantity_;
};

void submit(Order order) {
    std::cout << order.quantity() << '\n';
}

void accidental_conversion() {
    submit(42);  // prints: 42; constructs an Order implicitly
}
```

The call has no exact `submit(int)` overload, so overload resolution applies the converting constructor and calls `submit(Order)`. The source looks like it submits an integer.

Mark the constructor `explicit` to require visible construction:

```cpp
class SafeOrder {
public:
    explicit SafeOrder(std::int64_t quantity)
        : quantity_{quantity} {}

private:
    std::int64_t quantity_;
};

void submit(SafeOrder);

void explicit_demo() {
    submit(SafeOrder{42});
    // submit(42);          // error: explicit constructor not considered
    // SafeOrder order = 42; // error: explicit constructor in copy-initialization
    SafeOrder order{42};    // direct construction is allowed
    (void)order;
}
```

Chapter 5 names and compares the initialization forms. The practical distinction here is that braces naming `SafeOrder` express the conversion.

**Rule.** Make single-argument constructors `explicit` by default. Omit it only when the source and destination types have a natural, lossless, unsurprising conversion.

Conversion operators work in the other direction. `explicit operator bool()` supports conditions without allowing broad integer arithmetic:

```cpp
class FeedStatus {
public:
    explicit FeedStatus(bool connected) : connected_{connected} {}

    explicit operator bool() const {
        return connected_;
    }

private:
    bool connected_;
};

void status_demo() {
    FeedStatus status{true};
    if (status) {
        std::cout << "connected\n";  // prints: connected
    }
    // int code = status;  // error: no implicit conversion to int
}
```

## Delegating and inherited constructors, statics, and ref-qualifiers

A **delegating constructor** calls another constructor of the same class. It keeps validation and canonical setup in one place:

```cpp
class Order {
public:
    Order() : Order{Price{0}, 0} {}

    Order(Price price, std::int64_t quantity)
        : price_{price}, quantity_{quantity} {
        if (quantity < 0) {
            std::terminate();
        }
    }

private:
    Price price_;
    std::int64_t quantity_;
};
```

Only the target constructor initializes members. The delegating constructor's body can add work after the target completes, but it cannot provide a second member initializer list.

A derived class can **inherit constructors** from a base with a `using` declaration:

```cpp
class FeedConfig {
public:
    explicit FeedConfig(std::string endpoint)
        : endpoint_{endpoint} {}

private:
    std::string endpoint_;
};

class SimFeedConfig : public FeedConfig {
public:
    using FeedConfig::FeedConfig;
};

void inherited_constructor_demo() {
    SimFeedConfig config{"capture.bin"};
    (void)config;
}
```

`SimFeedConfig` re-exposes the applicable `FeedConfig` constructors. Inheritance semantics arrive later in this chapter; constructor inheritance does not copy constructors or turn every base constructor into a default constructor.

A `static` data member belongs to the class rather than to each object. An `inline static` member **(C++17)** can be defined inside the class:

```cpp
class LiveOrder {
public:
    LiveOrder() {
        ++live_orders_;
    }

    ~LiveOrder() {
        --live_orders_;
    }

    LiveOrder(const LiveOrder&) = delete;
    LiveOrder& operator=(const LiveOrder&) = delete;

    static std::int64_t live_orders() {
        return live_orders_;
    }

private:
    inline static std::int64_t live_orders_ = 0;  // C++17
};

void static_member_demo() {
    LiveOrder first;
    {
        LiveOrder second;
        std::cout << LiveOrder::live_orders() << '\n';  // prints: 2
    }
    std::cout << LiveOrder::live_orders() << '\n';      // prints: 1
}
```

A static member function has no `this` pointer and can directly access only static members. Cross-translation-unit initialization of static objects has separate ordering hazards (Chapters 5 and 19).

A member function's trailing `&` or `&&` restricts the value category of the object on which it can be called. These are **ref-qualifiers**, applying Chapter 3's lvalue and rvalue categories to the implicit object:

```cpp
class OrderBuilder {
public:
    explicit OrderBuilder(std::int64_t quantity)
        : quantity_{quantity} {}

    Order build() && {
        return Order{Price{100}, quantity_};
    }

    Order build() & = delete;

private:
    std::int64_t quantity_;
};

void builder_demo() {
    Order order = OrderBuilder{250}.build();
    // OrderBuilder builder{250};
    // Order second = builder.build();  // error: lvalue overload is deleted
    (void)order;
}
```

The rvalue-only `build()` communicates that building consumes the builder's logical state. Chapter 7 makes this pattern useful for transferring owned resources.

A getter can likewise provide `const std::string& name() const &` for stable objects and a separate `std::string name() &&` that transfers from a temporary. The latter's implementation depends on move semantics, so Chapter 7 completes it.

The declaration pair is already useful as an interface contract:

```cpp
class NamedOrder {
public:
    explicit NamedOrder(std::string name) : name_{name} {}

    const std::string& name() const & {
        return name_;
    }

    std::string name() &&;  // ownership-transfer definition in Chapter 7

private:
    std::string name_;
};

void stable_name_demo() {
    NamedOrder order{"opening-auction"};
    std::cout << order.name() << '\n';  // prints: opening-auction
}
```

The lvalue overload can safely return an alias because the named object remains under the caller's control. The rvalue overload returns a value so a temporary cannot expose a reference to a member that is about to disappear.

## Bit-fields

A **bit-field** gives an integral member a width measured in bits. A platform-specific packed flag type can force its ABI assumptions into a compile-time check:

```cpp
struct MsgFlags {
    std::uint16_t venue : 4;
    std::uint16_t side : 1;
    std::uint16_t urgent : 1;
    std::uint16_t reserved : 10;
};

static_assert(sizeof(MsgFlags) == 2);

void bit_field_demo() {
    MsgFlags flags{3, 1, 0, 0};
    flags.urgent = 1;
    std::cout << flags.venue << ' ' << flags.urgent << '\n';
    // prints: 3 1

    // auto* pointer = &flags.urgent;  // error: address of a bit-field
    // auto& reference = flags.urgent; // error: reference to a bit-field
}
```

The assertion rejects targets where this declaration does not occupy one `std::uint16_t`. It does not make the bit positions portable.

Bit-field layout has implementation-defined parts:

- Allocation can proceed from low bits to high bits or in the opposite direction.
- Whether a field can straddle an allocation unit depends on the implementation.
- Plain and signed bit-field behavior has portability traps; use an explicitly unsigned base type.
- Adjacent nonzero-width bit-fields normally share one memory location for data-race purposes (Chapter 25).

**Note.** Bit-fields are suitable for internal packing under a fixed ABI. A wire format needs explicit shifts and masks, with the full representation and endianness rules from Chapter 16.

```cpp
std::uint16_t pack_flags(std::uint16_t venue,
                         bool sell,
                         bool urgent) {
    return static_cast<std::uint16_t>(
        (venue & 0xFu) |
        (static_cast<std::uint16_t>(sell) << 4) |
        (static_cast<std::uint16_t>(urgent) << 5));
}

void packed_wire_demo() {
    std::uint16_t wire = pack_flags(3, true, false);
    std::cout << wire << '\n';  // prints: 19
}
```

Writing one bit-field is typically a read-modify-write operation on its containing storage unit: load, mask, merge, and store. Packing saves footprint but can add instructions and couples adjacent fields to the same memory access.

## Inheritance and composition

Composition is the default relationship between types. An `OrderBook` **has** price levels; it is not a specialized price level.

```cpp
struct Level {
    Price price;
    std::int64_t quantity;
};

class OrderBook {
public:
    void add(Level level) {
        levels_.push_back(level);
    }

private:
    std::vector<Level> levels_;
};
```

Inheritance earns its place when a derived type must be substitutable for a base type, usually through runtime polymorphism. Public inheritance spells that **is-a** relationship:

```cpp
class Order {
public:
    explicit Order(std::int64_t quantity) : quantity_{quantity} {
        std::cout << "Order ctor\n";
    }

    ~Order() {
        std::cout << "Order dtor\n";
    }

    std::int64_t quantity() const {
        return quantity_;
    }

private:
    std::int64_t quantity_;
};

class LimitOrder : public Order {
public:
    LimitOrder(std::int64_t quantity, Price limit)
        : Order{quantity}, limit_{limit} {
        std::cout << "LimitOrder ctor\n";
    }

    ~LimitOrder() {
        std::cout << "LimitOrder dtor\n";
    }

private:
    Price limit_;
};

void inheritance_order_demo() {
    LimitOrder order{100, Price{42}};
}
// prints:
// Order ctor
// LimitOrder ctor
// LimitOrder dtor
// Order dtor
```

A derived object contains a base-class subobject plus its own members. Construction starts with the base subobject, then initializes derived members and runs the derived constructor body. Destruction mirrors that order.

```text
Conceptual LimitOrder object
+--------------------------+
| Order base subobject     |
+--------------------------+
| LimitOrder members       |
+--------------------------+
```

This is a relationship diagram, not a byte-offset guarantee; Chapter 16 covers exact object layout. Code can implicitly convert `LimitOrder*` to `Order*` under public inheritance because every `LimitOrder` contains an `Order` subobject.

Inheritance access controls how the base interface appears:

| Inheritance kind | Outside code sees inherited `public` names as | Derived code sees base `protected` names | Design meaning |
|---|---|---|---|
| `public` | `public` | yes | is-a; substitutable |
| `protected` | `protected` | yes | implementation relationship |
| `private` | inaccessible | yes | implemented in terms of |

Base `private` members remain inaccessible directly to derived classes under every inheritance kind. A base can expose protected helper functions, but broad protected state lets derived classes violate base invariants and is usually a design smell.

Private inheritance is rare. It can reuse a policy implementation without exposing a base conversion:

```cpp
class MetricsPolicy {
protected:
    void record_poll() {
        ++polls_;
    }

private:
    std::int64_t polls_{};
};

class Feed : private MetricsPolicy {
public:
    void poll() {
        record_poll();
    }
};
```

A `MetricsPolicy` member usually communicates this “has implementation” relationship more directly. Reserve inheritance for substitutability or a constrained policy technique.

**Rule.** Prefer composition. Use public inheritance only when callers genuinely operate on the base interface and every derived object obeys the base contract.

## Object slicing

Converting a derived object to a base object by value copies only the base subobject. The derived members are **sliced** away.

```cpp
class Order {
public:
    explicit Order(std::int64_t quantity) : quantity_{quantity} {}
    virtual ~Order() = default;

    virtual const char* kind() const {
        return "Order";
    }

    std::int64_t quantity() const {
        return quantity_;
    }

private:
    std::int64_t quantity_;
};

class LimitOrder : public Order {
public:
    LimitOrder(std::int64_t quantity, Price limit)
        : Order{quantity}, limit_{limit} {}

    const char* kind() const override {
        return "LimitOrder";
    }

    Price limit() const {
        return limit_;
    }

private:
    Price limit_;
};

void inspect(Order order) {
    std::cout << order.kind() << '\n';
}

void slicing_demo() {
    LimitOrder limit{100, Price{42}};
    std::vector<Order> orders;
    orders.push_back(limit);

    std::cout << limit.kind() << '\n';     // prints: LimitOrder
    std::cout << orders[0].kind() << '\n'; // prints: Order
    inspect(limit);                        // prints: Order
}
```

`std::vector<Order>` allocates slots for values of exactly `Order`. `push_back(limit)` constructs an `Order` from the `Order` subobject; no storage exists for `limit_`, and the new object's runtime type is `Order`. Passing a `LimitOrder` to `inspect(Order)` performs the same slicing.

This is where Java or Python reference intuition fails: the container stores values, not references to the original objects.

Avoid slicing in one of three ways:

- Keep a homogeneous value container and do not use inheritance for its elements.
- Store pointers to polymorphic objects; Chapter 8 replaces owning raw pointers with ownership types.
- Make a polymorphic base abstract so creating a base value is ill-formed.

```cpp
class AbstractFeed {
public:
    virtual ~AbstractFeed() = default;
    virtual void poll() = 0;
};

void abstract_slice_blocker() {
    // AbstractFeed feed;  // error: AbstractFeed is abstract
}
```

**Pitfall.** Passing a polymorphic base by value is usually a slicing bug. Pass it by reference or pointer when dynamic type must survive the call.

## Virtual functions, vtables, and abstract classes

A virtual function dispatches according to an object's runtime type when called through a base pointer or reference. A non-virtual call is selected from the expression's compile-time type.

```cpp
class Feed {
public:
    virtual ~Feed() = default;
    virtual const char* poll() = 0;
};

class SimFeed : public Feed {
public:
    const char* poll() override {
        return "sim";
    }
};

class LiveFeed : public Feed {
public:
    const char* poll() override {
        return "live";
    }
};

void poll_all() {
    SimFeed sim;
    LiveFeed live;
    std::vector<Feed*> feeds{&sim, &live};

    for (Feed* feed : feeds) {
        std::cout << feed->poll() << '\n';
    }
}
// prints:
// sim
// live
```

`Feed` is abstract because `poll()` is a **pure virtual function**, marked `= 0`. An abstract class cannot be instantiated, but pointers and references can name its derived objects. A class whose public behavior is entirely pure virtual is often called an interface.

Most major C++ ABIs implement dispatch with a hidden per-object pointer called a **vptr** and a per-class table called a **vtable**:

```text
SimFeed object                         SimFeed vtable
+------------------+                 +------------------------+
| vptr ------------|---------------->| RTTI / ABI metadata    |
+------------------+                 | destructor slot(s)     |
                                     | &SimFeed::poll         |
                                     +------------------------+

LiveFeed object                        LiveFeed vtable
+------------------+                 +------------------------+
| vptr ------------|---------------->| RTTI / ABI metadata    |
+------------------+                 | destructor slot(s)     |
                                     | &LiveFeed::poll        |
                                     +------------------------+
```

A call such as `feed->poll()` conceptually performs three dependent operations:

1. Load the vptr from `*feed`.
2. Load the function address from the `poll` slot.
3. Make an indirect call to that address.

The C++ standard specifies behavior, not vptrs or table layout. The diagram describes the Itanium-family and Microsoft implementations readers encounter in practice; exact slots differ by ABI.

Virtual dispatch has several costs:

- Each polymorphic object normally carries one pointer-sized vptr.
- The target-address loads form a dependency chain; a cold object or vtable can miss in cache.
- An unresolved indirect call blocks inlining and the optimization it would expose inside the caller.
- Mixed runtime types at one call site add indirect-branch predictor pressure.
- Each polymorphic class contributes table and runtime-type metadata to the binary.

The lost inlining often matters more than the dispatch instructions. A direct inlined call can expose constants, remove branches, and keep intermediate values in the caller's registers. Measuring branch-target behavior belongs in *Computer Architecture and Performance Engineering*.

Call-site type distribution matters. A loop that repeatedly sees one concrete feed gives the indirect branch predictor a stable target, while interleaving several derived types at the same source-level call creates competing targets. The source code contains one `feed->poll()` either way, but the machine sees a different target history.

The two dispatch loads are also dependent: the vtable address is unavailable until the object load produces the vptr, and the call target is unavailable until the vtable lookup completes. A cold vtable line therefore cannot be prefetched from the object type by ordinary sequential access.

A compiler can **devirtualize** when it proves the runtime type. Calls on a visible local object and calls through a leaf class marked `final` are common opportunities.

The vptr also changes footprint:

```cpp
struct PlainValue {
    std::uintptr_t data;
};

struct PolymorphicValue {
    virtual void touch() {}
    std::uintptr_t data;
};

void size_demo() {
    std::cout << sizeof(PlainValue) << ' '
              << sizeof(PolymorphicValue) << '\n';
    // commonly prints on a 64-bit ABI: 8 16
}
```

The concrete sizes are implementation details. The common result adds one eight-byte vptr and can cause further padding in other member layouts.

A pure virtual function may have an out-of-class body, although the class remains abstract. Derived code can call that body with a qualified name; this niche facility does not supply ordinary virtual dispatch.

Virtual calls made during construction and destruction do not dispatch to a more-derived part that is not currently alive:

```cpp
class Base {
public:
    Base() {
        identify();
    }

    virtual ~Base() = default;

    virtual void identify() const {
        std::cout << "Base\n";
    }
};

class Derived : public Base {
public:
    void identify() const override {
        std::cout << "Derived\n";
    }
};

void constructor_dispatch_demo() {
    Derived object;  // prints: Base
}
```

While `Base` is being constructed, the active runtime behavior is `Base`; calling `identify()` does not reach `Derived::identify()`. The reverse restriction applies while base destruction runs.

**Pitfall.** Do not call virtual hooks from constructors or destructors expecting derived behavior. The derived state is either not initialized yet or already destroyed.

## Virtual destructors and deleting through base pointers

`new T{...}` creates a `T` in dynamically allocated storage and returns a `T*`. `delete pointer` destroys that object and releases the storage; Chapters 8 and 17 cover ownership and allocation fully.

Deleting a derived object through a base pointer whose destructor is non-virtual has undefined behavior:

```cpp
class Feed {
public:
    virtual void poll() {}
    ~Feed() = default;  // non-virtual
};

class SimFeed : public Feed {
public:
    ~SimFeed() {
        std::cout << "close capture\n";
    }
};

void invalid_base_delete() {
    Feed* feed = new SimFeed{};
    delete feed;  // undefined behavior: Feed destructor is non-virtual
}
```

“Only the base destructor runs” is a common symptom, not the language rule. The behavior is undefined; a compiler may also use the wrong deallocation size or optimize on the assumption that the invalid execution never occurs. Sanitizers diagnose some instances, but this is not guaranteed.

The fix is part of the base interface:

```cpp
class Feed {
public:
    virtual ~Feed() = default;
    virtual void poll() = 0;
};

class SimFeed : public Feed {
public:
    ~SimFeed() override {
        std::cout << "close capture\n";
    }

    void poll() override {}
};

void valid_base_delete() {
    Feed* feed = new SimFeed{};
    delete feed;  // prints: close capture
}
```

The virtual destructor selects the complete object's destruction sequence. A class with any virtual function should normally have a public virtual destructor.

**Rule.** A polymorphic base is either publicly destructible through a virtual destructor or not publicly destructible through the base at all.

Adding the destructor entries expands the per-class vtable but adds no further per-object pointer once the class is already polymorphic. Destruction through the base still performs virtual dispatch.

The niche alternative makes the non-virtual destructor protected:

```cpp
class Listener {
public:
    virtual void on_message() = 0;

protected:
    ~Listener() = default;
};

void cannot_own_listener(Listener* listener) {
    listener->on_message();
    // delete listener;  // error: Listener destructor is protected
}
```

This interface permits non-owning calls while making base-pointer deletion a compile error. A derived object can still be destroyed through its concrete type. `std::shared_ptr` can retain a concrete deleter in some non-virtual-destructor designs, but Chapter 8 covers that specialized ownership behavior.

| Base destructor design | Delete through `Base*`? | Intended role |
|---|---|---|
| public virtual | yes | owning polymorphic interface |
| protected non-virtual | compile error | non-owning callback interface |
| public non-virtual | undefined for derived object | not a valid polymorphic ownership design |

## `override`, `final`, and covariant returns

An overriding function must match the base virtual signature, including parameter types and member qualifiers. Without `override`, a small mismatch silently declares a different function:

```cpp
class Handler {
public:
    virtual ~Handler() = default;

    virtual void handle(int code) const {
        std::cout << "Handler " << code << '\n';
    }
};

class BrokenHandler : public Handler {
public:
    void handle(long code) const {
        std::cout << "BrokenHandler " << code << '\n';
    }
};

void drift_demo() {
    BrokenHandler derived;
    Handler& base = derived;
    base.handle(7);  // prints: Handler 7
}
```

Adding `override` asks the compiler to verify the relationship:

```cpp
class CheckedHandler : public Handler {
public:
    // void handle(long code) const override;  // error: does not override

    void handle(int code) const override {
        std::cout << "CheckedHandler " << code << '\n';
    }
};
```

**Rule.** Write `override` on every overriding declaration. Do not repeat `virtual` there; `override` already communicates both intent and compiler enforcement.

A derived declaration with the same name hides all base overloads, even when its signature does not override them. A `using` declaration re-exposes the overload set:

```cpp
class Parser {
public:
    void parse(int) {}
    void parse(double) {}
};

class NamedParser : public Parser {
public:
    using Parser::parse;

    void parse(const std::string& name) {
        std::cout << name << '\n';
    }
};

void hiding_demo() {
    NamedParser parser;
    parser.parse(7);          // calls Parser::parse(int)
    parser.parse("EURUSD");   // prints: EURUSD
}
```

`final` on a virtual member forbids further overriding. `final` on a class forbids derivation and tells the optimizer that calls through that concrete type have no more-derived target:

```cpp
class Feed {
public:
    virtual ~Feed() = default;
    virtual int poll() const = 0;
};

class SimFeed final : public Feed {
public:
    int poll() const override {
        return 7;
    }
};

int poll_once(const SimFeed& feed) {
    return feed.poll();
}
```

At `-O2`, a typical x86-64 compiler reduces `poll_once` to a direct constant result:

```text
poll_once:
    mov eax, 7
    ret
```

The compiler has devirtualized and inlined the call. `final` creates an opportunity, not a universal performance guarantee; visibility and optimization settings still matter.

An override may return a pointer or reference to a more-derived class than the base function returns. This is a **covariant return type**:

```cpp
class Instrument {
public:
    virtual ~Instrument() = default;
    virtual Instrument* clone() const = 0;
};

class Option final : public Instrument {
public:
    Option* clone() const override {
        return new Option{*this};
    }
};
```

`Option*` converts to `Instrument*`, so callers through either interface receive an appropriate pointer. The caller owns the clone in this raw-pointer sketch; Chapter 8 replaces that informal contract with an ownership type.

## Multiple inheritance, virtual inheritance, and RTTI

C++ permits a class to have several direct base classes. The derived object then contains a subobject for each non-virtual base, and a polymorphic implementation may need several vptrs.

The classic diamond duplicates the top base:

```cpp
struct Identity {
    int id{};
};

struct VenueIdentity : Identity {};
struct StrategyIdentity : Identity {};
struct RoutedOrder : VenueIdentity, StrategyIdentity {};

void diamond_demo() {
    RoutedOrder order;
    order.VenueIdentity::id = 7;
    order.StrategyIdentity::id = 9;
    // std::cout << order.id;  // error: id is ambiguous
}
```

Virtual inheritance requests one shared top-base subobject:

```cpp
struct Identity {
    int id{};
};

struct VenueIdentity : virtual Identity {};
struct StrategyIdentity : virtual Identity {};
struct RoutedOrder : VenueIdentity, StrategyIdentity {};

void virtual_diamond_demo() {
    RoutedOrder order;
    order.id = 7;
    std::cout << order.id << '\n';  // prints: 7
}
```

The shared base requires runtime-adjusted offsets in common ABIs and complicates construction. The standard iostream hierarchy uses virtual inheritance to solve a real diamond; new application designs rarely need the technique.

**Rule.** Know the diamond for interviews. In new code, use multiple inheritance primarily for pure interfaces, and treat virtual inheritance as a signal to reconsider composition.

**RTTI**, or runtime type information, supports `typeid` and `dynamic_cast`. Chapter 2 introduced the cast; a pointer downcast now has enough context:

```cpp
class Feed {
public:
    virtual ~Feed() = default;
};

class SimFeed : public Feed {
public:
    void seek(std::int64_t sequence) {
        std::cout << sequence << '\n';
    }
};

class LiveFeed : public Feed {};

void try_seek(Feed* feed) {
    if (SimFeed* sim = dynamic_cast<SimFeed*>(feed)) {
        sim->seek(42);  // prints: 42 for a SimFeed
    }
}

void rtti_demo() {
    SimFeed sim;
    LiveFeed live;
    try_seek(&sim);
    try_seek(&live);  // cast returns nullptr
    std::cout << std::boolalpha
              << (typeid(sim) == typeid(SimFeed)) << '\n';  // prints: true
}
```

A failed pointer `dynamic_cast` returns `nullptr`. A failed reference `dynamic_cast` throws; Chapter 6 introduces that failure mechanism.

`typeid(expression)` reports a `std::type_info` object for the expression's runtime type when the expression identifies a polymorphic object. Equality compares exact runtime types; it does not ask whether one type derives from another.

`dynamic_cast` may need to search runtime type metadata and adjust a pointer across a multiple-inheritance graph. It is not generally one type-tag comparison. RTTI also contributes per-class type information to the binary.

Some low-latency builds use `-fno-rtti` to reduce metadata and discourage type-switching designs. The option disables `dynamic_cast` and `typeid` uses that require RTTI; it does not itself disable exception handling.

An explicit kind tag makes a closed hierarchy's check visible and cheap:

```cpp
enum class FeedKind : std::uint8_t {
    Sim,
    Live
};

class Feed {
public:
    virtual ~Feed() = default;

    FeedKind kind() const {
        return kind_;
    }

protected:
    explicit Feed(FeedKind kind) : kind_{kind} {}

private:
    FeedKind kind_;
};

class SimFeed : public Feed {
public:
    SimFeed() : Feed{FeedKind::Sim} {}

    void seek(std::int64_t sequence) {
        std::cout << sequence << '\n';
    }
};

void tagged_seek(Feed& feed) {
    if (feed.kind() == FeedKind::Sim) {
        static_cast<SimFeed&>(feed).seek(42);  // prints: 42
    }
}
```

The tag and runtime type must never disagree. A private or protected construction path should enforce that invariant; otherwise the unchecked `static_cast` has undefined behavior when used as the wrong derived type.

| Downcast mechanism | Checked? | Needs RTTI? | Runtime mechanism | Suitable use |
|---|---|---|---|---|
| `dynamic_cast<Derived*>` | yes | yes | type-graph query | cold extensible boundary |
| tag + `static_cast` | tag only | no | load, compare, branch | closed hierarchy with enforced tag |
| bare `static_cast` | no | no | usually none | already-proven invariant |
| virtual function | no downcast | ordinary vtable | virtual dispatch | behavior belongs on the type |

Repeated downcasts in a hot loop usually indicate missing virtual behavior or the wrong data model. Variant-based closed dispatch is another option (Chapter 14).

Multiple inheritance is least surprising when every base is a stateless pure interface:

```cpp
class Pollable {
public:
    virtual ~Pollable() = default;
    virtual void poll() = 0;
};

class Resettable {
public:
    virtual ~Resettable() = default;
    virtual void reset() = 0;
};

class Simulation final : public Pollable, public Resettable {
public:
    void poll() override {}
    void reset() override {}
};
```

Each base describes an independent capability, so no duplicated state or diamond needs reconciliation. Pointer adjustment can still occur when a `Simulation*` converts to either interface pointer.

## CRTP and type erasure

The **curiously recurring template pattern**, or CRTP, moves dispatch to compile time. A template is a class pattern parameterized here by a derived type; Chapter 9 explains the syntax in depth.

```cpp
template <typename Derived>
class FeedBase {
public:
    int poll() {
        return static_cast<Derived&>(*this).poll_impl();
    }
};

class SimFeed : public FeedBase<SimFeed> {
public:
    int poll_impl() {
        return 7;
    }
};

class LiveFeed : public FeedBase<LiveFeed> {
public:
    int poll_impl() {
        return 11;
    }
};

void crtp_demo() {
    SimFeed sim;
    LiveFeed live;
    std::cout << sim.poll() << ' ' << live.poll() << '\n';
    // prints: 7 11
}
```

`FeedBase<SimFeed>::poll` names `SimFeed::poll_impl` at compile time. The call is direct and fully inlinable, with no vptr or runtime dispatch.

The two base specializations are different types. There is no single `FeedBase` type that can hold both `SimFeed` and `LiveFeed` in one heterogeneous runtime container. CRTP trades runtime flexibility for compile-time coupling and can duplicate generated code for each derived type. Concepts cover many static-interface uses more directly (Chapter 9).

**Type erasure** takes the opposite approach: unrelated concrete types fit behind one value-like wrapper. The concrete types need a matching operation but do not inherit from a public base.

```cpp
class Poller {
private:
    class Interface {
    public:
        virtual ~Interface() = default;
        virtual int poll() = 0;
        virtual Interface* clone() const = 0;
    };

    template <typename T>
    class Model final : public Interface {
    public:
        explicit Model(const T& object) : object_{object} {}

        int poll() override {
            return object_.poll();
        }

        Model* clone() const override {
            return new Model<T>{object_};
        }

    private:
        T object_;
    };

public:
    template <typename T>
    explicit Poller(const T& object) : self_{new Model<T>{object}} {}

    ~Poller() {
        delete self_;
    }

    Poller(const Poller& other) : self_{other.self_->clone()} {}

    Poller& operator=(const Poller& other) {
        Interface* replacement = other.self_->clone();
        delete self_;
        self_ = replacement;
        return *this;
    }

    int poll() {
        return self_->poll();
    }

private:
    Interface* self_;
};
```

`Poller` owns an internal `Model<T>` selected by its constructor. The model adapts `T::poll()` to one private virtual interface and implements deep copy through `clone()`. This rule-of-three sketch deliberately relies on copying; Chapter 7 adds move operations and Chapter 8 replaces raw ownership machinery.

Copy construction allocates a new model, so two `Poller` values own independent concrete objects. Copy assignment clones before deleting the old model; if construction later gains a failure path, that ordering prevents the destination from being destroyed before replacement succeeds. The wrapper's value semantics therefore require more machinery than a non-owning `Feed*`.

Two unrelated source types can now share a value container:

```cpp
class SimulationSource {
public:
    int poll() {
        return 7;
    }
};

class NetworkSource {
public:
    int poll() {
        return 11;
    }
};

void erased_demo() {
    std::vector<Poller> pollers;
    pollers.reserve(2);
    pollers.emplace_back(SimulationSource{});
    pollers.emplace_back(NetworkSource{});

    for (Poller& poller : pollers) {
        std::cout << poller.poll() << '\n';
    }
}
// prints:
// 7
// 11
```

The stored types remain unaware of `Poller`. The cost is virtual-shaped indirect dispatch inside the wrapper plus a heap allocation for each model in this implementation. `std::function` industrializes the technique for callable objects (Chapter 9), often with a small-object optimization to avoid some allocations (Chapter 21).

Type erasure does not inherently remove vtables. This implementation hides one private vtable behind a non-intrusive value interface; other erasure implementations store function pointers directly. The win is decoupling and uniform storage, not free dispatch.

| Approach | Dispatch cost | Heterogeneous container? | Intrusive coupling? | Binary/code-size effect | Choose when |
|---|---|---|---|---|---|
| virtual base | indirect call unless devirtualized | yes, through pointers | concrete type inherits interface | one implementation plus vtables | open runtime hierarchy |
| CRTP | direct, inlinable | no common runtime base | derived names CRTP base | code per specialization | closed compile-time variation |
| type erasure | indirect call; possible allocation | yes, wrapper values | stored type has no base | model code per stored type | non-intrusive runtime boundary |

## Latency Lens

- Virtual dispatch loads the vptr, loads a slot, then makes an indirect call; dependent loads put a cold object or vtable line directly on the call path.
- The larger virtual cost is often lost inlining: an unresolved indirect call blocks constant propagation and register scheduling across the boundary.
- Mixed runtime types at one call site pressure indirect-branch prediction, while a stable single target is much easier to predict.
- `final` and provably local dynamic types enable devirtualization, turning an indirect call into a direct, potentially inlined call.
- A vptr adds one pointer per polymorphic object—typically eight bytes on a 64-bit ABI—so a small object can cross a cache-footprint boundary before any virtual call occurs.
- CRTP resolves dispatch at compile time and adds no per-object dispatch state; its cost moves to compile time and generated code per specialization.
- Type erasure pays indirect dispatch plus a possible model allocation; construct erased wrappers outside per-message paths and keep them long-lived.
- Bit-field writes perform a load-mask-merge-store on the containing unit; packing cold flags saves footprint, while packing hot counters adds ALU work and sharing.
- `dynamic_cast` can query and traverse a runtime type graph; a checked kind tag is a load and branch, but only when construction enforces agreement between tag and type.
