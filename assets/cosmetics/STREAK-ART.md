# Streak milestone item art

Each streak rung grants one item, named `<item id>.png` here and registered
in `src/constants/cosmetic-images.ts`. The files below are placeholder
recolours of existing items (the first four in the ember palette, the rest a
120 degree hue shift of the base). Replace a file with the same name and size
as the base PNG (same canvas, same anchor) and nothing else changes. The ids
are permanent once a tester owns one; the slot is part of the id.

| Streak | Id | Placeholder base | Real art needed |
|---|---|---|---|
| 7 | accessory.badge_ember | accessory.badge_gold | ember badge |
| 14 | face.streak_14 | face.blush_red | face item, "14 Day Reward" until Sean names it |
| 30 | body.scarf_ember | body.scarf_gold | ember scarf |
| 60 | head.streak_60 | head.beanie_orange | head item, "60 Day Reward" until Sean names it |
| 100 | head.crown_ember | head.crown_orange | ember crown |
| 180 | accessory.streak_180 | accessory.bell_gold | accessory, "180 Day Reward" until Sean names it |
| 365 | face.mask_phoenix | face.mask_gold | phoenix mask |
| 500 | body.streak_500 | body.cape_red | body item, "500 Day Reward" until Sean names it |
| 1000 | head.streak_1000 | head.crown_gold | head item, "1000 Day Reward" until Sean names it |

The five `*.streak_N` placeholders look like recolours of shop items on
purpose: Sean draws the real ones. Never a drawn cat.
