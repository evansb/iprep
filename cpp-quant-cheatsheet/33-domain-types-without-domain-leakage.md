# 33. Domain types without domain leakage

*Part VI-A — Quant blueprints: types, codecs, and core structures*

---

**Recall**
- `using Price = std::int64_t;` creates an *alias*, not a type — two aliases of the same scalar are the same type and overload resolution cannot separate them.
- A one-member wrapper over a scalar is normally the same size, trivially copyable, and passed in a register — verify with `static_assert`, do not assume.
- Give a single-argument constructor `explicit`; conversion is a boundary event that should be visible at the call site.
- Capability, not representation, decides the operator set: `Price + Price` is meaningless even though `int64_t + int64_t` compiles.
- Absolute coordinate ± delta = coordinate; coordinate − coordinate = delta; that affine split is the whole design for prices and timestamps.
- Defaulted `friend auto operator<=>(T, T) = default;` synthesizes `<`, `<=`, `>`, `>=`, and (separately) `==`/`!=` for the aggregate case.
- Wrapping an integer changes nothing about arithmetic: signed overflow is still UB, `min / -1` is still UB, unsigned still wraps mod 2^N.
- Check *before* evaluating: `a > MAX - b` is the portable overflow test; evaluating then inspecting the result is already UB for signed types.
- Prefer the C++26/builtin checked ops behind a portable interface; `__builtin_add_overflow` is a compiler extension, not standard C++23.
- Fixed point: `external = raw / S`; add/sub are raw ops when scales match, mul is `a*b/S`, div is `a*S/b`, both needing a wider intermediate.
- `__int128` / `std::int128_t` is not portable — write the wide multiply with a proven 64×64→128 helper or pre-division range checks.
- Rounding mode is part of the API: `rescale<To>(x, Rounding::nearest_ties_even)`, never a converting constructor.
- Scale (raw→whole units) and tick quantum (which raw multiples are legal) are orthogonal; keep them as separate template parameters.
- `enum class` blocks implicit integer conversion but does **not** guarantee the object holds a named enumerator — validate every external integer.
- `std::to_underlying(e)` (C++23) is the intentional, greppable enum→integer conversion; `static_cast` back in is a validation hole.
- Three distinct concepts, three representations: valid value = `T`, absence = `optional<T>`, invalid input = `expected<T, E>`.
- A protocol sentinel (`-1`, `0xFFFFFFFF`) must die at the adapter; if core algorithms test `price != -1`, wire format has leaked inward.
- `sizeof(optional<T>) > sizeof(T)` in general (extra bool + padding); it is a program type, never a serialization layout.
- Specialize `std::hash` only for your own types; equal keys must hash equal, and identity hashing is not collision-resistant.
- Trivially copyable permits `memcpy` between C++ objects; it does **not** define a wire encoding — padding, endianness, and width are protocol concerns.
- Generation-tagged handles (`index + generation`) detect stale references after slot reuse — until the generation counter wraps.
- Distinct clock domains get distinct wrapper types even when both hold `nanoseconds`; subtracting unrelated epochs is arithmetic on nonsense.
- Compose events deliberately: member order controls padding, and `static_assert(sizeof(Event) == N)` is a tested platform contract, not a standard guarantee.

---

## 33.1 Strong types for `Price`, `Quantity`, `OrderId`, `Sequence`, and timestamps

```cpp
#include <chrono>
#include <compare>
#include <cstdint>
#include <functional>
#include <optional>
#include <type_traits>

// ---- 1. Alias: NOT a type -------------------------------------------------
using PriceAlias    = std::int64_t;
using QuantityAlias = std::int64_t;
void replace(PriceAlias, QuantityAlias);
// replace(QuantityAlias{50}, PriceAlias{10125});  // compiles — same type

// ---- 2. Aggregate wrapper: every bit pattern is valid ---------------------
struct Sequence {
    std::uint64_t value{};                                   // public: no invariant
    friend constexpr auto operator<=>(Sequence, Sequence) = default;  // < <= > >= and ==
};

struct OrderId {
    std::uint64_t value{};
    friend constexpr bool operator==(OrderId, OrderId) = default;     // equality ONLY:
    // ordering omitted deliberately — sorting opaque IDs encodes meaningless policy
};

static_assert(std::is_trivially_copyable_v<Sequence>);
static_assert(std::is_standard_layout_v<Sequence>);
static_assert(std::is_aggregate_v<Sequence>);                 // brace-init works
static_assert(sizeof(Sequence) == sizeof(std::uint64_t));     // project requirement
static_assert(alignof(Sequence) == alignof(std::uint64_t));

Sequence s0{};                    // value-init  → 0
Sequence s1{42};                  // aggregate init
Sequence s2 = {42};               // copy-list-init of an aggregate
auto      s3 = Sequence{42};      // explicit temporary
// Sequence s4 = 42;              // ill-formed: no converting constructor

// ---- 3. Encapsulated wrapper: a real invariant -----------------------------
class PositiveQuantity {
public:
    constexpr PositiveQuantity() = delete;                   // no "empty" state

    [[nodiscard]] static constexpr std::optional<PositiveQuantity>
    make(std::uint64_t raw) noexcept {
        if (raw == 0) return std::nullopt;                   // invariant enforced once
        return PositiveQuantity{raw};
    }
    // Precondition-carrying fast path for already-validated internal values.
    [[nodiscard]] static constexpr PositiveQuantity
    make_unchecked(std::uint64_t raw) noexcept { return PositiveQuantity{raw}; }

    [[nodiscard]] constexpr std::uint64_t value() const noexcept { return value_; }
    friend constexpr auto operator<=>(PositiveQuantity, PositiveQuantity) = default;

private:
    explicit constexpr PositiveQuantity(std::uint64_t raw) noexcept : value_{raw} {}
    std::uint64_t value_;
};

static_assert(sizeof(PositiveQuantity) == 8);
static_assert(std::is_trivially_copyable_v<PositiveQuantity>);
static_assert(!PositiveQuantity::make(0).has_value());
static_assert(PositiveQuantity::make(5)->value() == 5);
```

```cpp
// ---- 4. Explicit constructor form (when you want one) ---------------------
class PriceTicks {
public:
    PriceTicks() = default;                                  // zero is a valid price tick
    explicit constexpr PriceTicks(std::int64_t t) noexcept : ticks_{t} {}
    [[nodiscard]] constexpr std::int64_t ticks() const noexcept { return ticks_; }

    // NO implicit conversion operator — a named accessor is greppable:
    // constexpr operator std::int64_t() const noexcept;     // do NOT do this

    friend constexpr auto operator<=>(PriceTicks, PriceTicks) = default;
private:
    std::int64_t ticks_{};
};

PriceTicks p{10'125};             // direct-init, explicit
// PriceTicks q = 10'125;         // ill-formed: constructor is explicit
// void f(PriceTicks); f(10125);  // ill-formed: no implicit conversion
```

```cpp
// ---- 5. Affine pair: coordinate + delta -----------------------------------
struct PriceDelta {
    std::int64_t ticks{};
    friend constexpr auto operator<=>(PriceDelta, PriceDelta) = default;

    constexpr PriceDelta& operator+=(PriceDelta d) noexcept { ticks += d.ticks; return *this; }
    constexpr PriceDelta& operator-=(PriceDelta d) noexcept { ticks -= d.ticks; return *this; }
    friend constexpr PriceDelta operator+(PriceDelta a, PriceDelta b) noexcept { return {a.ticks + b.ticks}; }
    friend constexpr PriceDelta operator-(PriceDelta a, PriceDelta b) noexcept { return {a.ticks - b.ticks}; }
    friend constexpr PriceDelta operator-(PriceDelta a) noexcept { return {-a.ticks}; }
    friend constexpr PriceDelta operator*(PriceDelta a, std::int64_t k) noexcept { return {a.ticks * k}; }
    friend constexpr PriceDelta operator*(std::int64_t k, PriceDelta a) noexcept { return {a.ticks * k}; }
};

struct Price {                                    // absolute coordinate
    std::int64_t ticks{};
    friend constexpr auto operator<=>(Price, Price) = default;

    friend constexpr Price      operator+(Price p, PriceDelta d) noexcept { return {p.ticks + d.ticks}; }
    friend constexpr Price      operator+(PriceDelta d, Price p) noexcept { return {p.ticks + d.ticks}; }
    friend constexpr Price      operator-(Price p, PriceDelta d) noexcept { return {p.ticks - d.ticks}; }
    friend constexpr PriceDelta operator-(Price a, Price b)      noexcept { return {a.ticks - b.ticks}; }
    constexpr Price& operator+=(PriceDelta d) noexcept { ticks += d.ticks; return *this; }
    constexpr Price& operator-=(PriceDelta d) noexcept { ticks -= d.ticks; return *this; }
    // Deliberately absent: Price + Price, Price * Price, ++Price, Price / int
};
static_assert((Price{100} + PriceDelta{5}) == Price{105});
static_assert((Price{100} - Price{95}) == PriceDelta{5});
```

```cpp
// ---- 6. Generic mixin done right: opt IN to capabilities -------------------
template<class Tag, class Rep>
struct Strong {
    Rep value{};
    using representation = Rep;
    using tag            = Tag;
    friend constexpr auto operator<=>(Strong, Strong) = default;
};

// Capability traits — semantic, granted per type, never blanket-enabled.
template<class T> inline constexpr bool addable_v      = false;
template<class T> inline constexpr bool scalable_v     = false;

struct QuantityTag {};
using Quantity = Strong<QuantityTag, std::uint64_t>;
template<> inline constexpr bool addable_v<Quantity>  = true;
template<> inline constexpr bool scalable_v<Quantity> = true;

struct OrderIdTag {};
using OrderKey = Strong<OrderIdTag, std::uint64_t>;   // addable_v stays false

template<class T> requires addable_v<T>
constexpr T operator+(T a, T b) noexcept { return T{static_cast<typename T::representation>(a.value + b.value)}; }
template<class T> requires scalable_v<T>
constexpr T operator*(T a, typename T::representation k) noexcept { return T{a.value * k}; }

static_assert(Quantity{3} + Quantity{4} == Quantity{7});
// OrderKey{1} + OrderKey{2};   // ill-formed: constraint not satisfied
```

```cpp
// ---- 7. Timestamps: chrono for units, wrappers for clock domains ----------
using Nanos = std::chrono::nanoseconds;

struct ExchangeStamp { Nanos value{}; friend constexpr auto operator<=>(ExchangeStamp, ExchangeStamp) = default; };
struct ReceiveStamp  { Nanos value{}; friend constexpr auto operator<=>(ReceiveStamp,  ReceiveStamp)  = default; };
struct PublishStamp  { Nanos value{}; friend constexpr auto operator<=>(PublishStamp,  PublishStamp)  = default; };

// Same representation, different epochs → cross-domain subtraction won't compile.
// ExchangeStamp{} - ReceiveStamp{};   // ill-formed: no operator-

struct SteadyStamp {
    std::chrono::steady_clock::time_point value{};
    friend constexpr auto operator<=>(SteadyStamp, SteadyStamp) = default;
    static SteadyStamp now() noexcept { return {std::chrono::steady_clock::now()}; }
};

[[nodiscard]] constexpr Nanos elapsed(SteadyStamp end, SteadyStamp begin) noexcept {
    return std::chrono::duration_cast<Nanos>(end.value - begin.value);   // may truncate
}

// Only latency *within* a pipeline stage pair is a legal operation:
[[nodiscard]] constexpr Nanos wire_latency(ReceiveStamp r, ExchangeStamp x) noexcept {
    return r.value - x.value;   // valid only after an explicit calibration adapter
}

// Clock-domain conversion is an ADAPTER, never an implicit constructor.
class ClockBridge {                                   // steady → exchange epoch
public:
    constexpr ClockBridge(SteadyStamp anchor_steady, ExchangeStamp anchor_exchange,
                          Nanos uncertainty) noexcept
        : steady_{anchor_steady}, exch_{anchor_exchange}, sigma_{uncertainty} {}

    [[nodiscard]] constexpr ExchangeStamp to_exchange(SteadyStamp t) const noexcept {
        return ExchangeStamp{exch_.value + (t.value - steady_.value)};
    }
    [[nodiscard]] constexpr Nanos uncertainty() const noexcept { return sigma_; }
private:
    SteadyStamp   steady_;
    ExchangeStamp exch_;
    Nanos         sigma_;
};
```

| Facility | Header | Meaning |
|---|---|---|
| `std::is_trivially_copyable_v<T>` | `<type_traits>` | `memcpy` between `T` objects is defined |
| `std::is_standard_layout_v<T>` | `<type_traits>` | no virtuals, one access control, layout-compatible rules apply |
| `std::is_trivial_v<T>` | `<type_traits>` | trivially copyable **and** trivially default-constructible |
| `std::is_aggregate_v<T>` | `<type_traits>` | brace-init initializes members directly |
| `std::has_unique_object_representations_v<T>` | `<type_traits>` | no padding/trap bits — hashing raw bytes is sound |
| `std::underlying_type_t<E>` | `<type_traits>` | enum's fixed underlying type |
| `std::to_underlying(e)` | `<utility>` | C++23; `static_cast<underlying_type_t<E>>(e)` |
| `std::cmp_less/greater/equal(a,b)` | `<utility>` | C++20; sign-safe integer comparison |
| `std::in_range<T>(v)` | `<utility>` | C++20; does `v` fit in `T`? |
| `std::bit_cast<To>(from)` | `<bit>` | C++20; `constexpr` reinterpretation of same-size trivially copyable types |
| `std::chrono::duration_cast<D>(d)` | `<chrono>` | truncating toward zero |
| `std::chrono::round<D>(d)` | `<chrono>` | C++17; nearest, ties to even |
| `std::chrono::floor<D>/ceil<D>` | `<chrono>` | directed rounding of durations/time_points |

**Traps** — an alias never separates domains · a defaulted `<=>` on `OrderId` silently makes IDs sortable · implicit conversion operators reintroduce the alias problem through the back door · a blanket arithmetic mixin makes identifiers incrementable · `duration_cast` truncates toward zero, `round` is what you usually mean · two timestamps of the same duration type are *not* the same clock.

---

## 33.2 Fixed-point price representation and scaled-integer arithmetic

```cpp
#include <cassert>
#include <cstdint>
#include <cstdlib>
#include <limits>
#include <optional>

enum class Rounding : std::uint8_t {
    toward_zero, floor, ceil, nearest_ties_even, nearest_ties_away, reject_inexact
};

// Signed integer division rounding num/den (den > 0) under an explicit policy.
// Returns nullopt only for reject_inexact with a nonzero remainder.
[[nodiscard]] constexpr std::optional<std::int64_t>
divide_rounded(std::int64_t num, std::int64_t den, Rounding mode) noexcept {
    assert(den > 0);
    std::int64_t q = num / den;              // C++11+: truncation toward zero
    std::int64_t r = num % den;              // sign follows num
    if (r == 0) return q;
    switch (mode) {
        case Rounding::toward_zero:    return q;
        case Rounding::floor:          return (r < 0) ? q - 1 : q;
        case Rounding::ceil:           return (r > 0) ? q + 1 : q;
        case Rounding::reject_inexact: return std::nullopt;
        case Rounding::nearest_ties_away:
        case Rounding::nearest_ties_even: {
            std::int64_t twice = (r < 0 ? -r : r) * 2;        // |r|*2 vs den
            if (twice > den) return (r > 0) ? q + 1 : q - 1;
            if (twice < den) return q;
            if (mode == Rounding::nearest_ties_away) return (r > 0) ? q + 1 : q - 1;
            return (q % 2 == 0) ? q : (r > 0 ? q + 1 : q - 1); // ties → even
        }
    }
    return q;                                                  // unreachable
}
static_assert(*divide_rounded( 7, 2, Rounding::nearest_ties_even) == 4);  //  3.5 → 4
static_assert(*divide_rounded( 5, 2, Rounding::nearest_ties_even) == 2);  //  2.5 → 2
static_assert(*divide_rounded(-7, 2, Rounding::floor)             == -4);
static_assert(*divide_rounded(-7, 2, Rounding::toward_zero)       == -3);
```

```cpp
// ---- Portable 64x64 -> 128 multiply, then divide ---------------------------
struct U128 { std::uint64_t hi{}, lo{}; };

[[nodiscard]] constexpr U128 mul_u64(std::uint64_t a, std::uint64_t b) noexcept {
    constexpr std::uint64_t mask = 0xFFFF'FFFFull;
    std::uint64_t a0 = a & mask, a1 = a >> 32;
    std::uint64_t b0 = b & mask, b1 = b >> 32;
    std::uint64_t p00 = a0 * b0, p01 = a0 * b1, p10 = a1 * b0, p11 = a1 * b1;
    std::uint64_t mid = (p00 >> 32) + (p01 & mask) + (p10 & mask);
    return U128{ p11 + (p01 >> 32) + (p10 >> 32) + (mid >> 32),
                 (mid << 32) | (p00 & mask) };
}

// 128/64 -> 64 with overflow detection; schoolbook long division, 64 iterations.
[[nodiscard]] constexpr std::optional<std::uint64_t>
div_u128_u64(U128 n, std::uint64_t d) noexcept {
    if (d == 0) return std::nullopt;
    if (n.hi >= d) return std::nullopt;                // quotient would not fit
    std::uint64_t rem = n.hi, quo = 0;
    for (int i = 63; i >= 0; --i) {
        std::uint64_t bit = (n.lo >> i) & 1u;
        std::uint64_t carry = rem >> 63;               // detect pre-shift overflow
        rem = (rem << 1) | bit;
        quo <<= 1;
        if (carry || rem >= d) { rem -= d; quo |= 1u; }
    }
    return quo;
}

// Signed muldiv: (a * b) / d with exact 128-bit intermediate and named rounding.
[[nodiscard]] constexpr std::optional<std::int64_t>
muldiv(std::int64_t a, std::int64_t b, std::int64_t d, Rounding mode) noexcept {
    if (d == 0) return std::nullopt;
    bool neg = (a < 0) ^ (b < 0) ^ (d < 0);
    auto abs64 = [](std::int64_t v) noexcept -> std::uint64_t {
        return v < 0 ? (~static_cast<std::uint64_t>(v) + 1u)   // works for INT64_MIN
                     : static_cast<std::uint64_t>(v);
    };
    U128 prod = mul_u64(abs64(a), abs64(b));
    std::uint64_t den = abs64(d);
    auto q = div_u128_u64(prod, den);
    if (!q) return std::nullopt;                       // magnitude overflow
    // Recover remainder for rounding: r = prod - q*den (fits in 64 bits).
    U128 back = mul_u64(*q, den);
    std::uint64_t rem = prod.lo - back.lo;
    std::uint64_t quo = *q;
    if (rem != 0) {
        bool round_up = false;
        switch (mode) {
            case Rounding::toward_zero:    break;
            case Rounding::floor:          round_up = neg;  break;
            case Rounding::ceil:           round_up = !neg; break;
            case Rounding::reject_inexact: return std::nullopt;
            case Rounding::nearest_ties_away: round_up = (rem * 2 >= den); break;
            case Rounding::nearest_ties_even:
                round_up = (rem * 2 > den) || (rem * 2 == den && (quo & 1u));
                break;
        }
        if (round_up) { if (quo == UINT64_MAX) return std::nullopt; ++quo; }
    }
    std::uint64_t limit = neg ? (1ull << 63) : (1ull << 63) - 1;
    if (quo > limit) return std::nullopt;
    return neg ? -static_cast<std::int64_t>(quo) : static_cast<std::int64_t>(quo);
}
static_assert(*muldiv(3'000'000'000LL, 4'000'000'000LL, 1'000'000'000LL,
                      Rounding::toward_zero) == 12'000'000'000LL);
```

```cpp
// ---- The scaled-integer type ------------------------------------------------
template<std::int64_t UnitsPerWhole>
class ScaledInt {
    static_assert(UnitsPerWhole > 0, "scale must be positive");
public:
    using rep = std::int64_t;
    static constexpr rep units_per_whole = UnitsPerWhole;

    constexpr ScaledInt() = default;

    [[nodiscard]] static constexpr ScaledInt from_raw(rep raw) noexcept { return ScaledInt{raw}; }

    [[nodiscard]] static constexpr std::optional<ScaledInt>
    from_whole(rep whole) noexcept {                                  // whole units
        auto r = checked_mul(whole, UnitsPerWhole);
        if (!r) return std::nullopt;
        return ScaledInt{*r};
    }
    // Exact decimal literal: from_parts(12, 3456) with scale 10'000 → 12.3456
    [[nodiscard]] static constexpr std::optional<ScaledInt>
    from_parts(rep whole, rep fraction_units) noexcept {
        if (fraction_units < 0 || fraction_units >= UnitsPerWhole) return std::nullopt;
        auto base = from_whole(whole);
        if (!base) return std::nullopt;
        rep signed_frac = (whole < 0) ? -fraction_units : fraction_units;
        return ScaledInt{base->raw_ + signed_frac};
    }

    [[nodiscard]] constexpr rep raw()          const noexcept { return raw_; }
    [[nodiscard]] constexpr rep whole_part()   const noexcept { return raw_ / UnitsPerWhole; }
    [[nodiscard]] constexpr rep frac_units()   const noexcept {
        rep r = raw_ % UnitsPerWhole; return r < 0 ? -r : r;
    }
    [[nodiscard]] constexpr double to_double() const noexcept {       // display ONLY
        return static_cast<double>(raw_) / static_cast<double>(UnitsPerWhole);
    }

    friend constexpr auto operator<=>(ScaledInt, ScaledInt) = default;

    // Same-scale add/sub are raw integer ops (still overflow-checkable).
    friend constexpr ScaledInt operator+(ScaledInt a, ScaledInt b) noexcept { return ScaledInt{a.raw_ + b.raw_}; }
    friend constexpr ScaledInt operator-(ScaledInt a, ScaledInt b) noexcept { return ScaledInt{a.raw_ - b.raw_}; }
    friend constexpr ScaledInt operator-(ScaledInt a)              noexcept { return ScaledInt{-a.raw_}; }
    // Scaling by a dimensionless integer keeps the scale.
    friend constexpr ScaledInt operator*(ScaledInt a, rep k)       noexcept { return ScaledInt{a.raw_ * k}; }
    // Deliberately NOT provided: ScaledInt * ScaledInt (result has scale S^2).

    [[nodiscard]] static constexpr std::optional<ScaledInt>
    mul(ScaledInt a, ScaledInt b, Rounding mode) noexcept {           // (a*b)/S
        auto r = muldiv(a.raw_, b.raw_, UnitsPerWhole, mode);
        return r ? std::optional<ScaledInt>{ScaledInt{*r}} : std::nullopt;
    }
    [[nodiscard]] static constexpr std::optional<ScaledInt>
    div(ScaledInt a, ScaledInt b, Rounding mode) noexcept {           // (a*S)/b
        if (b.raw_ == 0) return std::nullopt;
        auto r = muldiv(a.raw_, UnitsPerWhole, b.raw_, mode);
        return r ? std::optional<ScaledInt>{ScaledInt{*r}} : std::nullopt;
    }

private:
    explicit constexpr ScaledInt(rep raw) noexcept : raw_{raw} {}
    static constexpr std::optional<rep> checked_mul(rep a, rep b) noexcept {
        if (a == 0 || b == 0) return rep{0};
        auto r = muldiv(a, b, 1, Rounding::toward_zero);
        return r;
    }
    rep raw_{};
};

using Price2 = ScaledInt<100>;        // 2 decimal places
using Price4 = ScaledInt<10'000>;     // 4 decimal places
using Price8 = ScaledInt<100'000'000>;

static_assert(Price4::from_raw(123'456).raw() == 123'456);        // 12.3456
static_assert(Price4::from_parts(12, 3456)->raw() == 123'456);
static_assert(Price4::from_parts(-12, 3456)->raw() == -123'456);
static_assert(!Price4::from_parts(1, 10'000).has_value());        // fraction too large
static_assert(Price4::from_raw(123'456).whole_part() == 12);
static_assert(Price4::from_raw(123'456).frac_units() == 3456);
```

```cpp
// ---- Cross-scale conversion: never implicit, always named -------------------
template<std::int64_t To, std::int64_t From>
[[nodiscard]] constexpr std::optional<ScaledInt<To>>
rescale(ScaledInt<From> x, Rounding mode) noexcept {
    if constexpr (To >= From) {
        static_assert(To % From == 0 || true);        // widening: multiply
        auto r = muldiv(x.raw(), To, From, mode);     // exact when To % From == 0
        return r ? std::optional{ScaledInt<To>::from_raw(*r)} : std::nullopt;
    } else {
        auto r = muldiv(x.raw(), To, From, mode);     // narrowing: rounding matters
        return r ? std::optional{ScaledInt<To>::from_raw(*r)} : std::nullopt;
    }
}
static_assert(rescale<10'000>(Price2::from_raw(1'234), Rounding::toward_zero)->raw() == 123'400);
static_assert(rescale<100>(Price4::from_raw(123'456), Rounding::floor)->raw() == 1'234);
static_assert(rescale<100>(Price4::from_raw(123'456), Rounding::ceil)->raw()  == 1'235);
static_assert(!rescale<100>(Price4::from_raw(123'456), Rounding::reject_inexact).has_value());

// ---- Decimal text parsing at the boundary (no double, no locale) ------------
#include <charconv>
#include <string_view>
#include <expected>

enum class ParseError : std::uint8_t { empty, bad_char, too_many_decimals, overflow };

template<std::int64_t S>
[[nodiscard]] constexpr std::expected<ScaledInt<S>, ParseError>
parse_decimal(std::string_view text) noexcept {
    if (text.empty()) return std::unexpected(ParseError::empty);
    bool neg = false;
    std::size_t i = 0;
    if (text[0] == '+' || text[0] == '-') { neg = (text[0] == '-'); i = 1; }
    std::int64_t units = 0;
    std::int64_t scale_left = S;
    bool seen_dot = false, seen_digit = false;
    for (; i < text.size(); ++i) {
        char c = text[i];
        if (c == '.') {
            if (seen_dot) return std::unexpected(ParseError::bad_char);
            seen_dot = true; continue;
        }
        if (c < '0' || c > '9') return std::unexpected(ParseError::bad_char);
        seen_digit = true;
        if (seen_dot) {
            if (scale_left % 10 != 0) return std::unexpected(ParseError::too_many_decimals);
            scale_left /= 10;
            if (scale_left == 0) return std::unexpected(ParseError::too_many_decimals);
        }
        if (units > (std::numeric_limits<std::int64_t>::max() - (c - '0')) / 10)
            return std::unexpected(ParseError::overflow);
        units = units * 10 + (c - '0');
    }
    if (!seen_digit) return std::unexpected(ParseError::bad_char);
    auto raw = muldiv(units, scale_left, 1, Rounding::toward_zero);   // scale up remainder
    if (!raw) return std::unexpected(ParseError::overflow);
    return ScaledInt<S>::from_raw(neg ? -*raw : *raw);
}
static_assert(parse_decimal<10'000>("12.3456").value().raw() == 123'456);
static_assert(parse_decimal<10'000>("-12.3").value().raw()   == -123'000);
static_assert(parse_decimal<100>("1.234").error() == ParseError::too_many_decimals);
```

```text
external value        = raw / S
add / sub (same S)    = raw ± raw                       exact, O(1)
mul                   = (a.raw * b.raw) / S             needs 128-bit intermediate
div                   = (a.raw * S) / b.raw             needs 128-bit intermediate + b != 0
rescale S -> S'       = raw * S' / S                    exact iff S | S' ; else rounding
range for S=10^4      ±9.22e18 / 1e4 ≈ ±9.22e14 whole units
```

| Operation | Intermediate width needed | Failure modes |
|---|---|---|
| `a + b` (same scale) | 65-bit | signed overflow (UB) — check first |
| `a * k` (k integer) | 64 + bits(k) | signed overflow |
| `a * b` (both scaled) | 128-bit | overflow of quotient, rounding |
| `a / b` | 128-bit | `b == 0`, overflow, rounding |
| `rescale<To>` | 128-bit | inexact truncation, overflow |
| `to_double()` | — | lossy above 2^53 raw units — display only |

**Traps** — `double` cannot represent 0.1, 0.01, or 0.0001 exactly · `long long` is *not* automatically wide enough for `a*b` · `__int128` is a non-standard extension · `%` on negative operands truncates toward zero, so `floor` needs an explicit correction · `ScaledInt<100>` and `ScaledInt<10'000>` are unrelated types — that is the point · a converting constructor between scales hides the rounding decision · runtime-configured scale cannot protect expressions at compile time, so normalize at the boundary.

---

## 33.3 Enum classes for side, action, status, and time-in-force

```cpp
#include <array>
#include <cstdint>
#include <optional>
#include <string_view>
#include <utility>        // std::to_underlying (C++23)

enum class Side        : std::uint8_t { bid = 0, ask = 1 };
enum class Action      : std::uint8_t { add, modify, remove };
enum class Status      : std::uint8_t { pending, active, complete, rejected };
enum class TimeInForce : std::uint8_t { immediate, session, persistent };

// Unscoped enum for contrast: leaks names, converts implicitly.
enum LegacySide { legacy_bid, legacy_ask };
int n = legacy_bid;                       // implicit → int
// int m = Side::bid;                     // ill-formed: no implicit conversion

static_assert(sizeof(Side) == 1);
static_assert(std::is_same_v<std::underlying_type_t<Side>, std::uint8_t>);

// ---- Explicit enum <-> integer -------------------------------------------
constexpr std::uint8_t raw_side = std::to_underlying(Side::ask);      // C++23 == 1
constexpr std::uint8_t raw_old  = static_cast<std::uint8_t>(Side::ask);
// Representable-but-unnamed value: legal object state, not a named enumerator.
constexpr auto rogue = static_cast<Side>(99);                          // NOT bid or ask

// ---- Validated decode at the untrusted boundary ---------------------------
[[nodiscard]] constexpr std::optional<Side> decode_side(std::uint8_t raw) noexcept {
    switch (raw) {                        // `default` REQUIRED: input is untrusted
        case 0: return Side::bid;
        case 1: return Side::ask;
        default: return std::nullopt;
    }
}
[[nodiscard]] constexpr std::optional<Side> decode_side_char(char c) noexcept {
    switch (c) { case 'B': case '1': return Side::bid;
                 case 'S': case '2': return Side::ask;
                 default: return std::nullopt; }
}
[[nodiscard]] constexpr std::optional<TimeInForce> decode_tif(std::uint8_t raw) noexcept {
    if (raw > std::to_underlying(TimeInForce::persistent)) return std::nullopt;
    return static_cast<TimeInForce>(raw);          // valid: contiguous 0..N range
}

// ---- Exhaustive switch in trusted code: NO default, so -Wswitch fires ------
[[nodiscard]] constexpr Side opposite(Side s) noexcept {
    switch (s) {
        case Side::bid: return Side::ask;
        case Side::ask: return Side::bid;
    }                                     // adding an enumerator → compiler warning
    return Side::bid;                     // silences -Wreturn-type; unreachable
}

[[nodiscard]] constexpr bool is_terminal(Status s) noexcept {
    switch (s) {
        case Status::pending:
        case Status::active:   return false;
        case Status::complete:
        case Status::rejected: return true;
    }
    return false;
}

// ---- Sign convention derived from the enum, not hardcoded at call sites ----
[[nodiscard]] constexpr std::int64_t signed_quantity(Side s, std::uint64_t q) noexcept {
    return (s == Side::bid) ? static_cast<std::int64_t>(q) : -static_cast<std::int64_t>(q);
}

// ---- Name tables: adapters, not part of the type --------------------------
[[nodiscard]] constexpr std::string_view to_string(Action a) noexcept {
    constexpr std::array<std::string_view, 3> names{"add", "modify", "remove"};
    auto i = std::to_underlying(a);
    return i < names.size() ? names[i] : "?";      // tolerate corrupt state
}

// ---- Dense enum-indexed array (no map, no hashing) ------------------------
template<class E, class T, std::size_t N>
class EnumArray {
public:
    constexpr T&       operator[](E e)       noexcept { return data_[std::to_underlying(e)]; }
    constexpr T const& operator[](E e) const noexcept { return data_[std::to_underlying(e)]; }
    constexpr std::size_t size() const noexcept { return N; }
private:
    std::array<T, N> data_{};
};
using SideBook = EnumArray<Side, std::uint64_t, 2>;

// ---- Enum flags: opt in explicitly, never by default ----------------------
enum class OrderFlags : std::uint16_t {
    none = 0, post_only = 1u << 0, reduce_only = 1u << 1, hidden = 1u << 2
};
constexpr OrderFlags operator|(OrderFlags a, OrderFlags b) noexcept {
    return static_cast<OrderFlags>(std::to_underlying(a) | std::to_underlying(b));
}
constexpr OrderFlags operator&(OrderFlags a, OrderFlags b) noexcept {
    return static_cast<OrderFlags>(std::to_underlying(a) & std::to_underlying(b));
}
constexpr OrderFlags& operator|=(OrderFlags& a, OrderFlags b) noexcept { return a = a | b; }
constexpr bool has(OrderFlags set, OrderFlags bit) noexcept { return (set & bit) == bit; }
static_assert(has(OrderFlags::post_only | OrderFlags::hidden, OrderFlags::hidden));
```

| Property | `enum class E : U` | plain `enum E` |
|---|---|---|
| Implicit conversion to integer | no | yes |
| Enumerator name scope | `E::x` only | enclosing scope too |
| Fixed underlying type | yes (defaults to `int`) | only if specified |
| Forward-declarable | yes (underlying type known) | only with explicit `: U` |
| Values limited to enumerators | **no** — any `U` value is representable | no |
| Comparison across enum types | ill-formed | compiles via integer promotion |

**Traps** — `static_cast<Side>(untrusted_byte)` is the single most common validity hole · a `default:` label in trusted code silences the warning that would have caught a new enumerator · flag enums need bitwise operators written by hand · `sizeof(enum class)` follows the underlying type, so omit `: std::uint8_t` and you get 4 bytes · enumerators with non-contiguous values break the `raw <= max` shortcut · `std::to_underlying` is C++23 (`<utility>`).

---

## 33.4 Invalid states, sentinels, `optional`, and explicit validity

```text
valid value      a domain value exists            → T
absent value     no value exists right now        → std::optional<T>
invalid input    conversion/validation failed     → std::expected<T, E>
```

```cpp
#include <expected>
#include <optional>
#include <cassert>
#include <cstdint>
#include <limits>

std::optional<Price>                  best_bid;        // absence is a normal state
std::expected<Price, ParseError>      parsed;          // failure carries a reason

// ---- optional: full surface ----------------------------------------------
std::optional<Price> o;                         // empty
std::optional<Price> o2{std::nullopt};          // empty, explicit
std::optional<Price> o3{Price{100}};            // engaged
std::optional<Price> o4 = std::make_optional<Price>(Price{100});
o.emplace(Price{100});                          // construct in place, no temp
bool eng   = o.has_value();                     // or: if (o)
Price v1   = *o;                                // UB if empty
Price v2   = o.value();                         // throws std::bad_optional_access
Price v3   = o.value_or(Price{0});              // default on empty
auto  ptr  = o.operator->();                    // Price* — UB if empty
o.reset();                                      // → empty, destroys the value
o = std::nullopt;                               // same
// C++23 monadic operations:
auto mapped = o.transform([](Price p) { return p.ticks; });     // optional<int64_t>
auto chained = o.and_then([](Price p) -> std::optional<Price> {
    return p.ticks > 0 ? std::optional{p} : std::nullopt; });
auto fallback = o.or_else([] { return std::optional<Price>{Price{1}}; });

// ---- expected: full surface ----------------------------------------------
std::expected<Price, ParseError> e1{Price{100}};
std::expected<Price, ParseError> e2{std::unexpect, ParseError::bad_char};
std::expected<Price, ParseError> e3 = std::unexpected(ParseError::overflow);
bool ok    = e1.has_value();                    // or: if (e1)
Price w1   = *e1;                               // UB if unexpected
Price w2   = e1.value();                        // throws std::bad_expected_access<E>
ParseError er = e2.error();                     // UB if it holds a value
Price w3   = e1.value_or(Price{0});
ParseError er2 = e1.error_or(ParseError::empty);            // C++23
auto t  = e1.transform([](Price p) { return p.ticks; });     // expected<int64_t, E>
auto te = e1.transform_error([](ParseError) { return 1; });  // expected<Price, int>
auto ae = e1.and_then([](Price p) -> std::expected<Price, ParseError> { return p; });
auto oe = e2.or_else([](ParseError) -> std::expected<Price, ParseError> {
    return Price{0}; });
```

```cpp
// ---- Sentinel done right: encapsulated, never in the public vocabulary ----
class SlotIndex {
public:
    static constexpr std::uint32_t none = std::numeric_limits<std::uint32_t>::max();
    static constexpr std::uint32_t max_valid = none - 1;

    constexpr SlotIndex() noexcept = default;                     // = absent
    [[nodiscard]] static constexpr std::optional<SlotIndex>
    make(std::uint32_t raw) noexcept {
        if (raw > max_valid) return std::nullopt;                 // reject the sentinel
        return SlotIndex{raw};
    }
    [[nodiscard]] static constexpr SlotIndex absent() noexcept { return SlotIndex{}; }

    [[nodiscard]] constexpr bool has_value() const noexcept { return raw_ != none; }
    constexpr explicit operator bool() const noexcept { return has_value(); }
    [[nodiscard]] constexpr std::uint32_t value() const noexcept {
        assert(has_value());
        return raw_;
    }
    [[nodiscard]] constexpr std::uint32_t value_or(std::uint32_t d) const noexcept {
        return has_value() ? raw_ : d;
    }
    friend constexpr bool operator==(SlotIndex, SlotIndex) = default;
private:
    explicit constexpr SlotIndex(std::uint32_t raw) noexcept : raw_{raw} {}
    std::uint32_t raw_{none};
};
static_assert(sizeof(SlotIndex) == 4);                            // vs optional<uint32_t> == 8
static_assert(!SlotIndex{}.has_value());
static_assert(SlotIndex::make(7)->value() == 7);
static_assert(!SlotIndex::make(SlotIndex::none).has_value());

// ---- Wire sentinel decoded ONCE at the adapter ----------------------------
inline constexpr std::int64_t wire_null_price = std::numeric_limits<std::int64_t>::min();

[[nodiscard]] constexpr std::optional<Price> decode_price(std::int64_t wire) noexcept {
    if (wire == wire_null_price) return std::nullopt;   // sentinel dies here
    return Price{wire};                                 // core never sees -1 / INT64_MIN
}
// Core code then reads:  if (auto p = decode_price(w)) use(*p);
// NOT:                   if (price.ticks != -1) ...        // leakage

// ---- Layout comparison ----------------------------------------------------
static_assert(sizeof(std::optional<std::uint32_t>) >= 8);   // value + bool + padding
static_assert(sizeof(std::optional<Price>)         >= 16);
// optional<T&> is C++26; optional<T*> is legal but has TWO empty spellings (bad).
```

```cpp
// ---- Dense alternative: parallel validity bitmap for hot arrays -----------
template<std::size_t N>
class ValidityMask {
public:
    constexpr void set(std::size_t i)   noexcept { bits_[i / 64] |=  (1ull << (i % 64)); }
    constexpr void clear(std::size_t i) noexcept { bits_[i / 64] &= ~(1ull << (i % 64)); }
    [[nodiscard]] constexpr bool test(std::size_t i) const noexcept {
        return (bits_[i / 64] >> (i % 64)) & 1u;
    }
private:
    std::array<std::uint64_t, (N + 63) / 64> bits_{};
};
// Values stay packed; validity costs 1 bit each instead of optional's per-element bool.
```

| Member | `optional<T>` | `expected<T, E>` |
|---|---|---|
| Engaged test | `has_value()`, `operator bool` | `has_value()`, `operator bool` |
| Unchecked access | `*x`, `x->m` (UB if empty) | `*x`, `x->m` (UB if error) |
| Checked access | `value()` → `bad_optional_access` | `value()` → `bad_expected_access<E>` |
| Error access | — | `error()` (UB if valued), `error_or(d)` (C++23) |
| Fallback | `value_or(d)` | `value_or(d)` |
| In-place build | `emplace(args…)`, `std::in_place` | `emplace(args…)`, `std::in_place`/`std::unexpect` |
| Clear | `reset()`, `= std::nullopt` | none — always holds one of the two |
| Monadic | `and_then`/`transform`/`or_else` (C++23) | `and_then`/`transform`/`transform_error`/`or_else` (C++23) |
| Comparison | `<=>` if `T` supports it; empty < engaged | `==` only |
| `void` payload | no | `expected<void, E>` is valid |

**Traps** — `*opt` on an empty optional is UB, not an exception · `optional<bool>` has three states and reads terribly · `if (opt)` tests engagement, not the contained value's truth · `optional<T>` is a program type, never a wire layout · one magic integer serving as both "absent" and "invalid" collapses two distinct error paths · a sentinel steals one value from the domain and pushes a check onto every consumer · `expected` copies/moves the error type, so keep `E` cheap (an enum, not a string).

---

## 33.5 Overflow policy and checked arithmetic

| Operation | Language result |
|---|---|
| Unsigned overflow | wraps modulo 2^N — defined, rarely what you meant |
| Signed overflow | **undefined behavior** (optimizer may assume it cannot happen) |
| `INT_MIN / -1`, `INT_MIN % -1` | undefined behavior |
| Integer division/modulo by zero | undefined behavior |
| Shift by ≥ width, or negative count | undefined behavior |
| Left shift of negative value | defined since C++20 (was UB) |
| Narrowing conversion | signed→ is value-preserving mod 2^N since C++20; **not** a check |
| Signed representation | two's complement is mandated since C++20 |

```cpp
#include <expected>
#include <limits>
#include <optional>
#include <utility>          // std::cmp_*, std::in_range

enum class ArithError : std::uint8_t { overflow, underflow, division_by_zero, not_representable };

// ---- Portable checked primitives: test BEFORE evaluating -----------------
template<std::signed_integral T>
[[nodiscard]] constexpr std::expected<T, ArithError> checked_add(T a, T b) noexcept {
    constexpr T lo = std::numeric_limits<T>::min(), hi = std::numeric_limits<T>::max();
    if (b > 0 && a > hi - b) return std::unexpected(ArithError::overflow);
    if (b < 0 && a < lo - b) return std::unexpected(ArithError::underflow);
    return static_cast<T>(a + b);
}
template<std::signed_integral T>
[[nodiscard]] constexpr std::expected<T, ArithError> checked_sub(T a, T b) noexcept {
    constexpr T lo = std::numeric_limits<T>::min(), hi = std::numeric_limits<T>::max();
    if (b < 0 && a > hi + b) return std::unexpected(ArithError::overflow);
    if (b > 0 && a < lo + b) return std::unexpected(ArithError::underflow);
    return static_cast<T>(a - b);
}
template<std::signed_integral T>
[[nodiscard]] constexpr std::expected<T, ArithError> checked_mul(T a, T b) noexcept {
    constexpr T lo = std::numeric_limits<T>::min(), hi = std::numeric_limits<T>::max();
    if (a == 0 || b == 0) return T{0};
    if (a == -1 && b == lo) return std::unexpected(ArithError::overflow);
    if (b == -1 && a == lo) return std::unexpected(ArithError::overflow);
    if (a > 0) {
        if (b > 0) { if (a > hi / b) return std::unexpected(ArithError::overflow); }
        else       { if (b < lo / a) return std::unexpected(ArithError::underflow); }
    } else {
        if (b > 0) { if (a < lo / b) return std::unexpected(ArithError::underflow); }
        else       { if (a < hi / b) return std::unexpected(ArithError::overflow); }
    }
    return static_cast<T>(a * b);
}
template<std::signed_integral T>
[[nodiscard]] constexpr std::expected<T, ArithError> checked_div(T a, T b) noexcept {
    if (b == 0) return std::unexpected(ArithError::division_by_zero);
    if (b == -1 && a == std::numeric_limits<T>::min())
        return std::unexpected(ArithError::overflow);        // |min| not representable
    return static_cast<T>(a / b);
}
template<std::signed_integral T>
[[nodiscard]] constexpr std::expected<T, ArithError> checked_neg(T a) noexcept {
    if (a == std::numeric_limits<T>::min()) return std::unexpected(ArithError::overflow);
    return static_cast<T>(-a);
}
static_assert(!checked_add<std::int64_t>(INT64_MAX, 1).has_value());
static_assert(checked_add<std::int64_t>(INT64_MAX, -1).value() == INT64_MAX - 1);
static_assert(!checked_mul<std::int32_t>(INT32_MIN, -1).has_value());
static_assert(!checked_div<std::int32_t>(INT32_MIN, -1).has_value());

// ---- Saturating: correct ONLY when clamping is the modeled behavior -------
template<std::signed_integral T>
[[nodiscard]] constexpr T saturating_add(T a, T b) noexcept {
    auto r = checked_add(a, b);
    if (r) return *r;
    return (r.error() == ArithError::overflow) ? std::numeric_limits<T>::max()
                                               : std::numeric_limits<T>::min();
}
static_assert(saturating_add<std::int64_t>(INT64_MAX, 5) == INT64_MAX);

// ---- Wrapping: unsigned only, and only for a modeled modular counter ------
[[nodiscard]] constexpr std::uint32_t wrapping_add(std::uint32_t a, std::uint32_t b) noexcept {
    return a + b;                                            // defined mod 2^32
}
// Sequence-number comparison under wrap (RFC1982-style serial arithmetic):
[[nodiscard]] constexpr bool seq_less(std::uint32_t a, std::uint32_t b) noexcept {
    return static_cast<std::int32_t>(a - b) < 0;             // half-space rule
}
static_assert(seq_less(0xFFFF'FFFFu, 0u));                   // wraps forward

// ---- Widening: preserve the mathematical result --------------------------
[[nodiscard]] constexpr std::int64_t widen_mul(std::int32_t a, std::int32_t b) noexcept {
    return static_cast<std::int64_t>(a) * b;                 // cast BEFORE multiplying
}

// ---- Sign-safe comparison and range test (C++20, <utility>) --------------
static_assert(std::cmp_less(-1, 1u));                        // true; `-1 < 1u` is FALSE
static_assert(!std::in_range<std::uint8_t>(-1));
static_assert(std::in_range<std::uint8_t>(255));

template<std::integral To, std::integral From>
[[nodiscard]] constexpr std::optional<To> narrow(From v) noexcept {
    if (!std::in_range<To>(v)) return std::nullopt;          // validation, not a cast
    return static_cast<To>(v);
}
```

```cpp
// ---- Domain-typed checked operations -------------------------------------
[[nodiscard]] constexpr std::expected<Price, ArithError>
checked_apply(Price p, PriceDelta d) noexcept {
    auto r = checked_add<std::int64_t>(p.ticks, d.ticks);
    if (!r) return std::unexpected(r.error());
    return Price{*r};
}

// ---- Transactional update: strong guarantee by construction --------------
[[nodiscard]] std::expected<void, ArithError>
apply_delta(Price& price, Quantity& qty, PriceDelta d, std::uint64_t add_qty) noexcept {
    auto next_price = checked_apply(price, d);
    if (!next_price) return std::unexpected(next_price.error());
    if (qty.value > std::numeric_limits<std::uint64_t>::max() - add_qty)
        return std::unexpected(ArithError::overflow);
    price     = *next_price;                        // mutate ONLY after all checks pass
    qty.value = qty.value + add_qty;
    return {};
}

// ---- Fail-fast for broken internal invariants (not for input validation) --
[[noreturn]] void invariant_failed(char const* what) noexcept;   // logs, then std::abort
constexpr Price trusted_apply(Price p, PriceDelta d) noexcept {
    auto r = checked_apply(p, d);
    if (!r) invariant_failed("price delta overflow on internal path");
    return *r;
}

// ---- Builtins: fast, but isolate them behind the portable interface -------
#if defined(__GNUC__) || defined(__clang__)
[[nodiscard]] inline bool fast_add(std::int64_t a, std::int64_t b, std::int64_t& out) noexcept {
    return !__builtin_add_overflow(a, b, &out);   // extension: not standard C++23
}
#endif
// C++26 adds <numeric> std::add_sat / sub_sat / mul_sat / div_sat and
// std::ckd_add-style checked ops; until then, own the primitives yourself.
```

| Policy | Use when | Shape |
|---|---|---|
| Reject | result is outside the modeled domain | `expected<T, ArithError>` / `optional<T>` |
| Saturate | clamping is explicitly the correct answer | named `saturating_add` |
| Wrap | value is genuinely modular (seq numbers, hashes) | unsigned type + documented modulus |
| Fail fast | an internal invariant is already broken | assert / terminal handler |
| Widen | the exact mathematical result must survive | return a wider strong type |

**Traps** — `if (a + b < a)` is already UB for signed `a`, `b` · `-fwrapv` makes your build correct and everyone else's not · unsigned wrap is *not* saturation and *not* an error signal · `a * b / c` overflows the product even when the quotient fits · `-1 < 1u` is false because of integral promotion — use `std::cmp_less` · UBSan (`-fsanitize=signed-integer-overflow`) catches these at runtime; the optimizer does not warn · mutating state before all checks pass loses the strong guarantee.

---

## 33.6 Comparison, hashing, formatting, and serialization of strong types

```cpp
#include <compare>
#include <cstdint>
#include <functional>
#include <unordered_map>

// ---- Comparison: pick the weakest category that is honest ----------------
struct A { std::int64_t v; friend constexpr auto operator<=>(A, A) = default; };
        // → std::strong_ordering, plus implicit ==
struct B { double v;       friend constexpr auto operator<=>(B, B) = default; };
        // → std::partial_ordering (NaN), == also defaulted
struct C { std::uint64_t v; friend constexpr bool operator==(C, C) = default; };
        // equality only: NOT orderable, cannot be a std::map key

struct D {                                        // custom: order by one member only
    std::int64_t price; std::uint64_t seq;
    friend constexpr std::strong_ordering operator<=>(D a, D b) noexcept {
        return a.price <=> b.price;               // seq excluded from ordering
    }
    friend constexpr bool operator==(D a, D b) noexcept {   // must be separate:
        return a.price == b.price && a.seq == b.seq;        // == is NOT derived from <=>
    }
};
static_assert(std::is_same_v<decltype(A{} <=> A{}), std::strong_ordering>);
static_assert(std::is_same_v<decltype(B{} <=> B{}), std::partial_ordering>);
// A rewritten `a < b` calls (a <=> b) < 0; `a != b` calls !(a == b).
```

```cpp
// ---- Hashing: option 1, specialize std::hash for YOUR type ---------------
template<>
struct std::hash<OrderId> {
    [[nodiscard]] std::size_t operator()(OrderId id) const noexcept {
        return std::hash<std::uint64_t>{}(id.value);
    }
};
// Requirements: noexcept-preferred, equal keys hash equal, no state, no allocation.

// ---- Option 2 (preferred in libraries): a named hasher outside std -------
struct OrderIdHash {
    using is_transparent = void;                       // enables heterogeneous lookup
    [[nodiscard]] std::size_t operator()(OrderId id)      const noexcept { return mix(id.value); }
    [[nodiscard]] std::size_t operator()(std::uint64_t v) const noexcept { return mix(v); }
    static constexpr std::size_t mix(std::uint64_t x) noexcept {   // splitmix64 finalizer
        x ^= x >> 30; x *= 0xBF58'476D'1CE4'E5B9ull;
        x ^= x >> 27; x *= 0x94D0'49BB'1331'11EBull;
        x ^= x >> 31; return static_cast<std::size_t>(x);
    }
};
struct OrderIdEq {
    using is_transparent = void;
    constexpr bool operator()(OrderId a, OrderId b)      const noexcept { return a.value == b.value; }
    constexpr bool operator()(OrderId a, std::uint64_t b) const noexcept { return a.value == b; }
};
std::unordered_map<OrderId, Price, OrderIdHash, OrderIdEq> book;
// book.find(std::uint64_t{7});    // no OrderId temporary (C++20 heterogeneous lookup)

// ---- Multi-member hash combine -------------------------------------------
constexpr std::size_t hash_combine(std::size_t seed, std::size_t h) noexcept {
    return seed ^ (h + 0x9E37'79B9'7F4A'7C15ull + (seed << 6) + (seed >> 2));
}
struct HandleHash {
    std::size_t operator()(Handle h) const noexcept;   // defined in 33.8
};
```

```cpp
// ---- Formatting: an adapter. std::formatter for diagnostics -------------
#include <format>
#include <charconv>
#include <span>
#include <string_view>

template<>
struct std::formatter<Price> {
    bool with_ticks = false;
    constexpr auto parse(std::format_parse_context& ctx) {
        auto it = ctx.begin();
        if (it != ctx.end() && *it == 't') { with_ticks = true; ++it; }
        if (it != ctx.end() && *it != '}') throw std::format_error("bad Price spec");
        return it;
    }
    auto format(Price p, std::format_context& ctx) const {
        return with_ticks ? std::format_to(ctx.out(), "{}t", p.ticks)
                          : std::format_to(ctx.out(), "{}", p.ticks);
    }
};
// std::format("{} {:t}", Price{5}, Price{5});   // "5 5t"

template<std::int64_t S>
struct std::formatter<ScaledInt<S>> {
    constexpr auto parse(std::format_parse_context& ctx) { return ctx.begin(); }
    auto format(ScaledInt<S> x, std::format_context& ctx) const {
        auto raw = x.raw();
        char sign = raw < 0 ? '-' : '+';
        std::uint64_t mag = raw < 0 ? -static_cast<std::uint64_t>(raw) : raw;
        return std::format_to(ctx.out(), "{}{}.{:0{}}",
                              sign == '-' ? "-" : "", mag / S, mag % S, digits());
    }
    static constexpr int digits() noexcept {
        int d = 0; for (std::int64_t s = S; s > 1; s /= 10) ++d; return d;
    }
};

// ---- Bounded hot-path formatting: to_chars, no allocation, no locale ----
[[nodiscard]] inline std::string_view
write_price(std::span<char> out, Price4 p) noexcept {
    auto raw = p.raw();
    char* it = out.data();
    char* const end = out.data() + out.size();
    if (raw < 0) { *it++ = '-'; }
    std::uint64_t mag = raw < 0 ? -static_cast<std::uint64_t>(raw)
                                : static_cast<std::uint64_t>(raw);
    auto w = std::to_chars(it, end, mag / Price4::units_per_whole);
    if (w.ec != std::errc{}) return {};
    it = w.ptr;
    if (it == end) return {};
    *it++ = '.';
    std::uint64_t frac = mag % Price4::units_per_whole;
    for (std::int64_t s = Price4::units_per_whole / 10; s >= 1; s /= 10) {
        if (it == end) return {};
        *it++ = static_cast<char>('0' + (frac / s) % 10);
    }
    return std::string_view{out.data(), static_cast<std::size_t>(it - out.data())};
}
// to_chars: locale-independent, non-allocating, no exceptions, returns {ptr, ec}.
```

```cpp
// ---- Serialization: explicit fields, explicit width, explicit order -----
#include <bit>
#include <cstring>

class ByteWriter {
public:
    explicit ByteWriter(std::span<std::byte> buf) noexcept : buf_{buf} {}
    [[nodiscard]] bool put_u8(std::uint8_t v) noexcept { return raw(&v, 1); }
    [[nodiscard]] bool put_u32_le(std::uint32_t v) noexcept {
        std::byte b[4]{ std::byte(v), std::byte(v >> 8), std::byte(v >> 16), std::byte(v >> 24) };
        return raw(b, 4);
    }
    [[nodiscard]] bool put_i64_le(std::int64_t s) noexcept {
        auto v = static_cast<std::uint64_t>(s);           // well-defined since C++20
        std::byte b[8];
        for (int i = 0; i < 8; ++i) b[i] = std::byte((v >> (8 * i)) & 0xFF);
        return raw(b, 8);
    }
    [[nodiscard]] std::size_t written() const noexcept { return pos_; }
private:
    bool raw(void const* p, std::size_t n) noexcept {
        if (pos_ + n > buf_.size()) return false;
        std::memcpy(buf_.data() + pos_, p, n);
        pos_ += n;
        return true;
    }
    std::span<std::byte> buf_;
    std::size_t pos_{};
};

// The encoder knows the wire; Price knows nothing about it.
[[nodiscard]] inline bool encode_price(ByteWriter& out, Price p) noexcept {
    return out.put_i64_le(p.ticks);                       // width + order stated here
}
[[nodiscard]] inline bool encode_side(ByteWriter& out, Side s) noexcept {
    return out.put_u8(std::to_underlying(s));
}

// Decode: read bytes, validate, THEN construct the domain type.
[[nodiscard]] inline std::optional<Side>
decode_side_bytes(std::span<std::byte const> in) noexcept {
    if (in.empty()) return std::nullopt;
    return decode_side(std::to_integer<std::uint8_t>(in[0]));
}

// NEVER:
//   write(fd, &event, sizeof event);        // padding + endianness + ABI on the wire
//   std::memcpy(wire, &event, sizeof event);
// Trivially copyable authorizes object-representation copies INSIDE one program;
// it does not define an interoperable byte encoding.

// Endianness helpers
static_assert(std::endian::native == std::endian::little || std::endian::native == std::endian::big);
constexpr std::uint32_t swapped = std::byteswap(std::uint32_t{0x1234'5678});   // C++23
```

| Facility | Header | Notes |
|---|---|---|
| `operator<=>` defaulted | `<compare>` | member-wise, lexicographic; category = weakest member's |
| `std::strong_ordering` / `weak_` / `partial_` | `<compare>` | `partial` when any member is floating point |
| `std::is_eq/neq/lt/gt/lteq/gteq(c)` | `<compare>` | test a comparison-category result |
| `std::hash<T>` specialization | `<functional>` | only for user-defined `T`; must be `noexcept` in practice |
| `is_transparent` on hasher + equality | — | enables heterogeneous `find`/`count`/`contains` (C++20) |
| `std::formatter<T>` | `<format>` | `parse` is `constexpr`, `format` is `const` |
| `std::format_to_n(out, n, fmt, …)` | `<format>` | bounded, returns `{out, size}` |
| `std::to_chars` / `std::from_chars` | `<charconv>` | locale-free, non-allocating, non-throwing |
| `std::bit_cast<To>(x)` | `<bit>` | same size, both trivially copyable, `constexpr` |
| `std::byteswap(x)` | `<bit>` | C++23 |
| `std::endian::native` | `<bit>` | C++20 |
| `std::has_unique_object_representations_v<T>` | `<type_traits>` | precondition for hashing raw bytes |

**Traps** — specializing `std::hash` for a type you do not own is UB · a hash that ignores a member used by `==` is still *correct*, one that ignores nothing but hashes unequal for equal keys is broken · identity hash + `unordered_map` gives adversarial worst-case chains · `unordered_map` iteration order is not a persistence format · defaulted `<=>` on a `double` member yields `partial_ordering`, which does not satisfy `std::totally_ordered` and breaks `std::map` · `std::format` allocates a `string`; use `format_to_n` or `to_chars` on the hot path · `memcpy` of a struct with padding leaks indeterminate bytes onto the wire.

---

## 33.7 Units, tick sizes, and compile-time scale

```text
scale         how a raw integer maps to one whole external unit   (raw / S)
tick quantum  which raw multiples this instrument permits         (raw % Q == 0)
lot size      which raw quantity multiples are permitted          (qty % L == 0)
```

```cpp
#include <cstdint>
#include <optional>

// ---- Compile-time scale AND quantum ---------------------------------------
template<std::int64_t Scale, std::int64_t TickQuantum>
class QuantizedPrice {
    static_assert(Scale > 0,        "scale must be positive");
    static_assert(TickQuantum > 0,  "quantum must be positive");
public:
    static constexpr std::int64_t scale   = Scale;
    static constexpr std::int64_t quantum = TickQuantum;

    constexpr QuantizedPrice() = default;

    [[nodiscard]] static constexpr std::optional<QuantizedPrice>
    from_raw(std::int64_t raw) noexcept {
        if (raw % TickQuantum != 0) return std::nullopt;      // invariant: on the grid
        return QuantizedPrice{raw};
    }
    // Snap an off-grid raw value with a named rounding direction.
    [[nodiscard]] static constexpr std::optional<QuantizedPrice>
    snap(std::int64_t raw, Rounding mode) noexcept {
        auto ticks = divide_rounded(raw, TickQuantum, mode);
        if (!ticks) return std::nullopt;
        auto r = checked_mul<std::int64_t>(*ticks, TickQuantum);
        if (!r) return std::nullopt;
        return QuantizedPrice{*r};
    }
    [[nodiscard]] constexpr std::int64_t raw()      const noexcept { return raw_; }
    [[nodiscard]] constexpr std::int64_t in_ticks() const noexcept { return raw_ / TickQuantum; }

    // Index arithmetic on the tick grid is exact and allocation-free.
    [[nodiscard]] static constexpr QuantizedPrice from_ticks(std::int64_t t) noexcept {
        return QuantizedPrice{t * TickQuantum};
    }
    friend constexpr auto operator<=>(QuantizedPrice, QuantizedPrice) = default;
private:
    explicit constexpr QuantizedPrice(std::int64_t raw) noexcept : raw_{raw} {}
    std::int64_t raw_{};
};

using EquityPrice = QuantizedPrice<10'000, 100>;    // 4dp scale, 0.01 tick
using FuturePrice = QuantizedPrice<10'000, 25>;     // 4dp scale, 0.0025 tick

static_assert(EquityPrice::from_raw(123'400).has_value());
static_assert(!EquityPrice::from_raw(123'456).has_value());        // off grid
static_assert(EquityPrice::snap(123'456, Rounding::floor)->raw() == 123'400);
static_assert(EquityPrice::snap(123'456, Rounding::ceil)->raw()  == 123'500);
static_assert(EquityPrice::from_raw(123'400)->in_ticks() == 1'234);
// EquityPrice{} == FuturePrice{};   // ill-formed: unrelated types
```

```cpp
// ---- Dense ladder indexing built on the tick grid --------------------------
template<class P>
class TickLadder {                                    // P = a QuantizedPrice type
public:
    constexpr TickLadder(P base, std::size_t levels) : base_{base}, qty_(levels) {}
    [[nodiscard]] constexpr std::optional<std::size_t> index_of(P p) const noexcept {
        std::int64_t d = p.in_ticks() - base_.in_ticks();
        if (d < 0 || static_cast<std::size_t>(d) >= qty_.size()) return std::nullopt;
        return static_cast<std::size_t>(d);
    }
    [[nodiscard]] constexpr P price_at(std::size_t i) const noexcept {
        return P::from_ticks(base_.in_ticks() + static_cast<std::int64_t>(i));
    }
private:
    P base_;
    std::vector<std::uint64_t> qty_;
};
```

```cpp
// ---- Runtime-configured scale: when the set of scales is open -------------
// Compile-time parameters cannot express per-instrument config loaded at startup.
// Solution: a runtime converter at the boundary, normalizing to ONE internal scale.
class ScaleAdapter {
public:
    static constexpr std::int64_t internal_scale = 100'000'000;   // 8dp everywhere inside

    constexpr ScaleAdapter(std::int64_t wire_scale, std::int64_t tick_quantum) noexcept
        : wire_scale_{wire_scale}, quantum_{tick_quantum} {}

    [[nodiscard]] constexpr std::optional<ScaledInt<internal_scale>>
    to_internal(std::int64_t wire_raw, Rounding mode) const noexcept {
        auto r = muldiv(wire_raw, internal_scale, wire_scale_, mode);
        return r ? std::optional{ScaledInt<internal_scale>::from_raw(*r)} : std::nullopt;
    }
    [[nodiscard]] constexpr std::optional<std::int64_t>
    to_wire(ScaledInt<internal_scale> v, Rounding mode) const noexcept {
        return muldiv(v.raw(), wire_scale_, internal_scale, mode);
    }
    [[nodiscard]] constexpr bool on_grid(std::int64_t wire_raw) const noexcept {
        return wire_raw % quantum_ == 0;
    }
private:
    std::int64_t wire_scale_;
    std::int64_t quantum_;
};
// Inside the core: exactly one scale, no per-instrument branching, no template blowup.
```

```cpp
// ---- Unit tags: catch cross-dimension mistakes at compile time ------------
template<int Price_, int Qty_, int Time_>
struct Dim { static constexpr int price = Price_, qty = Qty_, time = Time_; };

template<class D>
struct Measure {
    std::int64_t raw{};
    using dim = D;
    friend constexpr auto operator<=>(Measure, Measure) = default;
    friend constexpr Measure operator+(Measure a, Measure b) noexcept { return {a.raw + b.raw}; }
};
template<class DA, class DB>
constexpr auto operator*(Measure<DA> a, Measure<DB> b) noexcept
    -> Measure<Dim<DA::price + DB::price, DA::qty + DB::qty, DA::time + DB::time>> {
    return {a.raw * b.raw};                            // scale handling omitted for brevity
}
using PriceDim  = Measure<Dim<1, 0, 0>>;
using QtyDim    = Measure<Dim<0, 1, 0>>;
using NotionalD = Measure<Dim<1, 1, 0>>;
static_assert(std::is_same_v<decltype(PriceDim{} * QtyDim{}), NotionalD>);
// PriceDim{} + QtyDim{};   // ill-formed: different types
```

| Approach | Enforcement | Cost |
|---|---|---|
| Template scale (`ScaledInt<S>`) | compile time; mixing is a type error | one instantiation per scale |
| Template scale + quantum | compile time; grid membership checked at construction | instantiation × scale × quantum |
| Runtime scale field | runtime branch; no expression-level protection | 8 bytes per value or per instrument |
| Boundary adapter + one internal scale | compile time inside, runtime at the edge | one conversion per boundary crossing |
| Dimension-tagged `Measure` | compile time across dimensions | template complexity, error-message noise |

**Traps** — scale and quantum are different questions and conflating them yields a type that cannot express "4 decimal places, half-cent ticks" · template scale explodes instantiations when instruments are config-driven · `raw % Q == 0` is not a rounding policy — pair it with a named `snap` · negative `raw % Q` in C++ is truncated toward zero, so `floor`-snapping a negative price needs the corrected division · `[[no_unique_address]]` does nothing for an integer wrapper; it helps empty *policy* members.

---

## 33.8 Compact IDs and generation counters

```cpp
#include <array>
#include <cstdint>
#include <optional>
#include <vector>
#include <cassert>
#include <new>            // std::launder
#include <memory>         // std::construct_at, std::destroy_at

// ---- The handle: index + generation, 8 bytes ------------------------------
struct Handle {
    std::uint32_t index{};
    std::uint32_t generation{};       // 0 is reserved for "never allocated"
    friend constexpr auto operator==(Handle, Handle) -> bool = default;
    [[nodiscard]] constexpr bool is_null() const noexcept { return generation == 0; }
    static constexpr Handle null() noexcept { return Handle{0, 0}; }
};
static_assert(sizeof(Handle) == 8);
static_assert(std::is_trivially_copyable_v<Handle>);
static_assert(std::has_unique_object_representations_v<Handle>);   // no padding

struct HandleHash {
    [[nodiscard]] std::size_t operator()(Handle h) const noexcept {
        std::uint64_t x = (static_cast<std::uint64_t>(h.generation) << 32) | h.index;
        return OrderIdHash::mix(x);
    }
};

// ---- Packed 32-bit variant when memory is tight ---------------------------
class PackedHandle {                       // 24-bit index (16M slots), 8-bit generation
public:
    static constexpr std::uint32_t index_bits = 24;
    static constexpr std::uint32_t index_mask = (1u << index_bits) - 1;
    static constexpr std::uint32_t max_index  = index_mask;
    static constexpr std::uint32_t max_gen    = 0xFFu;

    constexpr PackedHandle() noexcept = default;
    [[nodiscard]] static constexpr std::optional<PackedHandle>
    make(std::uint32_t idx, std::uint32_t gen) noexcept {
        if (idx > max_index || gen > max_gen) return std::nullopt;
        return PackedHandle{(gen << index_bits) | idx};
    }
    [[nodiscard]] constexpr std::uint32_t index()      const noexcept { return bits_ & index_mask; }
    [[nodiscard]] constexpr std::uint32_t generation() const noexcept { return bits_ >> index_bits; }
    friend constexpr bool operator==(PackedHandle, PackedHandle) = default;
private:
    explicit constexpr PackedHandle(std::uint32_t bits) noexcept : bits_{bits} {}
    std::uint32_t bits_{};
};
static_assert(sizeof(PackedHandle) == 4);
static_assert(PackedHandle::make(5, 3)->index() == 5);
static_assert(PackedHandle::make(5, 3)->generation() == 3);
// 8-bit generation wraps after 255 reuses of the same slot — an explicit tradeoff.
```

```cpp
// ---- The slot pool: complete, allocation-free after construction ---------
template<class T>
class SlotPool {
public:
    explicit SlotPool(std::uint32_t capacity)
        : slots_(capacity), free_head_{invalid} {
        assert(capacity > 0 && capacity < invalid);
        for (std::uint32_t i = capacity; i-- > 0; ) {   // build the free list in order
            slots_[i].next_free = free_head_;
            free_head_ = i;
        }
        free_count_ = capacity;
    }
    SlotPool(SlotPool const&) = delete;
    SlotPool& operator=(SlotPool const&) = delete;
    ~SlotPool() { for (auto& s : slots_) if (s.occupied) std::destroy_at(s.ptr()); }

    template<class... Args>
    [[nodiscard]] std::optional<Handle> acquire(Args&&... args) {
        if (free_head_ == invalid) return std::nullopt;         // pool exhausted
        std::uint32_t idx = free_head_;
        Slot& s = slots_[idx];
        free_head_ = s.next_free;
        --free_count_;
        std::construct_at(s.ptr(), std::forward<Args>(args)...); // may throw
        s.occupied = true;
        if (s.generation == 0) s.generation = 1;                 // skip the null gen
        return Handle{idx, s.generation};
    }

    bool release(Handle h) noexcept {
        Slot* s = validated(h);
        if (s == nullptr) return false;                          // stale or bogus
        std::destroy_at(s->ptr());
        s->occupied = false;
        s->generation = next_generation(s->generation);          // invalidate old handles
        s->next_free = free_head_;
        free_head_ = static_cast<std::uint32_t>(s - slots_.data());
        ++free_count_;
        return true;
    }

    // Three-part validation: bounds, occupancy, generation.
    [[nodiscard]] T* get(Handle h) noexcept {
        Slot* s = validated(h);
        return s ? s->ptr() : nullptr;
    }
    [[nodiscard]] T const* get(Handle h) const noexcept {
        return const_cast<SlotPool*>(this)->get(h);
    }
    [[nodiscard]] bool alive(Handle h) const noexcept {
        return const_cast<SlotPool*>(this)->validated(h) != nullptr;
    }
    // Precondition-carrying fast path for a handle validated moments ago.
    [[nodiscard]] T& get_unchecked(Handle h) noexcept {
        assert(alive(h));
        return *slots_[h.index].ptr();
    }

    [[nodiscard]] std::uint32_t capacity()  const noexcept { return static_cast<std::uint32_t>(slots_.size()); }
    [[nodiscard]] std::uint32_t free_slots() const noexcept { return free_count_; }
    [[nodiscard]] std::uint32_t live()       const noexcept { return capacity() - free_count_; }

private:
    static constexpr std::uint32_t invalid = 0xFFFF'FFFFu;

    struct Slot {
        alignas(T) std::byte storage[sizeof(T)];
        std::uint32_t generation{1};
        std::uint32_t next_free{invalid};
        bool occupied{false};
        T* ptr() noexcept { return std::launder(reinterpret_cast<T*>(storage)); }
    };

    [[nodiscard]] Slot* validated(Handle h) noexcept {
        if (h.index >= slots_.size()) return nullptr;            // 1. bounds
        Slot& s = slots_[h.index];
        if (!s.occupied) return nullptr;                         // 2. occupancy
        if (s.generation != h.generation) return nullptr;        // 3. generation
        return &s;
    }
    static constexpr std::uint32_t next_generation(std::uint32_t g) noexcept {
        std::uint32_t n = g + 1;
        return n == 0 ? 1u : n;                                  // never return the null gen
    }

    std::vector<Slot> slots_;
    std::uint32_t free_head_{invalid};
    std::uint32_t free_count_{};
};

// ---- Usage ---------------------------------------------------------------
struct Order { OrderId id; Price price; Quantity qty; Side side; };

inline void demo() {
    SlotPool<Order> pool{1024};
    auto h = pool.acquire(Order{OrderId{7}, Price{100}, Quantity{5}, Side::bid});
    assert(h);
    Order* o = pool.get(*h);          // validated access
    assert(o != nullptr);
    pool.release(*h);
    assert(pool.get(*h) == nullptr);  // stale handle detected: generation advanced
}
```

```text
Handle validation, in order:
  1. h.index < capacity            → rejects garbage / out-of-range
  2. slot.occupied                 → rejects released slots
  3. slot.generation == h.gen      → rejects reuse-after-release aliasing

Generation width vs stale-handle lifetime:
  8-bit   256 reuses per slot before a false positive          packed handles
  16-bit  65 536 reuses                                        moderate churn
  32-bit  4.29e9 reuses; at 1M releases/s on one slot ≈ 71 min  default choice
Sizing rule: gen_period > (max stale-handle lifetime) x (reuse rate of one slot).
```

| Reference form | Size | Stale detection | Main constraint |
|---|---|---|---|
| `T*` | 8 | none | dangles on reuse; storage must not relocate |
| `std::uint32_t` index | 4 | bounds only | silently addresses the *wrong* object after reuse |
| `PackedHandle` (24+8) | 4 | until generation wraps (256) | capacity and churn limits |
| `Handle` (32+32) | 8 | until generation wraps (2^32) | one validation per access |
| `std::shared_ptr<T>` | 16 | lifetime-managed (no staleness) | control block, atomic refcount, allocation |
| `std::weak_ptr<T>` | 16 | yes, via `lock()` | atomic ops on every access |

```cpp
// ---- Intrusive index links: pointers would dangle across vector growth ---
struct OrderNode {
    Order        order;
    std::uint32_t next{Handle::null().index};   // index, NOT pointer — survives realloc
    std::uint32_t prev{};
    std::uint32_t generation{};
};
// A price level owns a doubly-linked chain of indices into one flat pool:
// O(1) insert/erase, one cache line per node, zero per-order allocation.

// ---- ID assignment: monotonic, never reused ------------------------------
class IdGenerator {
public:
    [[nodiscard]] constexpr OrderId next() noexcept { return OrderId{++counter_}; }
    // 64-bit at 10M ids/s exhausts in ~58 000 years — wrap is not a design concern.
private:
    std::uint64_t counter_{0};                   // 0 stays reserved as "no id"
};
```

**Traps** — handing out a raw `T*` *and* a generation handle defeats the whole scheme: the caller keeps the pointer past release · generation `0` must be reserved or a value-initialized `Handle` aliases a live slot · advancing the generation *before* destroying the object opens a window where a concurrent reader sees a valid generation on a dead object · `std::vector<Slot>` growth relocates storage, so never cache `Slot*` across `acquire` · a handle is not thread-safe by itself — validation and use are two steps, and a concurrent `release` between them is a race · 8-bit generations wrap fast under churn · comparing handles across two different pools is meaningless, so keep the pool identity in the type, not in the handle.

---

**Interview line** — "A strong domain type gives one meaning, one unit, an invariant established at a single boundary, and only the operations that mean something — while staying completely ignorant of the wire format, text spelling, sentinel conventions, and clock calibration that surround it."

```text
alias                 same type; zero domain separation
strong wrapper        distinct type; explicit ctor; narrow capability set; same codegen
invariant             established once at a boundary; private ctor + static factory
affine pair           coordinate ± delta = coordinate; coordinate − coordinate = delta
fixed point           scaled integer; scale, rounding, range, overflow are all policy
signed overflow       UB — test before evaluating, never after
unsigned overflow     defined mod 2^N; use only for genuinely modular values
absence               std::optional<T>
invalid input         std::expected<T, E>
enum class            scoped, no implicit int conversion, unnamed values still possible
timestamp             chrono duration for units + distinct wrapper per clock domain
hashing               std::hash only for your own types; equal keys hash equal
serialization         explicit width/order/version; never a native object dump
compact handle        index + generation; validate bounds, occupancy, generation
hot-path target       small trivially copyable values, by-value passing, no allocation
boundary rule         wire/text/config/sentinel quirks stop at the adapter
```
