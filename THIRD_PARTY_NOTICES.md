# Third-party notices

What this repository ships that is somebody else's work under a licence that asks to be named where
the work is distributed. Code dependencies carry their licences in their own packages; this file is
for what reaches a person's device as itself, for what was copied or ported into this tree and so
has no package to carry its licence, and for a package that does not say its licence where a tool
would look.

## Pretendard

The typeface the app is drawn in, shipped with it since 2026-10-03 as the package's own files,
unmodified (`pretendard` on npm; the variable face, cut into `unicode-range` slices).

- Copyright (c) 2021 Kil Hyung-jin, with Reserved Font Name Pretendard.
- https://github.com/orioncactus/pretendard
- Licensed under the SIL Open Font License, Version 1.1. The licence text is in the package
  (`pretendard/dist/LICENSE.txt`) and at https://openfontlicense.org.

The name is reserved: a modified or re-subset copy may not be distributed under it. The app imports
the package's stylesheet and font files as they are.

## partial-json

The reader of a tool call's arguments while they are still being written
(`app/src/lib/copilot/partial-json.ts`), part of the app since 2026-10-13. A port of `partial-json`
0.1.7 into this tree, kept to the original's answers; the package itself is not installed.

- Copyright (c) 2023 Promplate Dev Team
- https://github.com/promplate/partial-json-parser-js
- Licensed under the MIT License. The copyright notice and the licence text are in the head of the
  file.

## shadcn/ui

The part of shadcn's stylesheet the app's components are written against
(`app/src/shadcn-tailwind.css`), copied into this tree on 2026-10-13 from `shadcn` 4.21.1,
`dist/tailwind.css`, with the rules the app does not use left out. The package is not installed.

- Copyright (c) 2023 shadcn
- https://github.com/shadcn-ui/ui
- Licensed under the MIT License. The copyright line is kept in the head of the file; the licence
  text is in that repository.

## AG-UI

The protocol every Bot is spoken to in: `@ag-ui/client` in the server, `@ag-ui/core` and
`@ag-ui/encoder` in the Bot's service, `@ag-ui/core` in the app for its types, and `@ag-ui/proto`
under them, each at 0.0.57 and unmodified.
Dependencies like any other, named here because their `package.json` files say no licence: it is
the file in each package.

- Copyright (c) 2025, as the file says, with no holder named.
- https://github.com/ag-ui-protocol/ag-ui
- Licensed under the MIT License. The licence text is in each package (`@ag-ui/client/LICENSE`).
