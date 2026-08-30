# Lumen EPUB engine

`@flow/epub-engine` is Lumen Read's browser EPUB rendering engine. It is a
source-level, TypeScript-maintained fork of the epub.js-compatible
[`likecoin/epub.ts`](https://github.com/likecoin/epub.ts) baseline.

The reader app imports the stable `@flow/epubjs` facade rather than this package
directly. That keeps application imports and persisted reading preferences
independent from engine internals.

## Scope

This package is intentionally browser-only. Its entry point is TypeScript source
that Next transpiles as part of the extension build; it is not a native Node.js
or CLI package. Parsing-only Node coverage is retained in the test suite.

## Verification

From the repository root:

```sh
pnpm --filter @flow/epub-engine typecheck
pnpm --filter @flow/epub-engine test
pnpm --filter @flow/reader typecheck
```

The test suite covers EPUB parsing, archive resources, CFIs, pagination,
reflow, resize recovery, annotations, themes, and iframe rendering behavior.

## Upstream and license

The exact upstream commit, retained BSD-2-Clause license, and every
Lumen-specific patch are listed in [UPSTREAM.md](./UPSTREAM.md).
