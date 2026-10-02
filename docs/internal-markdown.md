# Internal Markdown processing

This is an internal layer of `@liria24/site-admin`, not a separately published plugin or a new package export. It uses the installed Comark 0.7.0 and comark-content 0.4.1 APIs. Versions and exports remain unchanged.

The root workspace declares the same existing Comark version as a test development dependency so integration tests import its public APIs without reaching into `node_modules` or relying on transitive hoisting. There is no new runtime dependency or dependency upgrade.

## Inventory and ownership

| Module                     | Input → output                                                                   | Responsibility                                                                                                                           |
| -------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `src/markdown/assets.ts`   | Source → serializable `{ id, position }[]`                                       | Conservative reference metadata shared by validation and the rendering plugin. Positions are occurrence ordinals, not character offsets. |
| `src/markdown/assets.ts`   | Source + synchronous ID-to-URL callback → source                                 | Compatibility adapter for the public entry API's existing Markdown string projection.                                                    |
| `src/markdown/assets.ts`   | Comark parse state + ID-to-URL callback → mutated AST                            | `site-admin-assets` resolves supported static destination attributes. It does not mutate or serialize the original Markdown.             |
| `src/markdown/plugins.ts`  | Existing Markdown configuration + resolver → plugins                             | Plugin ordering, native summary composition, and summary destination safety.                                                             |
| `src/markdown/content.ts`  | Already-public entries + model schema + configuration + resolver → ComarkContent | JSON Source, nested Markdown field schema, `json()` and `markdownFields()` integration.                                                  |
| `src/markdown/document.ts` | Parsed document/fields → text/documents                                          | Existing document recognition, recursive text extraction, whitespace normalization, and nested Markdown collection used by LLMS output.  |

`validation.ts` still owns field traversal, relation references and `$markdown` field paths. `SiteAdmin` still owns database access, authorization, readiness, transactions, revision ledgers, public visibility, relation projection, public asset copies, deletion/GC, publication generation and content cache invalidation. Only already-public entries enter the content helper. No parser performs I/O or reads authorization state. No new runtime Vue/Nuxt dependency is introduced.

The existing content Source keeps its keys, prefix, schema, `_siteAdmin` metadata and `onError: 'throw'`. LLMS title selection, summary text, whitespace handling, description length and URL construction are unchanged.

## Compatibility decisions

The old collector scans every `site-admin://asset/([A-Za-z0-9_-]+)` occurrence. That behavior is deliberately retained, including duplicates, code examples, plain text, frontmatter, unused reference definitions, arbitrary/bound props and the valid prefix of a malformed ID. Existing revisions store those positions in `site_admin_asset_refs`; publishing an older revision does **not** reconstruct that ledger. Switching validation to AST-only references would silently remove deletion protection and change public visibility. Adding newly decoded references would also diverge from older ledgers. Neither change belongs in a migration-free refactor.

Save, restore, schedule and publish therefore accept/reject the same references as before. Unknown or non-ready IDs still fail existing readiness checks, even when present only in code examples. Asset copies, retained-revision deletion protection and public downloads continue using the existing policy and ledger. Internal reference metadata is not added to public `document.meta`.

There are two explicit projection contracts:

- `getPublicEntry()`, `listPublicEntries()`, route projections and nested related entries retain their existing URL-resolved Markdown **strings**, including the old textual replacement behavior. The adapter preserves every unrelated character, line ending and space. Related entry fields are not parsed by the parent model's Markdown field schema.
- `content()` parses original Markdown for the model's declared Markdown fields, including object/array nesting, and resolves actual AST destinations. Stored/revision Markdown never changes. This intentionally corrects substitution inside examples and arbitrary props; it is not a claim of byte-for-byte rendering equivalence with the old global replacement.

| Parsed content                                                                                    | `content()` behavior                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Markdown images, links, autolinks, reference-style destinations                                   | Resolve a complete canonical URI whose ID occurs in the captured body reference set. Repeated uses resolve independently.                                              |
| Comark/HTML custom component static `src`, `href`, `xlink:href`                                   | Same rule as standard elements. No repository-defined custom component asset-prop registry existed.                                                                    |
| Code fences, inline code, text examples, escaped syntax, comments, frontmatter                    | Preserve parsed content; do not rewrite URI text.                                                                                                                      |
| Arbitrary attributes, `poster`, `srcset`, bound/dynamic `:src` or `v-bind:href`, structured props | Preserve; do not evaluate bindings, resolve expressions or recursively rewrite strings. Consumer plugins remain responsible for their own semantics.                   |
| Destination decoded by Comark to an ID absent from captured body references                       | Remove that destination attribute. Do not turn an untracked reference into a public URL. A decoded spelling of an ID captured from the body is safe to resolve.        |
| Empty IDs or destination suffixes such as `.png`, `/extra`, `?query`, `#fragment`                 | Remove the internal destination attribute; the supported URI is exactly `site-admin://asset/<id>`. The legacy ledger/string adapter still retains its prefix behavior. |
| Ordinary HTTP(S) links containing an example URI                                                  | Leave untouched.                                                                                                                                                       |

Untracked encoded destinations do not introduce new save/publish failures; they remain untracked and are not exposed by the AST plugin. Supporting additional URI encodings, suffixes or dynamic asset props needs an explicit reference-ledger compatibility design.

## Comark ordering and safety

Comark 0.7.0 applies default plugins, then user plugins in order; the first user plugin of a given name wins. Its normal AST has no character offsets. The implementation never assumes otherwise and uses neither parser internals nor source reserialization.

1. Native Comark defaults parse the document (including frontmatter, HTML, components and attributes).
2. Internal `site-admin-assets` captures body references in its `pre` hook after native frontmatter extraction and before consumer hooks can introduce new destinations. Unlike the save-time full-source ledger collector, this capture excludes frontmatter-only occurrences. The references stay on that parse state, not the public document. Its `post` hook resolves canonical static destinations. The callback is synchronous and deterministic. Generated destinations alone are checked through native `comark/plugins/security` before insertion, so replacing a previously safe custom scheme cannot introduce a dangerous URL. Other props are left alone.
3. Existing configured plugins run in their original relative order, with async hooks awaited by Comark. A configured security plugin sees resolved URLs, not an internal scheme that might subsequently bypass its protocol/prefix policy.
4. Native `summary()` retains the configured delimiter/disable behavior and existing user override precedence. It rebuilds summary nodes from **tokens**, not the transformed body AST.
5. Internal `site-admin-summary-assets` clones the serializable summary AST before resolving it, so a consumer summary override that shares body nodes cannot cause the summary safety pass to mutate the body. It resolves those separate nodes, checks generated destinations, and applies the first configured plugin named `security` to the summary tree as well. This deliberately closes the previous summary safety gap. Arbitrary consumer plugins are not executed a second time. Their custom sanitizers/derived metadata remain their responsibility; only the native `security` plugin name is recognized for this additional pass.

The source reference set, pending destinations and summary tree are local to each parse. There is no shared parse cache or mutable reference state. Reapplying resolution to ordinary public URLs does nothing. SiteAdmin uses complete, non-streaming documents; this layer makes no streaming or async-resolver guarantee. Exceptions propagate through the existing content error behavior.

Consumer `pre` hooks now receive original internal URI text, whereas the previous public-source projection replaced it before parsing. Consumer `post` hooks see resolved destinations. Pre hooks cannot cause the internal resolver to expose an ID absent from the original source. Trusted consumer plugins that create their own URLs or mutate internal parse state still own that behavior; this layer is not a sandbox for plugins.

## Implementation and verification plan

Baseline: clean `E:\git\site-admin` on `main`, `b7449642c18a234c08008e1d2762b147eb88284b`, matching remote main at inspection. Worktree: `refactor/internal-markdown`. Open draft release PR #2 changes only the package version and is excluded from this work. Root `AGENTS.md` requires uppt releases; no nested repository skills/instructions were present.

1. Inventory validation, public hydration, Comark Source/schema/plugins, summary and LLMS text processing; inspect installed parser/types/security implementations.
2. Extract pure source reference metadata and the explicit string compatibility adapter; build the internal AST plugin and plugin composition.
3. Move Source/schema and document-text helpers; feed original source only to declared Markdown fields in `content()` while retaining public string and relation projections.
4. Add behavior tests for URI grammar, nested nodes/fields, component props, literals, ordering, summary, safety, repeated application and concurrent parse isolation.
5. Use migrated in-memory SQLite and memory Files fixtures to exercise populated ledgers, unchanged revisions, readiness, public URLs, publication cache generations, restore, private originals/public copies, deletion protection and GC. Never use production data.
6. Run repository scripts: `format:check`, `lint`, `workspace:check`, `unused`, `typecheck`, `test`, `build`, `test:nuxt`, `test:cloudflare`, `package:check`, `test:packed`. Verify the unchanged packed export boundary and review the final diff. Report unavailable platforms separately; CodeQL/Ubuntu CI are not implied by Windows local checks.

There is no schema/data migration, release, tag, publish, deployment or credential change. Rollback is the scoped source/test/docs diff only; stored Markdown and ledgers require no backfill or reversal. The known difference is content AST rendering of examples/unsupported destinations and summary safety, documented above.
