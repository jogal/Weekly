# Generated Monk breathing sprites

Built-in image generation was used to create separate exhale and inhale drawings. No CSS scaling or procedural pose synthesis is used. The existing action guard is the character/style reference; `sprites/monk_lv1x2.png` is the previous two-frame motion reference.

Final assets: `sprites/monk-idle/lv{1,10,20,30,40}.webp`, each 640 × 384 (two 320 × 384 cells). `tools/import_monk_idle.cjs` only extracts, uniformly scales each pair together, and aligns the generated sprites on a common foot baseline. It does not manufacture the second pose. Original PNGs and action atlases are unchanged.

## Lv1–30 prompt

Use case: identity-preserve. Production transparent pixel-art sprite atlas for the existing Weekly Quest app.
EDIT the four action-sheet references into an idle BREATHING animation. Images 1–4 are Lv1, Lv10, Lv20, Lv30; each has three poses. In EACH reference, the LEFTMOST GUARD pose is the exact canonical character. Image 5 is the OLD idle sheet: use it ONLY to understand how subtle two-frame breathing works, NOT for character design.
Deliver ONE transparent atlas with EXACTLY TWO columns and FOUR rows (8 separate full-body sprites), preferably 1024x2048. Row order Lv1,10,20,30. Equal cells, centered figures, ample transparent margins.
LEFT column = the original canonical guard at rest/exhale, faithfully copied from the LEFTMOST pose of that row's action reference.
RIGHT column = genuinely redrawn inhale frame: the chest expands slightly, shoulders rise a little, bent elbows open a little, fists move outward/up a small amount. These are separate articulated body changes, NOT a stretched/scaled duplicate. Breathing is gentle and small but perceptible when the frames alternate; no punching, no flexing, no expression change.
CRITICAL invariants between columns: identical face, eyes, mouth, head shape, hairstyle, head size, muscle mass, costume and every accessory. Identical foot positions, stance, leg shape, overall scale, camera, lighting, palette, pixel density, and foot baseline. Keep head essentially fixed. Keep the lower half exactly matched. Move only chest, shoulders and bent arms slightly. Both frames retain the ready/guard pose. No added or missing wraps, jewelry or armor.
Lv1 black tank top/black shorts/sneakers/wrist wraps.
Lv10 open black gold-edged vest/red sash/black trousers/white wraps/white headband/sandals.
Lv20 black gold vest/crimson ornate white-gold apron/gold arm bands/white wraps/sandals.
Lv30 bare torso/gold-black bracers/red-white-gold waist panels/knee guards, NO necklace.
Precisely match the action references' pixel-art rendering, outlines and shading. No smooth-vector reinterpretation, no new character, no growth or change of proportions.
Background must be actual transparent alpha. No checkerboard, colored bands, labels, text, ground, shadows, particles or effects. The horizontal colored bands in any reference are transparent-area preview artifacts and MUST NOT appear.

## Lv20 wrap correction

Precise correction to input image 1 (the transparent 2-column,4-row breathing atlas). Preserve its entire layout, all eight poses, faces, body proportions, breathing differences, pixel style and transparency.
Change ONLY the forearms in ROW THREE (Lv20), in BOTH columns: replace the black/gold armored bracer on the viewer-left forearm with WHITE CLOTH WRAPS matching that character's viewer-right wrist and the LEFTMOST GUARD pose in reference image 2. Lv20 has white cloth wrist/forearm wraps on BOTH arms and gold bands on upper arms. Do not add armor. Do NOT change row four: Lv30 keeps its black/gold bracers. No other edits, no rescaling, no new objects or text. Actual transparent alpha.

## Lv40 prompt

Use case: identity-preserve. Production transparent two-frame pixel-art breathing idle sprite for Weekly Quest.
Image 1 is the current Lv40 action sheet; its LEFTMOST GUARD is the canonical character. Image 2 is the old two-frame idle solely as a motion reference, not a costume reference.
Create ONE sprite sheet with exactly TWO equal cells side by side, preferably 1024x640. LEFT: faithfully copied current Lv40 leftmost GUARD in exhale/rest. RIGHT: same guard during gentle inhale, slightly wider chest, shoulders a little higher and bent elbows a little farther apart, small distinct articulated arm movement. This must be separately drawn, not a vertically stretched duplicate.
Both must match the Lv40 action character exactly: identical face, eyes, hair, expression, head size, headband, muscles, skin, gold necklace with blue jewel, ornate gold bracers, white/gold/red waist clothes, kneepads, wraps, gold sandals. Full-body, same fixed feet and baseline, same stance, same leg position and size, same light/palette/pixel clusters and outlines. Keep head essentially fixed and lower half matched. Only chest shoulders and forearms move a small amount. No flex or punch, no new jewelry.
Center each character in its half, equal 8% padding around every side. Exact same scale in both cells. Actual transparent alpha, no shadow, ground, labels, text, checkerboard, background or colored horizontal streaks from reference preview artifacts.
