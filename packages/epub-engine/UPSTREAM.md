# Upstream and maintenance policy

`@flow/epub-engine` began as a source-level import of
[`likecoin/epub.ts`](https://github.com/likecoin/epub.ts), the maintained
TypeScript continuation of the epub.js 0.3 API.

## Imported baseline

- Upstream package: `@likecoin/epub-ts` 0.6.10
- Upstream commit: `4ef5347b199232861b019e0e97a7b5f5a1ca7824`
- Imported: 2026-08-04
- Upstream license: BSD-2-Clause, retained in [LICENSE](./LICENSE)
- Original epub.js copyright notices are preserved in the imported source.

## Lumen-specific changes

- `src/managers/views/iframe.ts` always uses `iframe.srcdoc` for inline EPUB
  documents. The old dynamic document-write fallback is intentionally removed: all
  browsers targeted by Lumen support `srcdoc`, and avoiding dynamic document
  writes keeps the extension compatible with strict Firefox review and CSP
  rules.

## Update policy

The reader imports `@flow/epubjs`, its stable compatibility facade, rather
than this package directly. Any upstream update must be reviewed as a source
change, documented here, and checked against the engine test suite plus the
reader's EPUB 2, EPUB 3, fixed-layout, RTL, CJK, annotation, search, resize,
and multi-tab restoration flows.

The `test/` directory is retained from the upstream project as the regression
baseline. Lumen-specific regressions belong in that suite rather than in the
application layer whenever they exercise rendering-engine behavior.
