# Monk action art provenance

Generated with the built-in image generation tool; existing idle sprites are unmodified.
Reference inputs: `sprites/monk_lv1x2.png`, `monk_lv10x2.png`, `monk_lv20x2.png`, `monk_lv30x2.png`, `monk_lv40x2.png`.
Production assets: `sprites/monk-actions/lv{1,10,20,30,40}.webp` (960 × 384, three 320 × 384 frames: guard, punch, flex).
The transparent generated atlas was split into 15 connected sprites, scaled by equal character height and padded to common cells using `tools/import_monk_actions.cjs` (Sharp, build-time only). No runtime dependency added.

## Initial prompt

Use case: identity-preserve. Asset type: production transparent sprite atlas for an existing PWA.
Edit the five supplied Monk reference sprites into action poses. Deliver ONE transparent PNG atlas laid out in an EXACT regular grid of THREE equal columns and FIVE equal rows (15 isolated full-body characters), ideally 1536 wide x 2560 tall. No labels, text, separators, floor, shadows, background or new effects.
Reference inputs in order: row1 Lv1, row2 Lv10, row3 Lv20, row4 Lv30, row5 Lv40. Each reference has two nearly identical idle frames; use its FIRST character as canonical for its row.
COLUMN 1: ready/guard, both elbows bent, fists at mid-chest.
COLUMN 2: a karate straight punch (seiken-zuki), one clenched fist thrust slightly forward to viewer-left at chest level, the opposite fist chambered at the waist. NOT a raised fist or uppercut.
COLUMN 3: double-biceps flex, both elbows raised outwards and bent with fists near head height, confident but same restrained facial expression.
All figures have the SAME HEIGHT, foot baseline, camera, and body center within each equal cell; all limbs fully within cell with generous transparent margins. Both feet stay planted in the reference stance. The head, hair silhouette, eyes, face, skin tone, bone structure, shoulder width, leg length, height and ~4-head proportions MUST match each original. No muscle/body size growth, no chibi reinterpretation. Only articulation of arms and slight shoulder rotation change. Keep exact outfit of that row: row1 black training tank, black shorts, trainers, wrapped wrists, no headband; row2 open black vest, red sash, baggy black pants, wraps and sandals, white headband; row3 gold-trim open black vest, crimson/gold sash and hanging apron, black pants and sandals; row4 bare torso, black/gold forearm guards, dark red/gold/white waist apron, sandals; row5 bare torso, gold necklace, ornate white/gold/red waist garments and gold guards/sandals. Preserve original hair and face at every tier.
Match the references' crisp pixel-art clusters and shading, not vector or smooth painted art. Keep consistent pixel density and fine detail at every cell. For all levels clothing/gear are the only design differences; poses are the same across rows. Source poses are intentionally changed as explicitly requested, but the character's identity and physique remain invariant. Actual transparent alpha background, no black rectangle or checkerboard.

## Targeted correction

Edit the generated 3-column, 5-row atlas. Add transparent cell margins so no head, hand or foot is clipped. Match row FOUR to the supplied original `monk_lv30x2.png`: black/gold forearm guards, red sash, black/red/white/gold hanging apron, bare torso with no necklace. Keep row FIVE's white/gold outfit and necklace. Preserve the 15 poses, identities, body scale, pixel style and alpha; no new objects or text.

Pose-dependent silhouette widths differ from the original idle art. Since SW v50, the guard cell in this atlas is also the canonical resting Monk in Gym, Workout completion, and Weekly's status/zoom views. This reuses identical pixels for rest and guard without generating another interpretation. The original idle PNGs remain unmodified as fallbacks.
