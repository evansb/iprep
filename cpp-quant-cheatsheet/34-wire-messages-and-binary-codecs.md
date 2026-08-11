# 34. Wire messages and binary codecs

*Part VI-A — Quant blueprints: types, codecs, and core structures*

---

**Recall**
- Wire bytes are a *representation*, not a C++ object: no `Header` object exists in a receive buffer until you create one.
- `reinterpret_cast<Header const*>(buf.data())` is UB on three independent axes — object lifetime, alignment, and strict aliasing — before endianness is even discussed.
- `std::bit_cast<T>` requires `sizeof` equality and trivial copyability; it converts *object representations*, it does not decode a protocol.
- `std::byte`, `char`, and `unsigned char` may *inspect* any object's representation; the inverse (treating bytes as a live object of another type) is not licensed.
- `#pragma pack` changes implementation layout only — it creates no object, fixes no byte order, and can make every member unaligned.
- Read fields with byte shifts or `memcpy` into a live scalar; both are alignment-safe and neither is a typed unaligned load.
- Shift-based loads must promote to `unsigned` first: `byte << 24` on a signed promoted type is UB for the high bit.
- Validate in dependency order — header present → length loadable → length in `[header, max]` → whole frame present → tag/version known → payload length exact → fields loadable → cross-field invariants.
- Never use an untrusted length in pointer arithmetic, `subspan`, or allocation before bounding it.
- Prefer `payload > input.size() - header` (after proving `input.size() >= header`) over `header + payload > input.size()`, which can wrap.
- A cursor advances **only after** a successful read; check → load → advance, never advance → check.
- Incomplete ≠ malformed: a stream framer needs a distinct `NeedMore` outcome or it destroys resumption semantics.
- One exact-size check proves every offset in a *fixed* layout; nested variable layouts need incremental checks plus count/depth/work limits.
- `std::variant` is the *decoded result*, never a wire overlay; it costs the largest alternative plus tag plus alignment padding.
- Dispatch on a validated tag: `switch` (obvious unknown handling) or a 256-entry function table (`uint8_t` can't overflow it) — a compact table needs a range check first.
- Version selects a *decoder*, never a struct layout; `sizeof(LocalStruct)` is never a protocol fact.
- Spans in a decoded message borrow the receive buffer: copy or transfer ownership before any asynchronous handoff or buffer refill.
- A fuzzable decoder is pure: bounded span in, `expected` out, no I/O, no allocation, no globals, no exceptions, bounded work.
- Success must consume > 0 bytes, or the stream loop spins forever.
- A checksum is error *detection*; it is not authentication unless the protocol specifies a cryptographic MAC.

---

## 34.1 Wire representation versus in-memory object representation

```cpp
// ================= THE WRONG WAY — every line is a separate hazard ========
#pragma pack(push, 1)
struct WireHeader {                  // implementation-specific layout
    std::uint16_t length;            // native byte order, possibly unaligned
    std::uint8_t  version;
    std::uint8_t  tag;
};
#pragma pack(pop)

void bad(std::span<std::byte const> in) {
    auto const* h = reinterpret_cast<WireHeader const*>(in.data()); // UB
    // 1. no WireHeader object was ever created in that storage (lifetime)
    // 2. in.data() need not satisfy alignof(WireHeader) (alignment)
    // 3. accessing bytes through WireHeader lvalue violates aliasing rules
    // 4. h->length is host-endian, the wire is big-endian (semantics)
    // 5. padding/packing are ABI-dependent, not protocol-dependent
    // 6. h->length read BEFORE proving in.size() >= sizeof(WireHeader)
    (void)h;
}

// bit_cast does NOT fix this:
// auto hh = std::bit_cast<WireHeader>(first4);   // C++20, <bit>
//   - requires sizeof(From) == sizeof(To) and both trivially copyable
//   - yields the NATIVE object representation: still no endian decode,
//     no field validation, no schema, no padding guarantee.

// std::start_lifetime_as<T>(p)                    // C++23, does NOT rescue it:
//   - only implicit-lifetime types, still requires correct alignment,
//     still gives native layout/endianness. Not a codec.
```

```cpp
// ================= THE RIGHT BOUNDARY =====================================
#include <bit>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <expected>
#include <span>

using Bytes  = std::span<std::byte const>;   // borrowed, immutable input
using MutBytes = std::span<std::byte>;       // borrowed, writable output

// A codec is a specification, not a struct:
//   offset 0  width 2  total length, big-endian, INCLUDES header
//   offset 2  width 1  protocol version
//   offset 3  width 1  message tag
//   offset 4  ...      payload
inline constexpr std::size_t kHeaderSize = 4;
```

| Construct | What it actually does | Why it is not a codec |
|---|---|---|
| `reinterpret_cast<T const*>(bytes)` | pointer type pun | no object, no alignment, aliasing UB |
| `std::bit_cast<T>(u)` (C++20) | copies object representation, `constexpr` | native endian/padding, equal-size only |
| `std::start_lifetime_as<T>` (C++23) | implicitly begins lifetime in suitable storage | needs alignment; native layout still |
| `std::memcpy(&x, p, sizeof x)` | alignment- and aliasing-safe copy | representation transfer only, no byte order |
| `std::launder` | refreshes a pointer after in-place reuse | does not create objects or fix alignment |
| `#pragma pack` / `__attribute__((packed))` | removes padding, permits unaligned members | ABI-specific, endian-blind |
| Byte shift + `std::to_integer` | portable field decode | *this is the codec* |

**Interview line** — "Wire compatibility is a property of an explicit byte-level specification, never of `sizeof(struct)` or of any cast."

**Traps** — `bit_cast` "solves" nothing about protocols · packed structs can make *every* member an unaligned access · a trivially copyable struct dumped to disk records host endian + ABI padding, so replay breaks on the next compiler · `alignof(std::byte) == 1` makes the input side safe, not the output side.

---

## 34.2 Framing, length fields, message types, and validation order

```text
input bytes
   │ borrow span<byte const>
   ▼
framer   : header present? length sane? whole frame here?
   │ FrameView{version, tag, payload, consumed}  |  NeedMore  |  Malformed
   ▼
decoder  : exact payload length → load fields → validate encodings
   │ expected<WireMessage, DecodeError>
   ▼
normalize: protocol values → invariant-bearing domain types
```

```cpp
// ---- error vocabulary: fixed-size, no allocation, no strings -------------
enum class DecodeCode : std::uint8_t {
    ok = 0,
    truncated,             // fewer bytes than the layout demands
    invalid_length,        // length < header, or != required payload size
    frame_too_large,       // exceeds configured maximum
    unsupported_version,
    unknown_tag,
    invalid_field,         // encoding or cross-field invariant violated
    trailing_bytes,        // policy forbids leftovers
    checksum_mismatch,
    limit_exceeded         // count/depth/work bound hit
};

struct DecodeError {
    DecodeCode    code{};
    std::uint32_t offset{};   // relative to a DOCUMENTED origin (frame start)
    std::uint16_t field{};    // schema field id, 0 = none
};

[[nodiscard]] constexpr DecodeError err(DecodeCode c, std::size_t off,
                                        std::uint16_t f = 0) noexcept {
    return DecodeError{c, static_cast<std::uint32_t>(off), f};
}

struct DecoderConfig {                 // immutable, passed by const&
    std::uint32_t max_frame_size{1u << 16};
    std::uint32_t max_repeat_count{4096};
    std::uint8_t  min_version{1};
    std::uint8_t  max_version{2};
    bool          forbid_trailing{true};
    bool          verify_checksum{false};
};
```

```cpp
// ---- the three-outcome framer result ------------------------------------
#include <variant>

struct NeedMore { std::size_t minimum_additional{}; };  // caller retains suffix
struct FrameView {
    std::uint8_t version{};
    std::uint8_t tag{};
    Bytes        payload;         // borrows the caller's buffer
    std::size_t  consumed{};      // total frame bytes, ALWAYS > 0
};
struct Malformed { DecodeError error; std::size_t resync_hint{}; };

using FrameResult = std::variant<NeedMore, FrameView, Malformed>;
```

```cpp
// ---- validation in dependency order — each step licenses the next --------
[[nodiscard]] inline FrameResult
next_frame(Bytes in, DecoderConfig const& cfg) noexcept {
    // 1. header present?
    if (in.size() < kHeaderSize)
        return NeedMore{kHeaderSize - in.size()};

    // 2. length is now loadable at a PROVEN offset
    std::uint32_t const length =
        (std::to_integer<std::uint32_t>(in[0]) << 8) |
         std::to_integer<std::uint32_t>(in[1]);

    // 3. length must at least cover the header (else consumed could be 0)
    if (length < kHeaderSize)
        return Malformed{err(DecodeCode::invalid_length, 0, 1), 1};

    // 4. bound BEFORE any arithmetic that uses it
    if (length > cfg.max_frame_size)
        return Malformed{err(DecodeCode::frame_too_large, 0, 1), 1};

    // 5. whole frame present? (no addition — cannot wrap)
    if (in.size() < length)
        return NeedMore{length - in.size()};

    // 6. version/tag are raw here; the decoder validates them
    auto const version = std::to_integer<std::uint8_t>(in[2]);
    auto const tag     = std::to_integer<std::uint8_t>(in[3]);
    if (version < cfg.min_version || version > cfg.max_version)
        return Malformed{err(DecodeCode::unsupported_version, 2, 2), length};

    // 7. payload extent is proven: kHeaderSize <= length <= in.size()
    return FrameView{version, tag,
                     in.subspan(kHeaderSize, length - kHeaderSize),
                     length};
}
```

```cpp
// ---- overflow-safe size arithmetic --------------------------------------
std::uint16_t hdr = 4, pay = 65534;
// std::uint16_t total = hdr + pay;             // promotes to int, then TRUNCATES
if (in.size() >= hdr && pay > in.size() - hdr)  // GOOD: subtraction after proof
    return err(DecodeCode::truncated, 0);
// Comparing size_t against a widened unsigned is safe; comparing against a
// signed int is not — use std::cmp_greater (C++20, <utility>) when mixed.
if (std::cmp_greater(signed_len, in.size())) { /* ... */ }
```

```cpp
// ---- stream driver: positive progress is an invariant --------------------
inline void drain(std::vector<std::byte>& buf, DecoderConfig const& cfg) {
    std::size_t pos = 0;
    for (;;) {
        auto r = next_frame(Bytes{buf}.subspan(pos), cfg);
        if (auto* f = std::get_if<FrameView>(&r)) {
            handle(*f);
            pos += f->consumed;              // consumed > 0 guaranteed
        } else if (auto* m = std::get_if<Malformed>(&r)) {
            pos += m->resync_hint ? m->resync_hint : 1;   // never 0
        } else {
            break;                            // NeedMore: keep suffix
        }
    }
    buf.erase(buf.begin(), buf.begin() + static_cast<std::ptrdiff_t>(pos));
}
```

| Order | Fact established | Skipping it costs |
|---|---|---|
| 1 | header bytes exist | OOB read of the length field |
| 2 | length value known | — |
| 3 | `length >= header` | zero/negative payload extent, infinite loop |
| 4 | `length <= max` | unbounded allocation / work |
| 5 | `input.size() >= length` | OOB payload read |
| 6 | version/tag supported | decoding with the wrong schema |
| 7 | payload size exact for tag | field offsets unproven |
| 8 | fields loadable | OOB field read |
| 9 | encodings + cross-field valid | garbage in the domain layer |
| 10 | trailing policy satisfied | silent schema drift |

**Traps** — reading `length` before the size check · `subspan(off, n)` with untrusted `n` is UB, not an exception · collapsing `NeedMore` into `Malformed` breaks resumption · a `resync_hint` of 0 on malformed input spins the loop · length that *excludes* the header vs *includes* it is the single most common spec ambiguity — write it down.

---

## 34.3 Endian-aware integer loads and stores

```cpp
#include <bit>          // std::endian, std::byteswap (C++23), std::bit_cast
#include <concepts>     // std::unsigned_integral

// ---- byte-wise: portable, constexpr, auditable, no aliasing question -----
[[nodiscard]] constexpr std::uint16_t
load_be_u16(std::span<std::byte const, 2> b) noexcept {
    return static_cast<std::uint16_t>(
        (std::to_integer<std::uint32_t>(b[0]) << 8) |
         std::to_integer<std::uint32_t>(b[1]));       // promote FIRST, then shift
}

[[nodiscard]] constexpr std::uint32_t
load_be_u32(std::span<std::byte const, 4> b) noexcept {
    return (std::to_integer<std::uint32_t>(b[0]) << 24) |
           (std::to_integer<std::uint32_t>(b[1]) << 16) |
           (std::to_integer<std::uint32_t>(b[2]) <<  8) |
            std::to_integer<std::uint32_t>(b[3]);
}

[[nodiscard]] constexpr std::uint64_t
load_be_u64(std::span<std::byte const, 8> b) noexcept {
    std::uint64_t v = 0;
    for (std::size_t i = 0; i < 8; ++i)
        v = (v << 8) | std::to_integer<std::uint64_t>(b[i]);
    return v;
}

[[nodiscard]] constexpr std::uint32_t
load_le_u32(std::span<std::byte const, 4> b) noexcept {
    return  std::to_integer<std::uint32_t>(b[0])        |
           (std::to_integer<std::uint32_t>(b[1]) <<  8) |
           (std::to_integer<std::uint32_t>(b[2]) << 16) |
           (std::to_integer<std::uint32_t>(b[3]) << 24);
}

constexpr void store_be_u16(std::span<std::byte, 2> o,
                            std::uint16_t v) noexcept {
    o[0] = std::byte{static_cast<std::uint8_t>(v >> 8)};
    o[1] = std::byte{static_cast<std::uint8_t>(v)};
}
constexpr void store_be_u32(std::span<std::byte, 4> o,
                            std::uint32_t v) noexcept {
    o[0] = std::byte{static_cast<std::uint8_t>(v >> 24)};
    o[1] = std::byte{static_cast<std::uint8_t>(v >> 16)};
    o[2] = std::byte{static_cast<std::uint8_t>(v >>  8)};
    o[3] = std::byte{static_cast<std::uint8_t>(v)};
}
constexpr void store_be_u64(std::span<std::byte, 8> o,
                            std::uint64_t v) noexcept {
    for (std::size_t i = 0; i < 8; ++i)
        o[i] = std::byte{static_cast<std::uint8_t>(v >> (56 - 8 * i))};
}
```

```cpp
// ---- generic byte-wise, any width ---------------------------------------
template<std::unsigned_integral U>
[[nodiscard]] constexpr U
load_be_bytewise(std::span<std::byte const, sizeof(U)> b) noexcept {
    U v{};
    for (std::size_t i = 0; i < sizeof(U); ++i)
        v = static_cast<U>((v << 8) | std::to_integer<U>(b[i]));
    return v;
}

// ---- memcpy + byteswap: one load + one BSWAP on mainstream targets -------
template<std::unsigned_integral U>
[[nodiscard]] U load_be(std::span<std::byte const, sizeof(U)> in) noexcept {
    U v;
    std::memcpy(&v, in.data(), sizeof v);        // alignment- and alias-safe
    if constexpr (sizeof(U) == 1)               return v;
    else if constexpr (std::endian::native == std::endian::big)    return v;
    else if constexpr (std::endian::native == std::endian::little)
        return std::byteswap(v);                 // C++23, <bit>
    else return load_be_bytewise<U>(in);         // mixed-endian fallback
}

template<std::unsigned_integral U>
void store_be(std::span<std::byte, sizeof(U)> out, U v) noexcept {
    if constexpr (sizeof(U) > 1 && std::endian::native == std::endian::little)
        v = std::byteswap(v);
    std::memcpy(out.data(), &v, sizeof v);
}
// NOTE: std::memcpy is NOT constexpr — keep a byte-wise path for constant
// evaluation, or gate with `if consteval` (C++23).
template<std::unsigned_integral U>
[[nodiscard]] constexpr U load_be_any(std::span<std::byte const, sizeof(U)> b) noexcept {
    if consteval { return load_be_bytewise<U>(b); }   // C++23
    else         { return load_be<U>(b); }
}
```

```cpp
// ---- signed fields: decode the unsigned pattern, then convert ------------
// The wire says "two's complement, big-endian, 32-bit".
[[nodiscard]] constexpr std::int32_t
load_be_i32(std::span<std::byte const, 4> b) noexcept {
    std::uint32_t const u = load_be_u32(b);
    // Since C++20 signed integers ARE two's complement, so the conversion
    // below is well defined and value-preserving for the bit pattern.
    return static_cast<std::int32_t>(u);          // C++20: no impl-defined step
    // Pre-C++20 portable form: u <= 0x7FFFFFFF ? int32_t(u)
    //                                          : int32_t(u - 0x80000000u) - 0x7FFFFFFF - 1
}
constexpr void store_be_i32(std::span<std::byte, 4> o, std::int32_t v) noexcept {
    store_be_u32(o, static_cast<std::uint32_t>(v)); // modular, always defined
}

// ---- IEEE-754 fields: bit pattern first, bit_cast last -------------------
[[nodiscard]] inline double load_be_f64(std::span<std::byte const, 8> b) noexcept {
    static_assert(std::numeric_limits<double>::is_iec559);
    return std::bit_cast<double>(load_be_u64(b));   // C++20; NaN payloads survive
}
// Prefer scaled integers on the wire: floats admit -0.0, NaN, and
// non-canonical payloads that break bytewise round-trip equality.
```

| Facility | Header | Notes |
|---|---|---|
| `std::endian::native / little / big` | `<bit>` | C++20; `native` may equal neither |
| `std::byteswap(u)` | `<bit>` | C++23, `constexpr`, unsigned/signed integrals, no padding-bit types |
| `std::bit_cast<To>(from)` | `<bit>` | C++20, `constexpr`, equal size + trivially copyable |
| `std::to_integer<I>(b)` | `<cstddef>` | `constexpr`, only for integral `I` |
| `std::byte{u8}` | `<cstddef>` | narrowing from wider types is ill-formed in braces |
| `std::memcpy` | `<cstring>` | not `constexpr`; typically folded to one load/store |
| `std::has_single_bit`, `rotl`, `rotr`, `popcount`, `countl_zero` | `<bit>` | C++20 bit ops for checksum/CRC work |
| `std::cmp_less/greater/equal…` | `<utility>` | C++20 sign-safe comparison |
| `std::numeric_limits<T>::is_iec559` | `<limits>` | gate float `bit_cast` on it |

**Traps** — `b[0] << 24` where `b[0]` promotes to `int` is UB for values ≥ 0x80 · `htonl`/`ntohl` are POSIX, 32-bit only, and absent on freestanding · `std::byteswap` on `bool`/`char` variants is deliberately restricted · a `memcpy` load does *not* validate anything · reading through `std::uint32_t const*` "because x86 allows unaligned" is still UB and UBSan flags it.

---

## 34.4 Unaligned input without undefined behavior

```cpp
// ---- what "unaligned" actually breaks -----------------------------------
void hazards(std::byte const* p) {
    // auto x = *reinterpret_cast<std::uint32_t const*>(p);
    //   lifetime : no uint32_t object lives at p
    //   alignment: p % alignof(uint32_t) may be nonzero -> UB (SIGBUS on some ISAs)
    //   aliasing : accessing bytes via uint32_t lvalue violates [basic.lval]
    // All three are diagnosed by -fsanitize=alignment,undefined.

    std::uint32_t v;
    std::memcpy(&v, p, sizeof v);   // OK: v is a live object, memcpy is byte-wise
    (void)v;
}

// ---- three sound spellings ----------------------------------------------
std::uint32_t a(Bytes b) { return load_be_u32(b.first<4>()); }        // shifts
std::uint32_t c(Bytes b) { std::uint32_t v; std::memcpy(&v, b.data(), 4);
                           return std::byteswap(v); }                 // memcpy
std::uint32_t d(Bytes b) { return std::bit_cast<std::uint32_t>(       // bit_cast
                               std::array<std::byte,4>{b[0],b[1],b[2],b[3]}); }

// ---- span fixed-extent conversions (all O(1), no runtime check) ---------
Bytes in;
std::span<std::byte const, 4> f4 = in.first<4>();      // PRECONDITION size()>=4
std::span<std::byte const, 4> l4 = in.last<4>();
std::span<std::byte const, 4> s4 = in.subspan<8, 4>(); // static offset+extent
auto dyn = in.subspan(8, 4);                            // dynamic extent
std::span<std::byte const, 4> made{in.data() + 8, 4};   // explicit ctor, UNCHECKED
// span's fixed-extent operations are PRECONDITIONS, not checks — prove first.

// ---- byte views over any trivially copyable object ----------------------
struct Snapshot { std::uint64_t seq; std::uint32_t n; };
Snapshot s{};
std::span<std::byte const> rs = std::as_bytes(std::span{&s, 1});      // C++20
std::span<std::byte>       ws = std::as_writable_bytes(std::span{&s, 1});
// Legal to INSPECT s's representation. NOT a portable serialization:
// it captures host endian + padding bytes (which are indeterminate).
```

```cpp
// ---- writing without alignment assumptions ------------------------------
void put_u64(MutBytes out, std::uint64_t v) noexcept {
    // never: *reinterpret_cast<std::uint64_t*>(out.data()) = v;
    store_be_u64(std::span<std::byte, 8>{out.data(), 8}, v);
}

// ---- if you MUST have an object in a buffer (C++23) ---------------------
// std::start_lifetime_as<T>(void* p)      -> T*   (implicit-lifetime T only)
// std::start_lifetime_as_array<T>(p, n)
//   Still requires correct alignment and gives NATIVE layout. Use for
//   memory-mapped native-format regions, never for foreign wire formats.
```

| Approach | Alignment-safe | `constexpr` | Endian-aware | Verdict |
|---|---|---|---|---|
| `reinterpret_cast` + deref | no | no | no | UB — never |
| `bit_cast` of a `byte` array | yes | yes | no (add swap) | fine |
| `memcpy` into a live scalar | yes | no | no (add swap) | fine, usually one instruction |
| Byte shifts + `to_integer` | yes | yes | yes | default choice |
| `start_lifetime_as` (C++23) | needs aligned storage | no | no | native formats only |
| `packed` struct member read | compiler-inserted | no | no | ABI-locked, non-portable |

**Traps** — `alignof(std::byte) == 1`, so a `byte` buffer is aligned for nothing else · `alignas(8) std::array<std::byte,N>` fixes alignment but not lifetime or aliasing · `first<4>()` on a 3-byte span is UB, not a throw · padding bytes read via `as_bytes` are indeterminate values.

---

## 34.5 Cursor-based readers/writers over `std::span<std::byte>`

```cpp
// =========================== ByteReader ==================================
// Owns nothing. Borrows one span. Advances ONLY on success.
enum class ReadError : std::uint8_t { truncated, limit_exceeded };

class ByteReader {
public:
    ByteReader() = default;
    explicit constexpr ByteReader(Bytes input) noexcept
        : rest_{input}, initial_{input.size()} {}

    [[nodiscard]] constexpr std::size_t offset()    const noexcept { return initial_ - rest_.size(); }
    [[nodiscard]] constexpr std::size_t remaining() const noexcept { return rest_.size(); }
    [[nodiscard]] constexpr bool        empty()     const noexcept { return rest_.empty(); }
    [[nodiscard]] constexpr Bytes       rest()      const noexcept { return rest_; }

    // ---- scalars: check, load, then advance -----------------------------
    [[nodiscard]] constexpr std::expected<std::uint8_t, ReadError> u8() noexcept {
        if (rest_.empty()) return std::unexpected(ReadError::truncated);
        auto const v = std::to_integer<std::uint8_t>(rest_[0]);
        rest_ = rest_.subspan(1);
        return v;
    }
    [[nodiscard]] constexpr std::expected<std::uint16_t, ReadError> be_u16() noexcept {
        if (rest_.size() < 2) return std::unexpected(ReadError::truncated);
        auto const v = load_be_u16(std::span<std::byte const, 2>{rest_.data(), 2});
        rest_ = rest_.subspan(2);
        return v;
    }
    [[nodiscard]] constexpr std::expected<std::uint32_t, ReadError> be_u32() noexcept {
        if (rest_.size() < 4) return std::unexpected(ReadError::truncated);
        auto const v = load_be_u32(std::span<std::byte const, 4>{rest_.data(), 4});
        rest_ = rest_.subspan(4);
        return v;
    }
    [[nodiscard]] constexpr std::expected<std::uint64_t, ReadError> be_u64() noexcept {
        if (rest_.size() < 8) return std::unexpected(ReadError::truncated);
        auto const v = load_be_u64(std::span<std::byte const, 8>{rest_.data(), 8});
        rest_ = rest_.subspan(8);
        return v;
    }
    [[nodiscard]] constexpr std::expected<std::int32_t, ReadError> be_i32() noexcept {
        return be_u32().transform([](std::uint32_t u) {
            return static_cast<std::int32_t>(u); });        // monadic, C++23
    }

    // ---- bulk ------------------------------------------------------------
    [[nodiscard]] constexpr std::expected<Bytes, ReadError> take(std::size_t n) noexcept {
        if (n > rest_.size()) return std::unexpected(ReadError::truncated);
        auto const view = rest_.first(n);                    // borrowed!
        rest_ = rest_.subspan(n);
        return view;
    }
    template<std::size_t N>
    [[nodiscard]] constexpr std::expected<std::span<std::byte const, N>, ReadError>
    take_fixed() noexcept {
        if (rest_.size() < N) return std::unexpected(ReadError::truncated);
        std::span<std::byte const, N> view{rest_.data(), N};
        rest_ = rest_.subspan(N);
        return view;
    }
    [[nodiscard]] constexpr std::expected<void, ReadError> skip(std::size_t n) noexcept {
        if (n > rest_.size()) return std::unexpected(ReadError::truncated);
        rest_ = rest_.subspan(n);
        return {};
    }
    // Length-prefixed blob: u8 length, then that many bytes.
    [[nodiscard]] constexpr std::expected<Bytes, ReadError> lp8() noexcept {
        ByteReader probe = *this;                            // cheap rollback copy
        auto const n = probe.u8();
        if (!n) return std::unexpected(n.error());
        auto blob = probe.take(*n);
        if (!blob) return std::unexpected(blob.error());
        *this = probe;                                       // commit atomically
        return *blob;
    }
    // Peek without consuming.
    [[nodiscard]] constexpr std::expected<std::uint8_t, ReadError> peek_u8() const noexcept {
        if (rest_.empty()) return std::unexpected(ReadError::truncated);
        return std::to_integer<std::uint8_t>(rest_[0]);
    }

private:
    Bytes       rest_{};
    std::size_t initial_{};
};
```

```cpp
// =========================== ByteWriter ==================================
enum class WriteError : std::uint8_t { no_space, value_out_of_range };

class ByteWriter {
public:
    explicit constexpr ByteWriter(MutBytes out) noexcept
        : rest_{out}, initial_{out.size()} {}

    [[nodiscard]] constexpr std::size_t written()  const noexcept { return initial_ - rest_.size(); }
    [[nodiscard]] constexpr std::size_t capacity() const noexcept { return rest_.size(); }

    [[nodiscard]] constexpr std::expected<void, WriteError> u8(std::uint8_t v) noexcept {
        if (rest_.empty()) return std::unexpected(WriteError::no_space);
        rest_[0] = std::byte{v};
        rest_ = rest_.subspan(1);
        return {};
    }
    [[nodiscard]] constexpr std::expected<void, WriteError> be_u16(std::uint16_t v) noexcept {
        if (rest_.size() < 2) return std::unexpected(WriteError::no_space);
        store_be_u16(std::span<std::byte, 2>{rest_.data(), 2}, v);
        rest_ = rest_.subspan(2);
        return {};
    }
    [[nodiscard]] constexpr std::expected<void, WriteError> be_u32(std::uint32_t v) noexcept {
        if (rest_.size() < 4) return std::unexpected(WriteError::no_space);
        store_be_u32(std::span<std::byte, 4>{rest_.data(), 4}, v);
        rest_ = rest_.subspan(4);
        return {};
    }
    [[nodiscard]] constexpr std::expected<void, WriteError> be_u64(std::uint64_t v) noexcept {
        if (rest_.size() < 8) return std::unexpected(WriteError::no_space);
        store_be_u64(std::span<std::byte, 8>{rest_.data(), 8}, v);
        rest_ = rest_.subspan(8);
        return {};
    }
    [[nodiscard]] constexpr std::expected<void, WriteError> bytes(Bytes v) noexcept {
        if (v.size() > rest_.size()) return std::unexpected(WriteError::no_space);
        std::ranges::copy(v, rest_.begin());
        rest_ = rest_.subspan(v.size());
        return {};
    }
    [[nodiscard]] constexpr std::expected<void, WriteError> fill(std::byte b, std::size_t n) noexcept {
        if (n > rest_.size()) return std::unexpected(WriteError::no_space);
        std::ranges::fill(rest_.first(n), b);
        rest_ = rest_.subspan(n);
        return {};
    }
    // Reserve a slot now, patch it after the body length is known.
    [[nodiscard]] constexpr std::expected<MutBytes, WriteError>
    reserve_slot(std::size_t n) noexcept {
        if (n > rest_.size()) return std::unexpected(WriteError::no_space);
        auto slot = rest_.first(n);
        rest_ = rest_.subspan(n);
        return slot;                          // caller stores into it later
    }

private:
    MutBytes    rest_{};
    std::size_t initial_{};
};
```

```cpp
// ---- monadic chaining: C++23 and_then / transform / or_else -------------
[[nodiscard]] std::expected<void, WriteError>
encode_header(ByteWriter& w, std::uint16_t len, std::uint8_t ver, std::uint8_t tag) noexcept {
    return w.be_u16(len)
        .and_then([&] { return w.u8(ver); })
        .and_then([&] { return w.u8(tag); });
}

// ---- length back-patch: reserve, body, then store the real length -------
[[nodiscard]] std::expected<std::size_t, WriteError>
encode_frame(MutBytes out, std::uint8_t ver, std::uint8_t tag, Bytes payload) noexcept {
    ByteWriter w{out};
    auto slot = w.reserve_slot(2);                       // length placeholder
    if (!slot) return std::unexpected(slot.error());
    if (auto r = w.u8(ver);          !r) return std::unexpected(r.error());
    if (auto r = w.u8(tag);          !r) return std::unexpected(r.error());
    if (auto r = w.bytes(payload);   !r) return std::unexpected(r.error());
    std::size_t const total = w.written();
    if (total > 0xFFFFu) return std::unexpected(WriteError::value_out_of_range);
    store_be_u16(std::span<std::byte, 2>{slot->data(), 2},
                 static_cast<std::uint16_t>(total));
    return total;
}
```

| Member | Complexity | Failure behavior |
|---|---|---|
| `ByteReader::u8/be_u16/be_u32/be_u64` | O(1) | cursor **unchanged**, `ReadError::truncated` |
| `ByteReader::take(n)` / `take_fixed<N>()` | O(1) | unchanged; returned span **borrows** input |
| `ByteReader::lp8()` | O(1) | all-or-nothing via a copied probe cursor |
| `ByteReader::skip/peek_u8` | O(1) | `peek` never advances |
| `ByteWriter::u8/be_*` | O(1) | destination untouched on `no_space` |
| `ByteWriter::bytes(v)` | O(v.size()) | untouched on `no_space` (size checked first) |
| `ByteWriter::reserve_slot(n)` | O(1) | slot stays valid while `out` lives |
| copy/assign of either cursor | O(1) | trivially copyable → checkpoint/rollback is free |

- Cursors are trivially copyable: `auto save = r;` is the rollback mechanism — no transaction machinery needed.
- `std::expected<void, E>` returns `{}` for success; `.value()` on the error state throws `std::bad_expected_access<E>` — never call it on the hot path.
- Writers can leave *partial* output when a late field fails; either prove `encoded_size(msg) <= out.size()` up front (all-or-nothing) or forbid transmitting on failure.

**Traps** — advancing before the size check destroys retry and error-offset determinism · `[[nodiscard]]` on every operation is what stops a silently ignored `no_space` · `take()` results dangle the moment the receive buffer is refilled · `offset()` is only meaningful relative to the span the cursor was built from — document the origin.

---

## 34.6 Bounds checking once versus checking every field

```cpp
// ---- FIXED layout: one exact-size check proves every offset -------------
// payload: id:u32 | value:u32 | side:u8   =>  exactly 9 bytes
inline constexpr std::size_t kAddSize = 9;

[[nodiscard]] std::expected<WireAdd, DecodeError>
decode_add_fixed(Bytes p) noexcept {
    if (p.size() != kAddSize)                          // ONE branch
        return std::unexpected(err(DecodeCode::invalid_length, 0, 0));
    auto const id    = load_be_u32(p.subspan<0, 4>()); // static offsets: proven
    auto const value = load_be_u32(p.subspan<4, 4>());
    auto const side  = std::to_integer<std::uint8_t>(p[8]);
    if (id == 0)   return std::unexpected(err(DecodeCode::invalid_field, 0, 1));
    if (side > 1)  return std::unexpected(err(DecodeCode::invalid_field, 8, 3));
    return WireAdd{id, value, side};
}
// `!=` not `<`: `<` silently accepts trailing bytes and hides schema drift.

// ---- VARIABLE layout: count does not prove nested lengths ---------------
// count:u16 | repeated(count) { len:u8 | bytes[len] }
[[nodiscard]] std::expected<std::vector<Bytes>, DecodeError>
decode_list(Bytes p, DecoderConfig const& cfg) noexcept {
    ByteReader r{p};
    auto const count = r.be_u16();
    if (!count) return std::unexpected(err(DecodeCode::truncated, r.offset(), 1));
    if (*count > cfg.max_repeat_count)                  // bound work, not just memory
        return std::unexpected(err(DecodeCode::limit_exceeded, 0, 1));
    // Cheap pre-filter: each element costs >= 1 byte, so count <= remaining.
    if (*count > r.remaining())
        return std::unexpected(err(DecodeCode::truncated, r.offset(), 1));

    std::vector<Bytes> items;
    items.reserve(*count);                              // now safe: bounded
    for (std::uint16_t i = 0; i < *count; ++i) {
        auto blob = r.lp8();                            // per-element check
        if (!blob) return std::unexpected(err(DecodeCode::truncated, r.offset(), 2));
        items.push_back(*blob);
    }
    if (cfg.forbid_trailing && !r.empty())
        return std::unexpected(err(DecodeCode::trailing_bytes, r.offset(), 0));
    return items;
}

// ---- PREFLIGHT then unchecked: validate the schema, then load blind -----
[[nodiscard]] constexpr bool preflight_add(Bytes p) noexcept { return p.size() == 9; }
[[nodiscard]] WireAdd load_add_unchecked(Bytes p) noexcept {   // precondition: preflight
    return WireAdd{load_be_u32(std::span<std::byte const,4>{p.data(),   4}),
                   load_be_u32(std::span<std::byte const,4>{p.data()+4, 4}),
                   std::to_integer<std::uint8_t>(p[8])};
}
```

| Strategy | Branches | Advantage | Risk |
|---|---|---|---|
| One exact-length check | 1 | fixed schema, minimal code, best codegen | manual offset arithmetic errors; useless for nested variable data |
| Cursor check per field | 1/field | local proof, precise error offsets | branch density; coalescing is not guaranteed |
| Preflight then unchecked load | 1 + schema | separates validation from loading | two passes or a duplicated schema constant |
| Generated decoder from schema | varies | offsets stay consistent with the spec | generator becomes a correctness dependency |

- A bounds check may be removed only when a preceding proof **dominates every path** to the access — dominance, not "it looked checked above."
- Memory safety is not enough: `count = 65535` with 1-byte elements is a legal frame that can still be a work amplifier — bound count, depth, and total elements.
- `static_assert(kAddSize == 4 + 4 + 1);` keeps the size constant welded to the field list.
- Measure only after correctness: an exact-size check plus static `subspan<Off, N>` usually generates the same loads as hand-unrolled unchecked code.

**Traps** — `p.size() >= 9` where the spec says exactly 9 · `reserve(count)` before bounding `count` is a remote OOM · nested loops with per-level counts multiply into quadratic work · trusting an *outer* length to validate *inner* lengths.

---

## 34.7 Tagged messages: enum dispatch, `variant`, and generated tables

```cpp
#include <array>
#include <utility>      // std::to_underlying (C++23)
#include <variant>

enum class MessageTag : std::uint8_t { add = 1, cancel = 2, heartbeat = 3 };

struct WireAdd       { std::uint32_t id{}; std::uint32_t value{}; std::uint8_t side{}; };
struct WireCancel    { std::uint32_t id{}; };
struct WireHeartbeat { std::uint32_t epoch{}; };

using WireMessage = std::variant<WireAdd, WireCancel, WireHeartbeat>;

struct DecodeSuccess { WireMessage message; std::uint32_t consumed{}; };
using DecodeResult = std::expected<DecodeSuccess, DecodeError>;
using PayloadResult = std::expected<WireMessage, DecodeError>;
```

```cpp
// ---- per-tag payload decoders (uniform signature, noexcept) --------------
[[nodiscard]] PayloadResult decode_add_p(Bytes p) noexcept {
    if (p.size() != 9) return std::unexpected(err(DecodeCode::invalid_length, 0, 0));
    WireAdd m{load_be_u32(p.subspan<0,4>()), load_be_u32(p.subspan<4,4>()),
              std::to_integer<std::uint8_t>(p[8])};
    if (m.id == 0)  return std::unexpected(err(DecodeCode::invalid_field, 0, 1));
    if (m.side > 1) return std::unexpected(err(DecodeCode::invalid_field, 8, 3));
    return WireMessage{m};
}
[[nodiscard]] PayloadResult decode_cancel_p(Bytes p) noexcept {
    if (p.size() != 4) return std::unexpected(err(DecodeCode::invalid_length, 0, 0));
    WireCancel m{load_be_u32(p.subspan<0,4>())};
    if (m.id == 0) return std::unexpected(err(DecodeCode::invalid_field, 0, 1));
    return WireMessage{m};
}
[[nodiscard]] PayloadResult decode_heartbeat_p(Bytes p) noexcept {
    if (p.size() != 4) return std::unexpected(err(DecodeCode::invalid_length, 0, 0));
    return WireMessage{WireHeartbeat{load_be_u32(p.subspan<0,4>())}};
}
[[nodiscard]] PayloadResult decode_unknown_p(Bytes) noexcept {
    return std::unexpected(err(DecodeCode::unknown_tag, 3, 0));
}
```

```cpp
// ---- (a) switch dispatch: unknown handling is impossible to miss --------
[[nodiscard]] PayloadResult dispatch_switch(std::uint8_t tag, Bytes p) noexcept {
    switch (tag) {
        case std::to_underlying(MessageTag::add):       return decode_add_p(p);
        case std::to_underlying(MessageTag::cancel):    return decode_cancel_p(p);
        case std::to_underlying(MessageTag::heartbeat): return decode_heartbeat_p(p);
        default: return std::unexpected(err(DecodeCode::unknown_tag, 3, 0));
    }
}
// A dense jump table is POSSIBLE, not guaranteed. Sparse tags -> compare chain.

// ---- (b) 256-entry function table: uint8_t index cannot overflow it -----
using PayloadDecoder = PayloadResult (*)(Bytes) noexcept;

[[nodiscard]] consteval std::array<PayloadDecoder, 256> make_table() {
    std::array<PayloadDecoder, 256> t{};
    t.fill(&decode_unknown_p);                      // explicit unknown, not nullptr
    t[std::to_underlying(MessageTag::add)]       = &decode_add_p;
    t[std::to_underlying(MessageTag::cancel)]    = &decode_cancel_p;
    t[std::to_underlying(MessageTag::heartbeat)] = &decode_heartbeat_p;
    return t;
}
inline constexpr auto kTable = make_table();        // 2 KiB of pointers
[[nodiscard]] PayloadResult dispatch_table(std::uint8_t tag, Bytes p) noexcept {
    return kTable[tag](p);                          // O(1) indirect call
}
// A COMPACT table (say 8 entries) needs `if (tag >= kTable.size()) unknown;` first.
```

```cpp
// ---- (c) visitation of the DECODED result -------------------------------
template<class... Fs> struct overloaded : Fs... { using Fs::operator()...; };
template<class... Fs> overloaded(Fs...) -> overloaded<Fs...>;   // C++17 CTAD

void handle(WireMessage const& m) {
    std::visit(overloaded{
        [](WireAdd const& a)       { apply_add(a.id, a.value, a.side); },
        [](WireCancel const& c)    { apply_cancel(c.id); },
        [](WireHeartbeat const& h) { note_epoch(h.epoch); },
    }, m);
}
// Alternatives: std::holds_alternative<T>(m) · std::get<T>(m) (throws
// std::bad_variant_access) · std::get_if<T>(&m) (returns nullptr) ·
// m.index() · std::visit<R>(vis, m) (C++20 explicit return type).
```

| Dispatch | Cost | Unknown tag | Notes |
|---|---|---|---|
| `switch` | compare chain **or** jump table | `default:` — visible | best for small/sparse tag sets |
| `array<fn*,256>` | 1 load + indirect call | table slot | 2 KiB, no range check needed for `uint8_t` |
| compact `array<fn*,N>` | range check + indirect | explicit branch | **must** bounds-check the raw tag |
| `unordered_map<u8,fn>` | hash + probe + indirect | `find() == end()` | allocation, cache misses — avoid on hot path |
| `std::visit` on result | 1 indirect (table) | n/a — closed set | dispatches decoded values, not bytes |
| virtual `Handler` | vtable indirect | n/a | forces heap/type erasure, open set |

| `variant` fact | Consequence |
|---|---|
| `sizeof` ≈ largest alternative + tag + padding | one fat cold alternative inflates *every* message |
| `valueless_by_exception()` after a throwing assignment | avoid by keeping alternatives nothrow-move-constructible |
| `std::visit` is exhaustive at compile time | a new alternative breaks the build — a feature |
| Alternatives may repeat types | disambiguate with `std::in_place_index<I>` |
| `get<T>` throws, `get_if<T>` returns `nullptr` | prefer `get_if` on the hot path |
| `std::monostate` | gives a default-constructible empty state |

**Interview line** — "`variant` models the decoded closed set of messages; it is never laid over the wire, because its layout is the implementation's business, not the protocol's."

**Traps** — indexing a compact table with an unvalidated tag · `nullptr` table slots turn an unknown tag into a crash instead of an error · `std::visit` over a `valueless_by_exception` variant throws · a tag value legal in v2 but not v1 must be checked *per version*, not globally.

---

## 34.8 Versioning without overlaying packed C++ structs

```text
v1 payload: id:u32 | value:u32                 (8 bytes)
v2 payload: id:u32 | value:u32 | flags:u16     (10 bytes)
```

```cpp
// ---- one internal type, one decoder per version -------------------------
struct AddInternal {                 // normalized, invariant-bearing
    std::uint32_t id{};
    std::uint32_t value{};
    std::uint16_t flags{};           // v1 wire supplies the documented default
};

[[nodiscard]] std::expected<AddInternal, DecodeError>
decode_add_v1(Bytes p) noexcept {
    if (p.size() != 8) return std::unexpected(err(DecodeCode::invalid_length, 0, 0));
    return AddInternal{load_be_u32(p.subspan<0,4>()),
                       load_be_u32(p.subspan<4,4>()),
                       0u};                       // documented v1 default
}
[[nodiscard]] std::expected<AddInternal, DecodeError>
decode_add_v2(Bytes p) noexcept {
    if (p.size() != 10) return std::unexpected(err(DecodeCode::invalid_length, 0, 0));
    return AddInternal{load_be_u32(p.subspan<0,4>()),
                       load_be_u32(p.subspan<4,4>()),
                       load_be_u16(p.subspan<8,2>())};
}

[[nodiscard]] std::expected<AddInternal, DecodeError>
decode_add_versioned(std::uint8_t version, Bytes p) noexcept {
    switch (version) {
        case 1: return decode_add_v1(p);
        case 2: return decode_add_v2(p);
        default: return std::unexpected(err(DecodeCode::unsupported_version, 2, 0));
    }
}
// NEVER: if (p.size() == sizeof(AddV1Struct)) ...   — sizeof is not a protocol fact.
```

```cpp
// ---- version as a compile-time policy where layouts share logic ---------
template<std::uint8_t V> struct AddLayout;
template<> struct AddLayout<1> {
    static constexpr std::size_t size = 8;
    static constexpr bool has_flags = false;
};
template<> struct AddLayout<2> {
    static constexpr std::size_t size = 10;
    static constexpr bool has_flags = true;
};

template<std::uint8_t V>
[[nodiscard]] std::expected<AddInternal, DecodeError> decode_add_t(Bytes p) noexcept {
    using L = AddLayout<V>;
    if (p.size() != L::size) return std::unexpected(err(DecodeCode::invalid_length, 0, 0));
    AddInternal m{load_be_u32(p.subspan<0,4>()), load_be_u32(p.subspan<4,4>()), 0u};
    if constexpr (L::has_flags) m.flags = load_be_u16(p.subspan<8,2>());
    return m;
}

// ---- forward-compatible extensions: TLV with explicit length rules ------
// ext := { type:u8 | len:u8 | bytes[len] } *   (must-understand bit = type & 0x80)
[[nodiscard]] std::expected<void, DecodeError>
scan_extensions(ByteReader& r, DecoderConfig const& cfg) noexcept {
    std::uint32_t seen = 0;
    while (!r.empty()) {
        if (++seen > cfg.max_repeat_count)
            return std::unexpected(err(DecodeCode::limit_exceeded, r.offset()));
        auto type = r.u8();
        if (!type) return std::unexpected(err(DecodeCode::truncated, r.offset()));
        auto body = r.lp8();
        if (!body) return std::unexpected(err(DecodeCode::truncated, r.offset()));
        if (*type & 0x80u)                       // must-understand and unknown
            return std::unexpected(err(DecodeCode::unknown_tag, r.offset(), *type));
        // else: skip — forward compatible. Retain only as a bounded byte view.
    }
    return {};
}
```

**Compatibility questions the spec must answer — write them into the header comment**

| Question | Failure if unanswered |
|---|---|
| Unknown version: reject, or route to a legacy path? | silent misparse |
| Trailing bytes: forbidden, ignored, or preserved? | schema drift, replay mismatch |
| Missing new field: defaulted by which version rule? | two peers disagree on semantics |
| Is a tag's meaning stable across versions? | tag reuse decodes as the wrong message |
| Does `length` include header and/or checksum? | off-by-header on every frame |
| Are reserved bits required to be zero on receive? | can never be used later |
| Is the encoder allowed to emit a shorter old version? | downgrade ambiguity |

**Traps** — inferring version from payload size · one decoder with `if (version >= 2)` sprinkled through it becomes unauditable · storing an unknown extension as a span outlives the buffer · "reserved must be zero" that is never enforced can never be relaxed safely.

---

## 34.9 Checksums and byte-wise operations

```cpp
// ---- simple XOR check (spec: covers bytes [0, length-1), checksum excluded)
[[nodiscard]] constexpr std::uint8_t xor_checksum(Bytes b) noexcept {
    std::uint8_t r = 0;
    for (std::byte x : b) r ^= std::to_integer<std::uint8_t>(x);
    return r;
}

// ---- Internet checksum (RFC 1071): one's complement of one's-complement sum
[[nodiscard]] constexpr std::uint16_t inet_checksum(Bytes b) noexcept {
    std::uint32_t sum = 0;
    std::size_t i = 0;
    for (; i + 1 < b.size(); i += 2)
        sum += (std::to_integer<std::uint32_t>(b[i]) << 8) |
                std::to_integer<std::uint32_t>(b[i + 1]);
    if (i < b.size()) sum += std::to_integer<std::uint32_t>(b[i]) << 8;  // odd tail
    while (sum >> 16) sum = (sum & 0xFFFFu) + (sum >> 16);               // fold carries
    return static_cast<std::uint16_t>(~sum & 0xFFFFu);
}

// ---- CRC-32 (reflected, poly 0xEDB88320, init 0xFFFFFFFF, final XOR all-ones)
[[nodiscard]] consteval std::array<std::uint32_t, 256> crc32_table() {
    std::array<std::uint32_t, 256> t{};
    for (std::uint32_t i = 0; i < 256; ++i) {
        std::uint32_t c = i;
        for (int k = 0; k < 8; ++k)
            c = (c & 1u) ? (0xEDB88320u ^ (c >> 1)) : (c >> 1);
        t[i] = c;
    }
    return t;
}
inline constexpr auto kCrc32 = crc32_table();       // 1 KiB, computed at compile time

[[nodiscard]] constexpr std::uint32_t crc32(Bytes b, std::uint32_t seed = 0) noexcept {
    std::uint32_t c = seed ^ 0xFFFFFFFFu;
    for (std::byte x : b)
        c = kCrc32[(c ^ std::to_integer<std::uint32_t>(x)) & 0xFFu] ^ (c >> 8);
    return c ^ 0xFFFFFFFFu;
}

// ---- bit-by-bit reference implementation: differential-test against it ---
[[nodiscard]] constexpr std::uint32_t crc32_ref(Bytes b) noexcept {
    std::uint32_t c = 0xFFFFFFFFu;
    for (std::byte x : b) {
        c ^= std::to_integer<std::uint32_t>(x);
        for (int k = 0; k < 8; ++k)
            c = (c & 1u) ? (0xEDB88320u ^ (c >> 1)) : (c >> 1);
    }
    return c ^ 0xFFFFFFFFu;
}
static_assert(crc32(Bytes{}) == crc32_ref(Bytes{}));   // empty-input agreement
```

```cpp
// ---- verify where the spec says, before committing decoded state --------
[[nodiscard]] std::expected<void, DecodeError>
verify_frame(Bytes frame) noexcept {              // frame = header + payload + crc32
    if (frame.size() < kHeaderSize + 4)
        return std::unexpected(err(DecodeCode::truncated, 0));
    Bytes const covered = frame.first(frame.size() - 4);          // spec: excludes crc
    std::uint32_t const want =
        load_be_u32(std::span<std::byte const,4>{frame.data() + frame.size() - 4, 4});
    if (crc32(covered) != want)
        return std::unexpected(err(DecodeCode::checksum_mismatch, frame.size() - 4));
    return {};
}
// Constant-time compare only matters for MACs, not for CRCs.
```

**Every checksum spec must pin down**

| Parameter | Example |
|---|---|
| Covered byte range | whole frame minus the 4 trailing checksum bytes |
| Checksum bytes during computation | excluded (alternative: present but zeroed) |
| Initial value / seed | `0xFFFFFFFF` |
| Polynomial and reflection | `0xEDB88320`, input+output reflected |
| Final XOR | `0xFFFFFFFF` |
| Transmitted byte order | big-endian |
| Empty-input result | `0x00000000` for this CRC-32 |
| Version relationship | unchanged across v1/v2 |

- Table-driven CRC trades 1 KiB of D-cache for ~8× fewer operations than the bitwise loop; slice-by-8 trades 8 KiB for more ILP.
- `_mm_crc32_u64` / ARM `__crc32d` implement **CRC-32C** (Castagnoli, poly `0x82F63B78`) — a *different* polynomial from zlib CRC-32; runtime-dispatch and differential-test them.
- A checksum detects accidental corruption; it authenticates nothing — an attacker recomputes it trivially.

**Traps** — checksumming a range that includes the checksum field itself · big/little-endian disagreement on the transmitted checksum · verifying *after* mutating state · confusing CRC-32 with CRC-32C · a second full pass over the frame doubling memory traffic on the hot path.

---

## 34.10 Fuzzable, deterministic decoder interfaces

```cpp
// ================= the public boundary ===================================
[[nodiscard]] DecodeResult
decode_one(Bytes input, DecoderConfig const& cfg) noexcept {
    auto framed = next_frame(input, cfg);
    if (auto* nm = std::get_if<NeedMore>(&framed))
        return std::unexpected(err(DecodeCode::truncated, input.size(),
                                   static_cast<std::uint16_t>(nm->minimum_additional)));
    if (auto* mf = std::get_if<Malformed>(&framed))
        return std::unexpected(mf->error);

    auto const& f = std::get<FrameView>(framed);
    if (cfg.verify_checksum)
        if (auto v = verify_frame(input.first(f.consumed)); !v)
            return std::unexpected(v.error());

    auto msg = dispatch_switch(f.tag, f.payload);
    if (!msg) {
        auto e = msg.error();
        e.offset += static_cast<std::uint32_t>(kHeaderSize);  // rebase to frame start
        return std::unexpected(e);
    }
    return DecodeSuccess{std::move(*msg), static_cast<std::uint32_t>(f.consumed)};
}
static_assert(std::is_nothrow_move_constructible_v<WireMessage>);  // no valueless state
```

**Contract — each line is testable**

| Requirement | Check |
|---|---|
| Input is a bounded span + immutable config | signature only; no globals read |
| No I/O, logging, allocation, or global mutation | `-fsanitize=address` + an allocation-counting hook |
| Never reads past the span for *any* byte pattern | ASan on a fuzz corpus |
| Loops bounded by config **and** remaining input | `max_repeat_count`, `remaining()` |
| Structured error with code + offset + field | `DecodeError` is 8 bytes, trivially copyable |
| `consumed` defined on success **and** failure | success: frame size; failure: resync hint |
| Same bytes + config ⇒ same result | no clock, locale, RNG, pointer identity, or `static` state |
| Never throws for malformed input | every entry point `noexcept` |
| Success implies `consumed > 0` | `length >= kHeaderSize` guarantees it |

```cpp
// ---- libFuzzer entry point ----------------------------------------------
extern "C" int LLVMFuzzerTestOneInput(std::uint8_t const* data, std::size_t size) {
    DecoderConfig cfg{};                      // fixed config = reproducible
    Bytes in{reinterpret_cast<std::byte const*>(data), size};  // OK: byte aliasing
    auto r = decode_one(in, cfg);
    if (r) {
        assert(r->consumed > 0 && r->consumed <= size);     // progress invariant
        std::array<std::byte, 1024> out{};
        auto n = encode_message(out, r->message);           // round trip
        if (n) {
            auto again = decode_one(Bytes{out}.first(*n), cfg);
            assert(again && again->message == r->message);  // requires operator==
        }
    }
    return 0;
}
```

```bash
# build + run the fuzzer with both sanitizers
clang++ -std=c++23 -O1 -g -fsanitize=fuzzer,address,undefined \
        -fno-omit-frame-pointer codec_fuzz.cpp -o codec_fuzz
./codec_fuzz corpus/ -max_len=4096 -runs=2000000 -print_final_stats=1
./codec_fuzz -merge=1 corpus/ new_inputs/        # corpus minimization
```

```text
# Boundary corpus — seed with these, not just with valid frames
empty input; every truncation point 1..N of one valid frame
length = 0, 1, kHeaderSize-1, kHeaderSize, max, max+1, 0xFFFF
declared length > bytes available; declared length < bytes available
every known tag, and tag-1 / tag+1 / 0 / 255
every known version, and version 0 / max+1
field minima, maxima, and invalid sentinels (id == 0, side == 2)
asymmetric endian vectors: 01 23 45 67 89 AB CD EF
permitted and forbidden trailing bytes
max repeat count with minimum-size elements (work amplification)
checksum flipped in each covered region, and in the checksum field itself
```

```text
# Properties to assert
decode(encode(x)) == x                      for every valid x
encode(decode(b)) == b                      for canonical encodings
consumed <= input.size()
success            =>  consumed > 0
failure            =>  destination bytes unchanged
same input+config  =>  same result (run twice, compare)
truncate(valid, k) =>  NeedMore for all 0 <= k < frame_size
optimized_path(b)  == reference_path(b)     for endian and checksum code
```

**Interview line** — "A fuzzable decoder is a pure function from `(span<const byte>, const config&)` to a fixed-size result: no allocation, no exceptions, bounded work, and positive progress on success."

**Traps** — a fuzz harness that reads a config from the environment loses reproducibility · asserting only on valid inputs finds nothing · seeding the corpus only with well-formed frames leaves every boundary unexplored · `assert` compiled out under `-DNDEBUG` silently disables every property · ASan alone misses alignment UB — add UBSan.

---

## Recall card

```text
wire bytes        representation, not an object; no struct overlay, ever
bit_cast          equal size, native layout — not a protocol decoder
framing           header present -> length bounded -> whole frame present
size arithmetic   subtract after proving the prefix; never add and compare
endian load       byte shifts (constexpr) OR memcpy + std::byteswap (C++23)
unaligned         memcpy into a live scalar; never deref a typed pointer
reader            borrowed span; check -> load -> advance; copy = rollback
writer            caller-owned span; [[nodiscard]] expected<void, WriteError>
fixed layout      one exact-size (!=) check proves every static offset
variable layout   per-field checks + count/depth/element/work limits
dispatch          switch | 256-entry table | visit; unknown stays explicit
variant           the decoded result; largest alt + tag; keep moves noexcept
versioning        version selects a DECODER, never a struct layout
borrowed field    valid only while the byte owner stays stable — copy early
checksum          exact covered range; detection, not authentication
decoder API       expected<Success, Error> + consumed; noexcept; pure
progress          success => consumed > 0, or the stream loop spins
testing           every truncation point + fuzz + round trip + reference path
hot path          no allocation, no exceptions, bounded work, 8-byte errors
```

**Core design sentence** — a binary codec proves byte availability and representation before constructing typed values; it never asks the C++ object model to pretend that untrusted storage already contains the protocol's structs.
