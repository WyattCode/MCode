# Command palette / Linux UI strings — locale fallback

## What this covers

Strings added for Linux UI trust/speed (PR #186) and the Ctrl+K command-palette expansion
(`polish/linux-ui-command-palette`) are authored in:

- `zh-CN` (reference table)
- `zh-TW`
- `en`

Examples: `searchOverlay.commands`, `searchOverlay.cmd.*`, `searchOverlay.placeholderWithCommands`,
`side.settingsGearTip`, `set.secureStorage*`, and any new command titles that reuse existing keys
(`side.newTask`, `side.artifacts`, `set.nav.*`, `set.appearance`, `set.shortcuts`, …).

## Fallback for other locales

`t()` resolves as:

```ts
TABLES[language.value]?.[key] ?? en[key] ?? key
```

So `ar`, `bs`, `da`, `de`, `es`, `fr`, `ja`, `ko`, `nb`, `pl`, `pt-BR`, `ru`, `th`, `tr`, `uk`
(and any future generated table) show the **English** string when a key is missing, rather than a
raw key or an empty label. No per-locale copies of the new palette keys were written in this slice
to avoid churning the large generated tables.

## When to expand

Add translations into the generated language tables (or regenerate them) when a release wants
full coverage for these keys beyond the en fallback.
