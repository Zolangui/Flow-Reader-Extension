# Lumen EPUB engine facade

`@flow/epubjs` is the stable integration boundary used by the reader. Its
runtime implementation is provided by the local `@flow/epub-engine` package.
That engine began from [`@likecoin/epub-ts` 0.6.10](https://github.com/likecoin/epub.ts),
a maintained TypeScript-compatible continuation of the epub.js 0.3 API; its
exact upstream baseline and local patches are documented in
[`@flow/epub-engine`'s UPSTREAM.md](../epub-engine/UPSTREAM.md).

Keeping the Lumen package name means application code and stored typography
preferences do not depend on a third-party package path. `RenditionSpread` is
also retained as a compatibility export for existing settings.

## Security

EPUB files are untrusted, local HTML. The reader always creates renditions with
`allowScriptedContent: false` and `allowPopups: false`; book content therefore
does not receive script or popup permissions.

The facade also keeps Lumen's defensive `Contents` guards. An iframe can be
destroyed during a fast tab change while the engine is reading layout styles.
The guards return a neutral value when the iframe window or its computed style
is unavailable, preventing a transient teardown race from closing the reader.

## Update policy

Before updating the engine baseline, test:

1. opening EPUB 2, EPUB 3, fixed-layout, image-heavy, CJK and RTL books;
2. first render, page turns, continuous mode, font/theme changes and resize;
3. table of contents, publisher page lists, search, CFI restoration and generated locations;
4. highlights, underlines, notes and annotation removal;
5. Firefox and Chromium-family extension builds, including AMO validation.
