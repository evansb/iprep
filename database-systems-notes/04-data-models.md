# Lecture 4 — Data Models

*Map reference: I.D. Sources: CMU 01.*

A **data model** is a vocabulary for describing data. A **schema** is a description of a specific dataset written in that vocabulary. The distinction matters: "relational" is a model; `orders(id, customer_id, total)` is a schema.

This lecture surveys the models, then argues why one of them won and why the others keep coming back.

---

## 1. What a data model commits you to

Choosing a model fixes four things before you write a single query:

- **The unit of data** — a tuple? a document? a key/value pair? a node?
- **The legal relationships** — how do units refer to each other, and is that reference checked?
- **The access primitives** — what operations are natural, and what requires effort?
- **Where the schema lives** — enforced by the system, or implied by the application?

The last one is the most consequential in practice. Schema does not disappear when you drop the `CREATE TABLE`; it relocates into application code, where nothing validates it and no two services agree on it.

---

## 2. The pre-relational models

Worth knowing because they explain what the relational model was reacting against.

### 2.1 Hierarchical (IMS, 1966)

- Data is a **tree**. Each record has exactly one parent.
- Access is **navigational**: the program traverses parent-to-child, explicitly, one step at a time.
- **The fatal limitation:** many real relationships are not trees. A student takes many courses; a course has many students. Representing this requires duplicating one side, and duplication means update anomalies.

### 2.2 Network / CODASYL (1969)

- Generalizes the tree to a **graph**. A record may participate in many "sets" (owner–member relationships).
- Fixes the many-to-many problem.
- **But:** access remains navigational. The application must know the physical link structure and traverse it manually.

### 2.3 Why navigation lost

This is the argument of Codd's 1970 paper, and it is the founding argument of the field:

- **Queries are programs.** Answering a new question means writing and debugging new traversal code.
- **No data independence.** The physical link structure is visible in the application. Reorganizing storage breaks every program.
- **No optimizer is possible.** The application specified *how*, so the system has no freedom to choose a better *how*.
- **Reasoning is hard.** There is no algebra over navigational programs — no way to prove two traversals equivalent, and therefore no way to rewrite one into a faster one.

**The relational insight:** describe data as *relations*, query them *declaratively*, and let the system choose the access path. Everything the system can optimize, it can only optimize because you did not specify it.

---

## 3. The relational model

Covered fully in Lecture 5; summarized here as one model among several.

- **Unit:** a tuple in a relation. Attributes drawn from domains.
- **Relationships:** by *value*, not by pointer — a foreign key holds the referenced key's value, and the system checks it.
- **Access:** declarative, via a language grounded in relational algebra.
- **Schema:** system-enforced, stored in the catalog.

**Its three durable advantages:**

- **Data independence** — physical layout can change beneath unchanged queries.
- **Optimizability** — a formal algebra permits provably equivalent rewrites, hence cost-based planning.
- **Declared, enforced integrity** — constraints live in one place and hold on every access path.

**Its genuine costs:**

- Normalization spreads one logical entity across several tables, so reassembling it requires **joins**.
- The tabular shape mismatches nested application objects — the **impedance mismatch**.
- Rigid schemas make evolution a migration, not an edit.

---

## 4. Key/value and wide-column

### 4.1 Key/value

- **Unit:** an opaque value under a unique key.
- **Access:** `get(k)`, `put(k, v)`, `delete(k)`. Sometimes range scan, if keys are ordered.
- **The defining property:** the value is opaque *to the system*. It has no columns, so the system cannot filter, index, or aggregate on its contents.
- **Consequence:** the only access path is the key. Any other query is a full scan performed by the application.
- **What you get for that:** the simplest possible model to partition and scale — a key hashes to a node, and there are no cross-key relationships to preserve.
- **Examples:** Redis, DynamoDB (in its simple form), RocksDB as an embedded engine.

### 4.2 Wide-column

- **Unit:** a row key mapping to a sparse, dynamic set of columns, grouped into **column families**.
- Not "a column store" — the name is unfortunate. It refers to rows having *many, varying* columns.
- **Sparsity is free**: a row with 3 columns and a row with 3,000 columns coexist without wasted space, because absent columns are simply not stored.
- **Access:** by row key, then by column range within the row. Still fundamentally key-driven.
- **Examples:** Cassandra, HBase, Bigtable.

**When key/value or wide-column is the right answer:** the access pattern genuinely is "look up by this one key," the value has no queryable structure, and horizontal scale matters more than query flexibility. Session stores, caches, and time-series-by-device are honest fits.

---

## 5. Document

- **Unit:** a self-describing nested record — JSON, BSON, XML.
- **Relationships:** by embedding (nesting the related data inside) or by reference (storing an identifier, resolved by the application).
- **Access:** by key, or by paths into the document structure; the system *can* see inside the value, unlike key/value.
- **Schema-on-read** — the document carries its own field names; the system does not require them to be consistent across documents.

**The honest assessment:**

- **The real win:** hierarchical data that is always read and written as a unit avoids the join-and-reassemble cost. An order with its line items, fetched whole, is one read instead of two tables and a join.
- **The real cost:** "schemaless" means "no enforced schema," not "no schema." Every consumer still assumes a shape. The assumptions merely become undocumented, unvalidated, and divergent across services.
- **Embedding versus referencing is the central modeling decision**, and it recreates the normalization question exactly: embed and you duplicate (update anomalies), reference and you join (in application code, without an optimizer).

**Note that this is not an either/or.** PostgreSQL's `jsonb` gives you documents *inside* a relational system, with GIN indexing on document contents. You can enforce a schema on the stable fields and leave the volatile ones in a document column — usually a better answer than choosing one model for the whole system.

---

## 6. Graph

- **Unit:** nodes and edges, each carrying properties (the *property graph* model).
- **Relationships are first class** — an edge is a stored object, not a value coincidence.
- **Access:** traversal — "friends of friends," "shortest path," "all nodes reachable within 3 hops."

**Why not just use relational?** You can. An edge table is a perfectly good graph representation. The difference is cost and expression:

- A *k*-hop traversal in SQL is a *k*-way self-join, or a recursive CTE. Both are expressible; both are awkward.
- Cost grows badly when *k* is unbounded or data-dependent, and the optimizer estimates such joins poorly.
- Graph engines store adjacency directly, making "follow this edge" a pointer dereference rather than an index probe.

**When it genuinely wins:** variable-depth traversal, pathfinding, and pattern matching over relationships — fraud rings, recommendation, network topology. When the depth is fixed and shallow, relational is usually fine.

---

## 7. Array, matrix, and vector

- **Unit:** an ordered, dimensioned collection. Position carries meaning — element `[i][j]` is not interchangeable with `[j][i]`.
- **Access:** by coordinate, by slice, or by whole-array operation.
- **Domains:** scientific data, imagery, time series, and machine-learning tensors.

**The vector case deserves separate attention**, because it has become a mainstream requirement:

- An **embedding** is a fixed-length float vector representing a piece of text, an image, or a user.
- The query is not equality or range but **similarity**: "the *k* nearest vectors to this one" under some distance metric.
- **This breaks every classical index.** A B-tree orders on one dimension; nearest-neighbor search in 768 dimensions has no such ordering. Exact search degrades to a full scan.
- Hence **approximate nearest neighbor** indexes — IVFFlat, HNSW — which trade guaranteed correctness for speed, and are tuned by a recall/latency knob rather than being simply correct.
- **The conceptual novelty:** an index that returns *probably* the right answer. Nothing else in the classical index toolbox works this way. Section V.E covers it.

---

## 8. Comparing the models

| Model | Unit | Relationships | Access primitive | Schema |
|---|---|---|---|---|
| Hierarchical | record in a tree | one parent | navigate | fixed, in program |
| Network | record in a graph | owner–member sets | navigate | fixed, in program |
| **Relational** | **tuple** | **by value, checked** | **declarative query** | **enforced, in catalog** |
| Key/value | opaque value | none | key lookup | none (in application) |
| Wide-column | sparse row | none across rows | row key + column range | partial |
| Document | nested record | embed or reference | key + path | on read |
| Graph | node / edge | first-class edges | traversal | usually flexible |
| Array/vector | dimensioned collection | positional | coordinate / similarity | fixed shape |

**Read the "schema" column top to bottom.** The industry moved from schema-in-program (hierarchical), to schema-in-system (relational), to schema-in-application (NoSQL), and is now moving back toward schema-in-system — evidenced by schema validation added to document stores and by typed columns added to key/value services. The requirement never disappeared; only its enforcement location moved, and the unenforced position proved expensive.

---

## 9. Why relational won, and what NoSQL was actually about

**Relational won because of the optimizer.** Declarative queries mean the system chooses the plan, which means the system can improve without the application changing. No other model offered that, and forty years of accumulated optimizer research is not easily replicated.

**The 2000s NoSQL movement is often misremembered as a rejection of the relational model.** It was mostly a rejection of two other things:

- **Single-node scaling limits** — the systems of the era did not partition well, and horizontal scale was the pressing need.
- **Strong consistency costs** — coordination is expensive across a network, and many workloads did not need it.

Neither of these is a property of the *relational model*; both are properties of particular *implementations*. This is confirmed by what happened next: distributed SQL systems (Spanner, CockroachDB, Yugabyte) deliver horizontal scale *with* the relational model, and NoSQL systems have steadily added schemas, secondary indexes, joins, and transactions. The convergence is toward "relational model, distributed implementation."

**The durable lesson:** distinguish the *model* from the *implementation*. Complaints about relational databases are usually complaints about a specific system's storage engine or deployment topology.

---

## 10. PostgreSQL as a multi-model system

Worth noting concretely, since it undercuts the premise that you must choose:

- **Relational** — the core.
- **Document** — `json` and `jsonb`, with path operators and GIN indexing on contents.
- **Key/value** — `hstore`, or simply a two-column table.
- **Array** — first-class array types with indexing support.
- **Vector** — `pgvector`, providing IVFFlat and HNSW indexes.
- **Graph** — recursive CTEs for traversal; extensions for richer graph querying.
- **Geospatial** — PostGIS, via GiST indexing over spatial types.

**The general pattern:** the extensible index framework (Section V.F) means a new data model largely reduces to new types, new operators, and a new operator class. The relational engine — transactions, recovery, the optimizer — is reused unchanged.

**The pragmatic advice:** reach for a specialized system when the workload is dominated by that model and the scale demands it. Reach for a column in PostgreSQL when it is one part of a broader application. Operating one system well beats operating three systems badly, and consistency across models is otherwise your problem to solve.

---

## 11. Takeaways

- A data model fixes the unit of data, the legal relationships, the access primitives, and **where the schema is enforced**.
- **Navigational models lost because they specified *how*.** Declarativity is what enables data independence and cost-based optimization — the two things that let a system improve without the application changing.
- **"Schemaless" relocates schema into application code.** It does not eliminate it, and the unenforced location is where the cost shows up.
- **Every model recreates the normalization dilemma:** embed and duplicate, or reference and join. Only the enforcement differs.
- **Vector search is genuinely new**, because it introduces indexes that are approximate by design.
- **Separate model from implementation.** Most criticisms of "relational databases" are criticisms of one engine's scaling story.

**Next:** the relational model in depth — structure, integrity, and the algebra that makes optimization possible.
