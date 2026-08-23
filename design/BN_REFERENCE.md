# Mega Man Battle Network UI / Visual Design Reference

**Scope.** A compact, evidence-led reference for a 1080×1920 portrait Battle Network smart mirror. “Observed” means read from the cited GBA screenshots/sprite sheets; hexes are practical approximations, not Capcom’s source palette.

## 1. PET / terminal screen grammar across the series

- **BN1–2 / Original PET:** The pause terminal is a utilitarian list of destinations: Folder, Library, MegaMan status, Email, Items, Network/link functions, and Save. The Folder is a 30-chip inventory; email entries expose a clear `NEW` state. This is the strongest model for a mirror’s left-rail navigation: one selected row, one active state, no app-card clutter.[21][12]
- **BN3 / Plug-in PET:** A dedicated terminal screen makes the Navi the hero: a large MegaMan portrait/status area with compact utility icons around it. The series’ BN3 screenshot set explicitly includes PET, Folder, Status, Sub Chip, HP Memory, and Navi Customizer screens.[15][16][17] Reference image (240×160): https://static.wikitide.net/megamanwiki/6/6b/MMBN3BPETScreen.png
- **BN4 / Advanced PET:** The PET screen becomes a saturated blue/green/pink “skin” around the same functional information architecture; the screenshot set includes all three color variants and a Folder screen.[30] Blue reference (240×160): https://static.wikitide.net/megamanwiki/3/39/MMBN4_PET_Screen_%28Blue%29.png
- **BN5:** Keep the PET as a command surface, not a desktop: folders, Navi/operation data, terminals, and battle state. The screenshot index includes Progress/Team folders, DS PET, jack-in, and Liberation Mission views.[31] Chip art is available as standard, Navi, Mega, Giga, and Dark sheets.[4][5][33]
- **BN6 / Link PET direction:** The same terminal vocabulary persists, but the presentation is more icon-and-color coded. Spriters references separate Main Menu, Subchip Menu, Email Menu, and Chip Images—useful as a component inventory.[6][7][8]
- **Recommended mirror composition:** A slim “PET header” (Navi name / connection status), a dominant status readout, and a 2-column or vertical list of Folder / Mail / Status / Net. Keep the navigation rail visibly subordinate to the Navi readout.

## 2. Dialogue / message-box grammar

- **Message window:** Treat dialogue as a framed terminal packet, usually a broad lower-screen box with a portrait/mugshot in a side compartment; the portrait is the emotional anchor and text occupies a strict multiline grid. BN2’s screenshot archive includes “Mugshots,” while BN3’s category includes story/status frames that are useful for portrait scale and box proportions.[15][16]
- **Typewriter reveal:** Reveal text character-by-character, with a small advance/caret affordance at the end. The game script’s short PET prompts, mail alerts, and operator/Navi exchanges make the intended rhythm clear even though timing is not documented in a technical spec.[23]
- **Beep cadence:** Use one short, quiet digital tick per character (or per small character cluster), slightly faster for routine text; pause on punctuation and stop on a page break. This is a reconstruction guideline, not a measured original audio timing—keep it optional on an always-on mirror.
- **Portrait box at side:** Use a 1-bit or 2-tone bust silhouette, 48–96 px equivalent at 1080×1920, with a nameplate in the portrait frame. Side placement preserves a clear reading column and survives the mirror’s line-only constraint.
- **“!!” / high urgency:** Battle Network’s signature operator call is literally “Jack in!! MegaMan…”; exclamation count varies by game.[35] For a mirror, render `!!` as a two-frame high-contrast glyph pulse beside the sender/nameplate, not as a full-screen white flash. The screenshot galleries are the visual reference set for alerts, jack-in frames, and game-over frames.[15][30][31]
- **Alert escalation grammar:** normal = cyan/white line frame; attention = amber header + one pulse; danger = red/orange `!!`, a brief border inversion, and a persistent “ACK”/dismiss affordance. Avoid rapid strobing: the physical mirror is viewed at close range.

## 3. Battle Chip / card anatomy

- **Canonical fields:** Official Capcom’s manual labels the Custom Screen fields as chip name, chip code letter, element (None / Fire / Aqua / Elec / Wood), attack power, five-chip select list, Add/OK controls, MegaMan HP, selected chips, and enemy HP.[20]
- **Visual anatomy:** A chip is a compact framed tile with (a) a strong outer border, (b) a central weapon/ability icon, (c) a code letter in a dedicated corner/badge, (d) element icon/color cue, and (e) damage number in a highly scannable numeric position. Do not put the damage number in the name line; isolate it as the power readout.
- **Code behavior:** Codes are not decoration: same-name or same-code chips can be selected together, and later games use `*` as a wildcard.[13][20] For Discord/mirror chips, keep the code letter large enough to be read at a glance and preserve code grouping as a semantic affordance.
- **Sheet references:** BN3 standard chips: https://www.spriters-resource.com/game_boy_advance/mmbn3/asset/814/ ; Mega/Giga: https://www.spriters-resource.com/game_boy_advance/mmbn3/asset/815/ ; BN5 standard sheets: https://www.spriters-resource.com/game_boy_advance/mmbn5/asset/887/ and https://www.spriters-resource.com/game_boy_advance/mmbn5/asset/10718/ ; BN6 chip image sheet: https://www.spriters-resource.com/game_boy_advance/mmbn6/asset/10766/
- **Mirror translation:** Keep a thin outline card, a 16–24 px icon, a 1–2 character code badge, and a small right-aligned power value. Use line-art icon silhouettes rather than filled chip tiles.

## 4. Palette observations (hex approximations)

The GBA references are palette-quantized and vary by game/skin. The following values are sampled/rounded from Spriters sheets and accessible screenshot references; use them as design tokens, not colorimetry.[2][4][5] The screenshot references are cross-checks, not colorimetry.[17][18][35]

| Role | Approx. tokens | Use |
|---|---|---|
| MegaMan.EXE blue/cyan | `#4050A8`, `#6078D8`, `#005098`, `#10F8F8`, `#00A0A0`, `#A8E8E8` | Navi accents, connection lines, selected states; cyan is the brightest “online” signal. |
| Alert orange/yellow/red | `#E08028`, `#F89800`, `#F8D018`, `#F8F080`, `#F83818`, `#A84028` | warning headers, damage, urgent mail, deletion/error feedback. Reserve red for actual danger. |
| Menu greens | `#00B848`, `#08B870`, `#007830`, `#48E070`, `#C0F888` | healthy/active/confirmed states, PET menu families, successful sync. |
| Dark network / Undernet | screenshot samples include near-black charcoal `#2B262A`, violet-black `#3B0840`, deep grey `#282327`, plus bright neon accents; the BN3 Undernet is more charcoal/violet than literal navy.[14][18] | OLED base: `#000000`; optional “network field” line tint `#101428` or `#1A1030`; keep fills absent. |
| Mirror neutral | `#D8F8FF` (main cyan-white), `#80B8C8` (secondary), `#496070` (muted) | Readable line-work at low luminance; tune brightness before adding color. |

**Important:** BN menus often rely on bright blue/green filled panels. On a two-way mirror, invert those fills into 1–2 px outlines, corner brackets, and sparse hatch/grid lines; never port a full bright rectangle literally.

## 5. Typography

- **Original feel:** The GBA UI reads as a compact bitmap/raster face: short line lengths, square counters, tight leading, and all-caps labels. Do not imitate it with a smooth modern sans at tiny sizes; use integer scaling and a pixel grid.
- **Press Start 2P:** Google Fonts, OFL/open-source distribution; deliberately chunky arcade bitmap, best at multiples of 8 px. Good for PET headings, rank labels, and “JACK IN!!”, not paragraphs.[24][29]
- **VT323:** Google Fonts, OFL/open-source distribution; terminal-like, narrow, and more legible for long status/mail text than Press Start 2P.[25][29]
- **Pixelify Sans:** Google Fonts variable pixel display face; good compromise for headings and labels when Press Start 2P is too wide.[26][29]
- **Pixel Operator:** Free/libre raster family, including proportional, mono, small, and bold variants; DaFont records CC0 1.0. Strong candidate for body text and compact chip metadata.[27]
- **monogram:** Monospace bitmap font, free under CC0; includes TTF, bitmap, and PICO-8 formats. Excellent for fixed-width telemetry, HP counters, and code letters.[28]
- **Recommendation:** `VT323` or `Pixel Operator Mono` for body; `Press Start 2P` only for section titles; `monogram` for code/telemetry. Render at integer scale, avoid anti-aliasing, and test mirrored (horizontally flipped) text separately from line art.

## 6. HUD elements / battle-state vocabulary

- **HP:** Persistent player and enemy HP are explicit fields in the official battle-screen breakdown; show value plus a thin horizontal gauge, with a numeric fallback.[20]
- **Custom Gauge:** It fills during the action screen; when full, L/R reopens the Custom Screen. The recurring gauge normally takes about 8–10 seconds to fill.[10][20] Mirror version: a segmented cyan outline bar labeled `CUSTOM`, with a single traveling pixel/scan highlight and a full-state `READY` pulse.
- **Emotion Window:** Introduced in BN4; it changes state based on performance and later reflects bugs, Full Synchro, Rage, Worried/Anxious, Evil, Tired, and transformations.[11] Mirror version: a small framed portrait/status window whose border/state color changes, never a large solid fill.
- **Battle chips held:** The action screen exposes the next usable chip and held chips; use a compact 3–5 slot strip with the current slot bracketed.[20]
- **Busting rank:** Result screen shows time, Busting Level, and rewards; ranks are performance feedback, with S as the top grade in the documented scale.[20][22] Visual grammar: giant outlined `S`, smaller time/HP/counter metrics beneath, and chip/Zenni reward rows—not a dense scorecard.
- **Rank inputs:** Deletion time, flinches/abacks, multiple deletions, movement, and (in later games) Cross use/counter hits affect scoring.[22] For a mirror “NetBattler” role, expose only 2–3 of these as telemetry to retain authenticity without clutter.

## 7. Alerts, flashes, and state changes

- **PET/mail alert:** Use a persistent `NEW` badge or a single blinking corner marker; the BN1 script explicitly stages the PET lighting up and then announces new mail.[23]
- **Jack-in alert:** The verbal/visual punctuation is `Jack in!!` / `MegaMan… transmit/Execute`; use a brief expanding bracket or scanline around the Navi portrait, not a full-screen flash.[35]
- **Battle warning:** Attackable/unsafe panels in battle communicate danger by flashing affected spaces; preserve that idea as a short line-pulse on the affected mirror tile, with a hard cap on frequency.[20]
- **Alert colors:** amber = notice, orange = action required, red = danger/deletion. Pair every color cue with an icon/glyph (`!`, `!!`, triangle, broken-link mark) for color-blind and reflection-heavy viewing.
- **Accessibility / OLED rule:** flash only a small local region, no alternating full-screen red/white, no high-frequency animation, and provide a static “attention pending” state until acknowledged.

## Mirror adaptation notes

1. **Motifs that survive on pure black:** cyan/navy line grids, PET corner brackets, chip-code badges, portrait silhouettes, thin HP/Custom outlines, `NEW`/`!!` glyphs, rank letters, scanline separators, and sparse Undernet violet accents. These remain legible as light-on-black line-work and leave reflection space.
2. **Motifs that need inversion:** bright blue PET/menu rectangles, green selection fills, white chip-card bodies, and full-screen battle backgrounds. Convert each to outline-only geometry; use a 1 px outer rule + 1 px active rule, with a tiny glow only on the active element.
3. **Composition for 1080×1920:** reserve the center/face zone as near-black negative space; place PET status and time in upper corners, mail/alerts in a narrow side rail, and chip/HUD telemetry in a lower rail. Avoid recreating a 240×160 game screen as a large filled panel.
4. **Brightness budget:** default to muted `#496070`/`#305060`; allow `#10F8F8` only for active/online moments; reserve `#F83818` for danger. Prefer one bright focal element at a time.
5. **Burn-in cautions:** do not pin a bright `CUSTOM` bar, border, clock digits, or static Navi silhouette at constant intensity. Slowly drift idle line positions, rotate accent locations, dim after inactivity, and vary alert/selected-state brightness. Keep any high-luminance alert under a short duration and in a small area.
6. **Authenticity without literal copying:** the strongest BN cues are information grammar—PET tabs, code letters, element tags, Custom readiness, portrait-led messages, `!!` operator urgency, and Busting ranks—not large colored UI fills. Preserve those relationships and the mirror will read as Hermy.EXE rather than a generic cyberpunk dashboard.

## Sources

[2] https://www.spriters-resource.com/game_boy_advance/mmbn3/asset/814 — Spriters Resource — BN3 Battle Chips
[4] https://www.spriters-resource.com/game_boy_advance/mmbn5/asset/887 — Spriters Resource — BN5 Battle Chips 1-90
[5] https://www.spriters-resource.com/game_boy_advance/mmbn5/asset/10718 — Spriters Resource — BN5 Mega/Giga/Dark chips
[6] https://www.spriters-resource.com/game_boy_advance/mmbn6/asset/10766 — Spriters Resource — BN6 Chip Images
[7] https://www.spriters-resource.com/game_boy_advance/mmbn6/asset/10883 — Spriters Resource — BN6 Main Menu
[8] https://www.spriters-resource.com/game_boy_advance/mmbn6/asset/19757 — Spriters Resource — BN6 Email Menu
[10] https://megaman.fandom.com/wiki/Custom_Gauge — MMKB — Custom Gauge
[11] https://megaman.fandom.com/wiki/Emotion_Window — MMKB — Emotion Window
[12] https://megaman.fandom.com/wiki/Folder — MMKB — Folder
[13] https://megaman.fandom.com/wiki/Battle_Chip — MMKB — Battle Chip
[14] https://megaman.fandom.com/wiki/Undernet — MMKB — Undernet
[15] https://megaman.fandom.com/wiki/Category:Mega_Man_Battle_Network_3_screenshots — MMKB — BN3 screenshot category
[16] https://megaman.miraheze.org/wiki/Category:Mega_Man_Battle_Network_3_screenshots — Miraheze — BN3 screenshot category
[17] https://megaman.miraheze.org/wiki/File:MMBN3BPETScreen.png — Miraheze — BN3 PET screenshot
[18] https://megaman.miraheze.org/wiki/File:Undernet.jpg — Miraheze — BN3 Undernet screenshot
[20] https://game.capcom.com/manual/REXEAC/vol1/en/steam/page/1/2 — Capcom — Battle Screen official manual
[21] https://gamefaqs.gamespot.com/gba/457634-mega-man-battle-network/faqs/49840/sub-screen — GameFAQs — BN1 Sub Screen guide
[22] https://www.therockmanexezone.com/wiki/Busting_Level_in_Mega_Man_Battle_Network — Rockman EXE Zone — Busting Level
[23] https://gamefaqs.gamespot.com/gba/457634-mega-man-battle-network/faqs/25164 — GameFAQs — BN1 game script
[24] https://fonts.google.com/specimen/Press+Start+2P — Google Fonts — Press Start 2P
[25] https://fonts.google.com/specimen/VT323 — Google Fonts — VT323
[26] https://fonts.google.com/specimen/Pixelify+Sans — Google Fonts — Pixelify Sans
[27] https://www.dafont.com/pixel-operator.font — DaFont — Pixel Operator
[28] https://datagoblin.itch.io/monogram — itch.io — monogram
[29] https://developers.google.com/fonts — Google Fonts licensing
[30] https://megaman.fandom.com/wiki/Category:Mega_Man_Battle_Network_4_screenshots — MMKB — BN4 screenshot category
[31] https://megaman.fandom.com/wiki/Category:Mega_Man_Battle_Network_5_screenshots — MMKB — BN5 screenshot category
[33] https://www.spriters-resource.com/game_boy_advance/mmbn5/asset/10724 — Spriters Resource — BN5 Navi Chips
[35] https://megaman.miraheze.org/wiki/File:MMBN4_PET_Screen_%28Blue%29.png — Miraheze BN4 blue PET encoded
