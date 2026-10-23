Round 59's dark numbers were measured at drifted coordinates. Sampling Claude's own dark empty state on the fold again:

| element | round 59 | actual |
|---|---|---|
| composer card | `#18191B` | **`#20201F`** |
| soft circles (+ / mic / pill) | `#38393B` | **`#313131`** |
| search field | none drawn | **`#1A1A19` with a `#484847` hairline** |
| round button | ink circle | **paper `#F9F9F7` circle, ink icon** |

The round button now has its three real states:

- **light, empty** - ink circle, paper waveform
- **light, with content** - washed ember `#E1C0B3`, white arrow
- **dark** - paper circle, ink waveform

The search field got two new composition locals (`LocalField`, `LocalFieldLine`) so it is white-on-cream in light and `#1A1A19`-on-`#151515` in dark, with the hairline visible in both - it drew no border at all before.

Every value here comes from the same screenshot set. The device locked itself mid-pass, so this build has not been photographed yet; the constants are exact but the render is unverified. That check is first on the list when the screen is back.