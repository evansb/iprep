# Chapter 34 — Prices, Quantities, and Numerical Correctness

Trading arithmetic fails most dangerously when a plausible number is wrong. Binary floating point is not inherently unsuitable, and integer arithmetic is not inherently safe: the result depends on scale, range, rounding, overflow, and reproducibility policy. This chapter turns those policies into explicit representations and checked boundaries, then separates the language guarantees from compiler and hardware behavior that can change performance or results. Every such contract must be testable.

## 34.1 Prices as Integer Ticks

A **tick** is the smallest permitted price increment for an instrument under a particular market rule. Storing a price as an integer tick count makes every representable value an exact multiple of that increment.

```cpp
#include <compare>
#include <cstdint>

struct PriceTicks {
    std::int64_t value{};
    auto operator<=>(const PriceTicks&) const = default;
};

constexpr PriceTicks bid{101'237};
constexpr PriceTicks ask{101'238};
static_assert(bid < ask);
```

The value `101'237` has no complete meaning without instrument metadata. For one instrument it may denote 101.237 units; for another, 10,123.7. The tick size can also change after a corporate action or venue rule change. Store or resolve the instrument and rule version alongside the number at system boundaries.

Integer comparison is exact and total for ordinary signed values. Addition and subtraction are simple instructions on common targets, but C++ signed overflow is undefined behavior. A tick representation therefore needs a proven range or checked arithmetic; replacing `double` with `int64_t` does not finish the design.

Ticks are especially useful inside an order book. If the book's base price is `p0`, a level can be mapped to `price_ticks - p0` after checking both subtraction and range. That mapping avoids repeated decimal parsing and makes adjacent legal prices adjacent integers. Chapter 36 develops the corresponding data structures.

Some products have tiered tick schedules: the permitted increment depends on price. One global scale can still represent every legal value if it uses the smallest required quantum, but many representable integers will then be illegal. Validation must consult the schedule; the integer type alone cannot prove that an order price is venue-valid.

Not every increment has a finite decimal expansion. A product quoted in rational fractions can be represented as integer quanta with a rational scale, such as units of `1/32`, without passing through decimal floating point. Store the numerator count and keep the scale in reference data. Display formatting performs quotient and remainder operations outside the matching path.

Absence is not a price. Reserving `INT64_MIN` as “no quote” reduces the arithmetic domain and makes accidental arithmetic on absence look like a real extreme value. Prefer `optional<PriceTicks>` at interfaces or a separate validity bit in a densely packed structure. Measure the representation, but keep the state distinction explicit.

Memory is straightforward. `PriceTicks` above ordinarily occupies the storage and alignment of `int64_t`, although C++ guarantees behavior rather than a particular ABI wrapper layout. Passing a small wrapper by value commonly generates the same register operations as passing its member. Verify with `static_assert(sizeof(...))` only when the chosen ABI is an explicit deployment assumption, and inspect optimized assembly for hot interfaces.

## 34.2 Explicit Quantity and Notional Scales

A **scale** states how an integer maps to a business unit. Quantity, price, rate, and money can all be integers while using different scales. Combining them without an explicit dimensional rule produces exact nonsense.

Suppose a price is stored in hundredths of a currency unit and quantity in thousandths of an asset unit:

```text
price_raw      = currency units × 100
quantity_raw   = asset units × 1,000
product_raw    = notional × 100,000
```

The raw product has the product of the two scales. It must not be labeled as cents or whole currency units until a conversion divides by the appropriate factor under an explicit rounding rule.

Distinct wrapper types prevent accidental addition of incompatible values:

```cpp
#include <cstdint>

struct QuantityMilli { std::int64_t value{}; };
struct MoneyCents    { std::int64_t value{}; };

// No operator+ exists between QuantityMilli and MoneyCents.
```

Strong types do not require run-time tags or virtual dispatch. They can be zero-overhead abstractions after inlining. They do increase the number of overloads and template instantiations, so keep the unit system small and domain-driven rather than building unrestricted compile-time algebra.

Scale metadata can be compile-time or run-time. A currency ledger may use a fixed compile-time minor-unit scale. A multi-instrument feed often supplies price exponents at logon or in reference data; conversion then uses validated run-time metadata. Cache the resolved multiplier with the instrument record rather than performing string lookup or exponentiation for every message.

Quantity semantics require more than decimals. Lots, contract multipliers, display quantities, and odd-lot rules are separate concepts. Use names such as `Contracts`, `Shares`, and `QuantityAtoms` where confusing them would matter. A notional may need a currency tag and an FX conversion timestamp; a bare integer cannot express either.

Conversions are API boundaries. Document whether a function accepts raw protocol units, normalized internal units, or display units. Make lossy conversion return an error or a rounded result carrying the applied policy. An implicit constructor from `double` hides all three decisions—scale, range, and rounding—and should not exist on a critical money type.

Scale conversion has three cases. Multiplying by an integer factor is exact if the wider result fits. Dividing by a factor is exact only when the remainder is zero; otherwise a rounding rule is required. Converting between unrelated rational scales may require both multiplication and division, so choose operation order and intermediate width to avoid overflow without prematurely discarding the remainder.

Reference-data changes need an epoch. If an instrument's scale changes, outstanding orders and persisted state cannot be reinterpreted in place merely by updating one multiplier. Either convert state under a checked migration at a controlled boundary or retain the scale/version with each affected record. Replay must load the reference-data version that was active for the event.

A dimensional table makes code review concrete:

| Operation | Input units | Exact raw output scale |
|---|---|---|
| Price difference | price, price | price scale |
| Notional | price, quantity | price scale × quantity scale |
| Fee | notional, rate | notional scale × rate scale |
| Average price | notional, quantity | requires division and rounding |

The table exposes where widening and rounding enter. It also prevents an apparently convenient operator from returning the wrong domain type.

## 34.3 Wider Intermediates and Overflow Analysis

An arithmetic operation must be safe in the type in which C++ evaluates it, not merely in the destination type. Widen operands before multiplication.

```cpp
#include <cstdint>

std::int64_t broken_notional(std::int32_t price, std::int32_t quantity) {
    // BROKEN: multiplication occurs in int32_t before conversion.
    return price * quantity;
}

std::int64_t wider_notional(std::int32_t price, std::int32_t quantity) {
    return std::int64_t{price} * std::int64_t{quantity};
}
```

The second function is safe only if the product of the permitted input ranges fits `int64_t`. Derive that bound from business limits. If `|price| <= P` and `|quantity| <= Q`, require `P * Q <= INT64_MAX`; do not test the product in the narrow type to discover overflow after it has happened.

Division-based prechecks can avoid overflow, but signed endpoints need careful handling. Negating `INT64_MIN` is itself unrepresentable. A portable design can split by operand signs and compare against `min / operand` or `max / operand`, with explicit cases for zero and `-1`. Compiler built-ins such as GCC and Clang's `__builtin_mul_overflow` are useful, but they are implementation extensions and should sit behind a tested wrapper.

```cpp
#include <cstdint>

bool checked_mul(std::int64_t a, std::int64_t b, std::int64_t& out) noexcept {
#if defined(__GNUC__) || defined(__clang__)
    return !__builtin_mul_overflow(a, b, &out);
#else
    // Portable fallback belongs here and must cover every signed endpoint.
    // This excerpt deliberately refuses an unverified fallback.
    (void)a; (void)b; (void)out;
    return false;
#endif
}
```

The `out` parameter is written only according to the selected wrapper's documented contract. A production abstraction should return a named status so that `true` cannot be misread as “overflow occurred.” C++26 adds standard checked-integer arithmetic facilities; a C++23 codebase still needs its own portability layer or a vetted library.

GCC and Clang support `__int128` on many 64-bit targets. It is a convenient intermediate for multiplying two 64-bit values, but it is not a standard C++ type, has ABI and library limitations, and may compile into several machine instructions or helper calls for division. Keep it inside implementation files and expose standard-width results.

Overflow analysis includes accumulators. A per-order notional may fit while summing a day's volume does not. State maximum event count, maximum magnitude, and reset interval. Saturation is not a neutral repair: it destroys information and may make a risk limit appear exactly reached rather than exceeded. For risk checks, an overflow should normally take the conservative failure path and emit a diagnostic outside the hot operation.

Unsigned arithmetic wraps modulo `2^N` by C++ definition. That can be correct for protocol sequence arithmetic designed around a modulus. It is usually wrong for money, where wrap produces a small plausible value. Choose unsigned for a modular domain, not as a way to make overflow defined.

Addition and subtraction need checks too. The expression `max - b` used in a precheck must itself be representable; split on the sign of `b`, as the fixed-point type in Section 34.9 does. Absolute-value shortcuts are hazardous because the magnitude of the most negative two's-complement value is not representable in the same signed type.

Bounds should be carried through formulas. If a risk value is `sum(price_i * quantity_i)` over at most `N` positions, one conservative proof is `N * P * Q <= max`. A tighter proof may use gross and net position limits. Conservative bounds can force a wider accumulator or lower configured capacity, but they are auditable and independent of observed historical values.

Checked arithmetic changes control flow. A compiler built-in commonly becomes an arithmetic instruction plus an overflow-flag branch on x86-64, while a 128-bit division can require a helper routine. These are implementation observations. Compile the exact type and target, inspect assembly, and ensure the failure branch does not allocate or synchronously log.

Verification should exercise boundaries mechanically: zero, one, minus one, minimum, maximum, values just inside the accepted business range, and products one unit beyond it. Use UndefinedBehaviorSanitizer for signed-overflow mistakes in test builds, while recognizing that the checks add substantial overhead and are not a production latency measurement.

Compiler options that trap or wrap signed overflow change the compilation model and are not a substitute for source-level contracts. They may add checks broadly, inhibit optimization, or fail to cover operations performed in unchecked libraries. Use them as diagnostic configurations and keep explicit checked operations at boundaries where overflow is a normal input failure.

Optimizers reason from the rule that signed overflow does not occur. A check written after an overflowing expression can therefore be removed or transformed. For example, testing whether `a * b / b == a` is invalid when `a * b` can overflow before the test. Checks must prevent the undefined operation, not attempt to recognize it afterward.

When a bound is a configuration value, validate the configuration once with the same wide arithmetic used by the live formula. Refuse startup if maximum price, quantity, position count, and accumulator width do not compose safely. This turns an event-time branch into a deployment invariant while retaining a checked boundary for untrusted fields.

## 34.4 Rounding Direction and Exchange Rules

**Rounding** chooses a representable value when an exact result lies between representable values. The direction is a business rule, not a formatting detail.

Common policies include toward zero, toward positive infinity, toward negative infinity, nearest with ties away from zero, and nearest with ties to even. Bid and ask normalization may intentionally use different directions. Fees may round per fill or after aggregation; those operations can produce different totals.

C++ integer division truncates toward zero, and the remainder has the numerator's sign. For a positive divisor, floor and ceiling division require a correction for negative or positive remainders:

```cpp
#include <cassert>
#include <cstdint>

constexpr std::int64_t floor_div(std::int64_t n, std::int64_t d) {
    assert(d > 0);
    const auto q = n / d;
    const auto r = n % d;
    return q - (r < 0 ? 1 : 0);
}

constexpr std::int64_t ceil_div(std::int64_t n, std::int64_t d) {
    assert(d > 0);
    const auto q = n / d;
    const auto r = n % d;
    return q + (r > 0 ? 1 : 0);
}

static_assert(floor_div(-5, 2) == -3);
static_assert(ceil_div(-5, 2) == -2);
```

These functions still require `n / d` to be representable; with `d > 0`, the problematic signed case `INT64_MIN / -1` is excluded. An assertion is a development check and may be compiled out. Validate an external divisor before calling, or encode positive scale as a construction invariant.

Rounding to a tick grid follows the same sign concerns. “Round down” can mean toward zero in casual speech but must mean toward negative infinity when negative prices are possible. Name functions `floor_to_tick`, `ceil_to_tick`, or `nearest_even_to_tick`, and test negative examples even if current products normally trade above zero.

Apply the rule at the specified stage. Consider two fills whose exact fees are 0.005 currency units. Rounding each to cents and then adding can differ from summing exact scaled fees and rounding once. A ledger, venue confirmation, and pre-trade estimate can legitimately use different rules; they must not share an unnamed helper.

Tie handling must be tested with exact remainders, not floating comparisons. For a positive divisor `d`, a nearest rule compares `2 * |remainder|` with `d`; doubling can overflow in the original width, so widen it or compare without multiplication. At an exact tie, nearest-even inspects the parity of the candidate quotient. Negative inputs need a symmetric definition stated in business terms.

Tick normalization can be directional:

| Intent | Typical conservative direction |
|---|---|
| Buy limit adjusted to legal grid without becoming more aggressive | Floor |
| Sell limit adjusted without becoming more aggressive | Ceiling |
| Display-only decimal | Venue-specified nearest rule |
| Risk exposure upper bound | Away from the safe side |

These are examples, not universal venue rules. An adapter must name and test the actual contract. Rejecting an off-grid order is often preferable to silently changing its economics.

Rounding errors can accumulate even with integers if every stage discards a remainder. Preserve a wider numerator or residual when a protocol permits, then round once at the required settlement boundary. If the protocol requires per-event rounding, reproduce it exactly rather than “improving” numerical accuracy and disagreeing with confirmations.

Integer division is often more expensive than addition or multiplication on common CPUs and can form a dependency chain. A constant positive scale may be transformed by the compiler into multiply-and-shift operations. That is implementation behavior. Inspect optimized assembly and benchmark realistic batches, but never replace a correct signed rounding rule with a faster unsigned shortcut.

Decimal parsing is rounding too. For a scale of 10,000, the text `12.34` becomes `123400` exactly after padding two fractional zeros. `12.34567` has five fractional digits and needs rejection or an explicit rounding decision. Strip neither trailing nor leading characters until syntax, digit count, sign, and range have been validated.

Conversions between tick schedules may be noninvertible. Converting from hundredths to tenths and back loses the hundredths remainder. Return whether conversion was exact and, when rounded, the direction or residual needed for audit. A round-trip equality test should be required only for values representable in both domains.

Rounding policy should appear in names or types, not a Boolean such as `round_up`. Booleans become ambiguous for negative values and call sites. An enum with `floor`, `ceiling`, `toward_zero`, and the supported nearest policies makes review and logging unambiguous.

## 34.5 Deterministic Representation and Comparison

A representation is **deterministic** when the same logical value has one chosen stored form and comparisons do not depend on process history, locale, or incidental formatting. Integer ticks provide this property only after scale and normalization are fixed.

Canonicalization should happen once at an ingress boundary. Reject a raw price that is off tick, or convert it under the venue's stated rule and retain an audit indication. Allowing multiple raw encodings of the same internal price complicates hashing, replay, persistence, and equality.

Use exact equality for values in the same fixed-point domain. Relative-tolerance comparisons belong to approximate computations, not integer order-price identity. If two prices have different scales, convert both to a common sufficiently wide scale after proving the conversion cannot overflow. Comparing raw fields directly is wrong; converting through `double` can lose ordering for large integers.

Ordering should be consistent with equality. A defaulted comparison on a wrapper containing only its canonical raw integer provides that relationship. If the type also stores metadata such as currency or scale, decide whether values from different domains are incomparable, ordered by a composite key, or rejected before comparison. Silently ordering cents and yen ticks by their raw integers is not useful.

Serialization must specify byte order, width, signed encoding, scale, and version. Dumping a C++ object representation writes padding and host endianness and ties data to an ABI. Encode the raw integer field explicitly. Chapter 30 explains wire representation; Chapter 35 applies the same rule to market-data decoding.

Deterministic data does not guarantee deterministic processing under concurrency. If two threads apply updates in different orders, integer arithmetic can still produce different state when operations are not commutative or when caps and rounding occur. Sequence ownership and replay order are part of numerical reproducibility.

Hashing and persistence depend on canonical form. Hash raw canonical units plus domain identifiers; do not hash formatted text, whose leading zeros or decimal separator can vary. If a signed zero can arise in an external decimal format, canonical integer conversion naturally collapses it to zero. Preserve the original text separately only when audit requirements demand it.

Comparison across currencies requires an exchange rate and valuation time. It is not a property of the price type. An API that orders `Money<USD>` and `Money<JPY>` implicitly is hiding market data and rounding. Require an explicit conversion result carrying target currency, scale, rate source, and timestamp.

Deterministic logs should record inputs and decisions needed to reproduce conversion: raw field, decoded scale, rounding policy identifier, and outcome. Recording only the final normalized integer cannot explain whether a boundary value was rejected or rounded.

Database keys and network APIs need the same domain discipline. A column named `price` with no scale in its schema invites clients to interpret raw values differently. Name the unit, store a schema or reference-data version, and make migrations reject mixed interpretations. If the database uses a decimal type, verify its precision and rounding rather than assuming it matches the C++ wrapper.

Stable comparison also requires stable metadata lookup. If a live reference-data update changes scale while messages from the prior epoch remain queued, normalizing both under the newest metadata breaks replay order. Tag queued events with the reference epoch or switch metadata only at a coordinated sequence boundary.

Verification can hash canonical serialized fields and compare them across processes. Do not hash in-memory wrappers or use `std::hash` as a durable format: its algorithm is not a persistence contract. A named fixed hash over explicit big- or little-endian bytes provides a reproducible audit check.

## 34.6 Floating-Point Exactness and ULPs

IEEE-754 binary floating-point values represent numbers as a sign, significand, and exponent. Most decimal fractions, including 0.1, have no finite binary representation. The stored value is a nearby representable number selected by the active rounding behavior.

An **ULP**, or unit in the last place, is the spacing between representable values near a given magnitude. Spacing grows with magnitude and changes at powers of two. A fixed absolute epsilon is therefore too strict for some large values and too loose near zero; multiplying machine epsilon by an arbitrary constant is not a universal comparison policy.

Choose comparison from the domain:

| Requirement | Appropriate strategy |
|---|---|
| Exact protocol price identity | Convert to validated integer units |
| Value produced by the same deterministic operation | Exact comparison may be valid |
| Approximate analytical result | Documented absolute/relative tolerance |
| Adjacent representable-value analysis | ULP-based or `nextafter` reasoning |
| Ordering that can contain NaNs | Explicit total-order policy |

```cpp
#include <algorithm>
#include <cmath>

bool nearly_equal(double a, double b,
                  double abs_tol, double rel_tol) noexcept {
    if (a == b) return true;           // also handles equal infinities
    if (!std::isfinite(a) || !std::isfinite(b)) return false;
    const double diff = std::abs(a - b);
    return diff <= std::max(abs_tol,
                            rel_tol * std::max(std::abs(a), std::abs(b)));
}
```

The function is a policy mechanism, not a ready-made trading rule. Callers must choose tolerances in units connected to acceptable error. It also treats `+0.0` and `-0.0` as equal, which is normally useful, though their signs can affect later operations such as reciprocals.

Subnormal values fill the interval near zero with reduced precision. Some hardware and compiler configurations handle them more slowly or flush them to zero. Do not assume either behavior from C++. Measure the target and decide whether changing the floating-point environment is numerically acceptable for the analytical component involved.

Binary64 has finite precision: all integers are exact only through `2^53`. Above that point, adjacent integer values can map to the same `double`. Converting a 64-bit order ID or high-resolution fixed-point raw value to double and back can therefore change identity even when no decimal fraction is involved.

Relative error also behaves poorly around zero because the denominator used to interpret “relative” size vanishes. That is why the example combines absolute and relative tolerances. The absolute tolerance defines the near-zero region; it must come from a domain noise floor or error budget.

`std::nextafter(x, direction)` identifies the adjacent representable value toward a direction and is useful for boundary tests. ULP distance across sign changes, NaNs, and different floating formats needs a specified mapping; copying bits into an integer and subtracting them without handling ordering is not a general solution.

The floating-point environment can select rounding modes and report exceptions, but compilers optimize based on whether the program declares access to that environment. Changing rounding globally or per thread adds operational complexity and may inhibit optimization. Prefer explicit integer rounding for exact trading units and isolate environment-sensitive numerical code.

Floating point is often appropriate for models, statistics, and normalized signals whose errors are understood. It is usually a poor interchange type for an exact venue price. Convert at a named boundary, validate finiteness and range, and retain fixed-point values for identity, limits, and accounting.

Error propagation depends on conditioning. Subtracting nearly equal large values can discard leading significant bits; summing many values of very different magnitudes can lose small contributions. ULP analysis describes representation spacing, while numerical analysis explains how an algorithm amplifies input error. A tolerance chosen without considering the algorithm can validate a result for the wrong reason.

Order of magnitude matters for storage too. A `double` is commonly eight bytes, the same as `int64_t`; choosing it does not automatically save memory. SIMD may process several doubles efficiently, but so can integer instructions for suitable operations. Representation should follow semantics first, then generated work.

Tests should generate neighboring values with `nextafter`, not by adding a decimal epsilon that may round back to the original. Include transitions around zero, normal/subnormal boundaries, powers of two, and the maximum exact integer. Print hexadecimal floating representations or bit patterns in diagnostics so decimal formatting does not hide the actual difference.

## 34.7 FMA, NaNs, and Integer Conversion

A **fused multiply-add** computes `a * b + c` with one final rounding rather than rounding the product and then the sum. `std::fma` requests fused semantics even when hardware support is absent; an implementation may use a library routine. A compiler can also contract ordinary source expressions when the language mode and contraction settings permit it.

FMA can be both more accurate and different. A test that expects the separately rounded result may fail when contraction changes. If reproducibility requires one behavior, call `std::fma` deliberately for fused semantics or configure and verify contraction policy for separate operations.

NaN, or not-a-number, is unordered under ordinary comparisons. For a NaN `x`, `x == x` is false and `x < y`, `x > y`, and `x == y` are all false. Code such as `if (price < min || price > max) accept();` can therefore accept NaN on the fall-through path. Validate `std::isfinite(price)` before range checks at an untrusted boundary.

NaN payload propagation and sign details are not a portable error channel. Optimizations may alter which NaN reaches a result, and fast-math modes can assume NaNs do not occur. Return an explicit error state instead of encoding parser or risk failures as NaNs.

Infinities compare in the usual extended order but remain invalid for most prices, quantities, and risk inputs. Checking only `!isnan(x)` is insufficient. `std::isfinite` rejects both NaNs and infinities. Signed zero compares equal, yet `std::signbit` can distinguish it and operations such as `1.0 / x` produce infinities of different signs.

Standard sorting with ordinary `<` assumes a strict weak ordering. A range containing NaNs does not satisfy an intuitive numeric order under that comparator. Validate them out, or define a comparator that assigns all categories—including NaNs—a stable place and is consistent for every pair. Do not let a model's NaN leak into price-priority ordering.

Before converting a scaled floating input, avoid a bound such as `x <= double(INT64_MAX)`, because that conversion rounds and can admit a value whose integer result is out of range. Use a carefully derived exclusive boundary in the floating type or, preferably for decimal protocol input, skip the floating intermediate entirely.

Converting floating point to an integer truncates toward zero. If the truncated value cannot be represented in the destination integer type, C++ behavior is undefined; NaN and infinity do not produce a safe sentinel. A correct conversion validates finiteness and bounds before the cast, with bounds chosen so floating rounding cannot make the precheck itself unsound.

For decimal input, parse digits directly into a checked integer representation when exactness is required. Converting text to `double`, multiplying by a scale, and casting can mis-round a value exactly at a tick boundary. `from_chars` for floating point avoids locale and allocation but does not change binary representability.

## 34.8 Reassociation, Fast Math, and Reproducibility

**Reassociation** changes the grouping of operations, such as replacing `(a + b) + c` with `a + (b + c)`. Real addition is associative; finite floating-point addition is not. Different groupings can change low bits, overflow timing, and cancellation.

Strict ordinary C++ rules constrain transformations that alter observable floating results, subject to the implementation's documented floating-point model and contraction rules. Aggressive options such as GCC or Clang `-ffast-math` enable assumptions including no NaNs or infinities and permit transformations that can change results. The exact set is compiler- and version-specific.

Parallel reductions naturally use different trees. Worker count, partitioning, and vector width can change grouping even without a source-code change. If bitwise reproducibility is required, fix the reduction order and arithmetic policy, or use a reproducible summation method whose costs are accepted. Kahan-style compensated summation can reduce error but is not automatically bitwise identical under reassociation.

Reproducibility is a system property. Record compiler and version, flags, target architecture, standard library, floating environment, input order, and model configuration. Cross-machine differences can come from FMA availability, extended intermediates, math-library implementations, and denormal modes.

Use a golden corpus containing boundaries, NaNs, infinities, subnormals where relevant, and cancellation-heavy values. Compare both numerical tolerance and exact bits according to the component's contract. Inspect compiler optimization remarks and assembly for fused or vector reductions. Never infer production numerical behavior from an unoptimized sanitizer build.

Fast math can improve throughput for a model whose error budget permits it. Isolate that component behind an exact typed boundary. Do not compile exact price validation, risk limits, and accounting with assumptions that erase NaN checks or allow overflow-like floating transformations merely because they share a binary with analytics.

Deterministic replay should compare intermediate checkpoints, not only a final aggregate. Record a hash of normalized inputs and state at bounded sequence intervals. The first divergent checkpoint narrows investigation and avoids attributing a later large difference to the wrong operation. Hashing itself must use a fixed algorithm and canonical byte encoding.

Build systems should make numerical modes visible. Record relevant compiler flags in build metadata and prevent one translation unit from silently using aggressive floating options across an inline function boundary. Link-time optimization can expose code to flags and transformations beyond its original file; verify the final binary, not only per-file assembly.

Performance tests must preserve the numerical contract. A fast-math and strict build that produce different accepted orders are not two implementations of equal work. First apply contract-level result checks, then compare instructions, vectorization, and latency only among acceptable builds.

## 34.9 Designing a Fixed-Point Price Type

A fixed-point price type should make its raw unit, construction policy, arithmetic range, and conversion behavior explicit. The smallest useful design is often better than a generic decimal framework.

```cpp
#include <compare>
#include <cstdint>
#include <limits>
#include <optional>

class Price {
public:
    // One raw unit is one ten-thousandth of the chosen currency unit.
    static constexpr std::int64_t scale = 10'000;

    static constexpr Price from_raw(std::int64_t raw) noexcept {
        return Price{raw};
    }

    constexpr std::int64_t raw() const noexcept { return raw_; }
    constexpr auto operator<=>(const Price&) const = default;

    friend constexpr std::optional<Price>
    checked_add(Price a, Price b) noexcept {
        const auto max = std::numeric_limits<std::int64_t>::max();
        const auto min = std::numeric_limits<std::int64_t>::min();
        if ((b.raw_ > 0 && a.raw_ > max - b.raw_) ||
            (b.raw_ < 0 && a.raw_ < min - b.raw_)) {
            return std::nullopt;
        }
        return Price::from_raw(a.raw_ + b.raw_);
    }

private:
    explicit constexpr Price(std::int64_t raw) noexcept : raw_{raw} {}
    std::int64_t raw_{};
};

static_assert(Price::from_raw(12'500) < Price::from_raw(12'501));
```

`from_raw` is intentionally explicit in name: it is for a boundary that already knows the scale. A production type can restrict it to a decoder or validated factory. Do not add an implicit constructor from an integer whose unit is unclear.

The `optional` result expresses overflow without throwing or allocating. C++ does not require a particular `optional` representation, but an optional small trivial value is commonly returned in registers on target ABIs. Measure the actual calling convention if this function remains out of line. An error enum plus output parameter may better distinguish overflow, invalid scale, and off-tick input.

Parsing decimal text should operate on digits with a bound on total and fractional length. Reject excess fractional digits or round them under a named policy; check multiply-by-ten and addition before each step; handle sign without negating the minimum value. Formatting should be the inverse for canonical stored values and belongs outside the hot path when it allocates or performs I/O.

Define only meaningful arithmetic. Price plus price may be useful for offsets in some domains and nonsensical in others. Price minus price naturally yields a price difference. Price times quantity yields a wider notional type with the product scale, not another price. Avoid a generic templated operator set that makes invalid dimensional expressions compile.

A practical API might expose:

| Operation | Result |
|---|---|
| Parse protocol decimal | `Price` or detailed parse error |
| Decode raw venue units | `Price` after scale and tick validation |
| Add price offset | Checked `Price` |
| Subtract two prices | Checked or proved-range `PriceDelta` |
| Multiply by quantity | Wider `NotionalRaw` |
| Convert to display text | Output iterator or caller buffer result |

None of these needs a virtual function or allocation. A caller-supplied character span can support bounded formatting and report insufficient capacity explicitly.

Template scale parameters can prevent domain mixing, for example `Fixed<CurrencyTag, 10'000>`. They also create distinct types and code for each scale. A runtime scale may be better when thousands of instruments use reference-data exponents. Normalize to a small internal set when possible and keep runtime conversion at ingress.

Concurrency does not justify atomic arithmetic on every price. Immutable price values copy cheaply. Let one thread own mutable position or book state and publish snapshots where possible. When an atomic raw integer is required, lock freedom is a property of `atomic<int64_t>` on the target, not of the wrapper by assumption; alignment and composite metadata still need a coherent publication design.

Decide the valid range below the raw integer's full range when doing so simplifies proofs. An instrument price cap and maximum offset can guarantee that book indexing and spread subtraction never overflow. Validate once on ingress, then preserve the invariant internally. Assertions can document it in development builds; external failures still need explicit handling.

Keep the type trivially copyable when shared-memory or binary-log use benefits, but serialize its `raw()` field rather than its object bytes. A future added member could change layout without changing the wire format. Version scale metadata in persistent records so that a replay never interprets old raw values under a new rule.

Verification has four layers: compile-time tests for construction and comparison, exhaustive or property tests around arithmetic boundaries, parser round trips over a large generated corpus, and optimized-code inspection for hidden division, calls, or branches. Benchmark success and failure paths separately. The failure path may be rare, but it must remain bounded and must not format a log message synchronously.

Property tests should include ordering transitivity, conversion round trips for every accepted decimal shape, monotonicity of directional rounding, and agreement with a high-precision reference implementation. Fuzz text parsing with excessive digits, embedded signs, empty fields, and values just beyond range. Treat any sanitizer finding as a correctness defect rather than a benchmark anomaly.

Deployment tests should replay the same canonical corpus across GCC and Clang builds and across supported architectures. Exact fixed-point results must match bit for bit. Approximate analytical outputs should meet their stated tolerance, while NaN and infinity handling must match the boundary policy. This is how a numerical type becomes an operational contract rather than a convenient wrapper.

Benchmark construction from already normalized raw units separately from decimal parsing. The former should reduce to validation and a small value return; the latter necessarily scans digits and may divide or round. Mixing them produces an average that describes neither the market-data path nor a user-interface path.

Version the fixed-point contract as deliberately as a protocol. Changing scale, valid range, or rounding of a factory can alter persisted values and risk decisions even when the C++ type name remains unchanged. A migration needs dual-read or conversion logic, replay tests, and an explicit cutover boundary.

Document those invariants beside the type and encode them in generated test vectors so downstream implementations in other languages must demonstrate identical boundary behavior.

Finally, keep error values typed. `optional` distinguishes value from absence but not why construction failed. At an untrusted boundary, a compact result containing `PriceError` can distinguish syntax, scale, off-tick, and overflow. Internally, where inputs have already been validated, narrower APIs can rely on preserved invariants and avoid repeating expensive checks.

## 34.10 Interview Check

1. Why does storing a price in `int64_t` not by itself make price arithmetic exact or safe?
2. A price uses scale 10,000 and quantity uses scale 1,000. What is the raw scale of their product, and where should rounding occur when producing cents?
3. Find the overflow bug in `int64_t n = int32_price * int32_quantity;` and explain why the destination type does not help.
4. Implement or specify checked signed multiplication covering zero, `-1`, `INT64_MIN`, and `INT64_MAX`. Which parts would you test exhaustively?
5. Compare truncation, floor, ceiling, nearest-away, and nearest-even for negative values halfway between ticks.
6. Why is `abs(a - b) < epsilon` not a universal floating-point comparison? Give an exact-price case and an analytical case with different policies.
7. Explain how FMA can be more accurate while breaking a bitwise regression test that previously passed.
8. What happens when NaN reaches ordinary range checks or a floating-to-integer cast, and where should validation occur?
9. Design the result types for price-plus-offset and price-times-quantity. Include scales, overflow, and rounding ownership.
10. A replay differs only when compiled with fast math on a new CPU. List the evidence needed to determine whether reassociation, FMA, input ordering, or undefined integer behavior caused it.
