# Catalogue OS — Technical Blueprint

**Tool:** an internal, mobile-first brochure/catalogue factory for our own interior-hardware
range — plywood, laminates, edge bands, aluminium profiles, handles, hinges, channels.

**Who uses it:** a manufacturer's sales rep standing in a dealer's showroom, and the
marketing manager who owns the master catalogue.

**What it does:** raw input in (photos, specs, finish codes, MOQ, services) → a branded,
print-ready PDF and a WhatsApp-shareable link out. Target: **90 seconds at the counter.**

**Date of analysis:** 20 Nov 2026. Versions and prices researched by sub-agents; re-verify
any pin before it goes into `package.json`.

---

## 0. Scope — internal tool (decided 20 Nov 2026)

This is **not a product we sell.** It is an internal tool for one company's own catalogue: our
products, our brand, our sales team. That deletes roughly half the plan and changes the economics
completely.

**Cut entirely**

| Cut | Why it was there | Why it goes |
|---|---|---|
| Multi-tenancy, orgs, roles | SaaS architecture | one company, one brand |
| Billing, plans, credits | SaaS | nobody pays |
| Dealer portals, co-branding | channel SaaS | internal output only |
| Public onboarding, marketing site | acquisition | five known users |
| Play Store / App Store launch | distribution | EAS internal distribution or TestFlight — days, not weeks |
| Link analytics, growth loops | product metrics | vanity for an internal tool |
| Per-tenant attribute dictionaries | multi-brand | hard-code **our** real taxonomy — it will actually be right |

**Kept, and now done better**

- The attribute dictionary stays as a *design*, but it is **one** dictionary: our real SKU range,
  our real finishes, our real grades. No abstraction tax.
- Templates become **bespoke to our brand** instead of generic-and-safe. That is where the
  world-class look actually comes from.
- Best-of-N composition and the vision critic are now trivially affordable — nobody is counting
  fractions of a rupee.
- A **maker–checker** step (one person drafts, one approves) replaces "trust the AI". Cheap to
  build, and it is what makes internal output trustworthy.

**What it costs:** about 4 weeks instead of 18 for a usable v1, and a few hundred rupees a month
to run.

**What it does not change:** quality still comes from photography. Internal use does not make bad
photos acceptable — it makes them worse, because our own sales team compares the brochure to the
real product standing in the showroom.

---

## 1. The one architectural bet

> The app never designs. It **captures structured facts**, an LLM **writes copy into fixed
> slots**, and a **server-side renderer** turns hand-built templates into a PDF.

Everything follows from that. It is why output looks professional, why it is repeatable at
500 SKUs, and why the AI cannot break the layout.

A second bet sits underneath it: **the data model knows what the domain is.** `0.8 mm edge
band`, `BWP / IS 303:2024`, `CTC 128 mm`, laminate code `MER-5124` are typed attributes, not
free text. Canva can never beat us here — it has no idea what a plywood grade is.

---

## 2. System architecture

```
┌──────────────────────────────────┐
│  Expo app (iOS + Android)        │
│  capture · catalogue · brief     │
│  preview (server-rendered pages) │
└───────────────┬──────────────────┘
                │ HTTPS, signed URLs
┌───────────────▼──────────────────┐
│  Hono API (Node 24, TypeScript)  │
│  auth · catalogue · projects     │
└──────┬────────────────┬──────────┘
       │                │
┌──────▼──────┐  ┌──────▼─────────────────────┐
│ Postgres    │  │ BullMQ + Redis             │
│ + pgvector  │  │ extract → copy → render →  │
└─────────────┘  │ publish                    │
                 └──────┬──────────────┬──────┘
                        │              │
              ┌─────────▼────┐  ┌──────▼─────────────────┐
              │ DeepSeek     │  │ Renderer               │
              │ flash        │  │  Chromium  → RGB PDF   │
              │ text + vision│  │  WeasyPrint → PDF/X-4  │
              └──────────────┘  └──────┬─────────────────┘
                                       │
                                ┌──────▼────────┐
                                │ R2 + share    │
                                │ links + CDN   │
                                └───────────────┘
```

**One template source, two renderers.** Templates are plain HTML/CSS in a versioned repo.
Both renderers consume the same template; only the output profile differs.

---

## 3. The conflict the six analyses produced — and the call

| Question | Product/UX said | AI pipeline said | Print said | **Call** |
|---|---|---|---|---|
| PDF engine | `@react-pdf/renderer` | Playwright/Chromium | **WeasyPrint 70** (CMYK, PDF/X-4) | **WeasyPrint for print, Chromium for preview** |
| Colour | — | RGB is fine | CMYK + output intent | CMYK on the print path from week 1 |
| PDF preview | — | — | preview the artefact, never HTML | page PNGs from server |

**Why two engines:** Chromium cannot emit CMYK or a PDF/X output intent — a print shop in India
will either convert it (colour drift) or reject it. WeasyPrint can, but its CSS support is
narrower and it has no JavaScript, so it is a poor fit for the instant in-app preview.

**Decision (revised on the quality-first brief — latency is not a constraint):**

- **Print path = WeasyPrint 70 from week one**, not month three. Free, CMYK, PDF/X-4 metadata,
  no commercial licence.
- **Chromium = preview and digital link only.** Same template file, RGB, fast.
- **Templates live in the intersection of the two engines:** absolute mm positioning, tables,
  transforms, inline SVG. Never `writing-mode`, never runtime JS, never container queries.
  Every template is render-diffed on both engines before it ships (§3a).
- **Prince XML (~$3,800/server) is the upgrade, not the start.** Better justification and
  hyphenation; buy it when a customer's press rejects the type, not before.
- **Never** render the print PDF on the phone. `expo-print` / WebView + html2canvas cannot do
  bleed, embedded fonts or 300 ppi — that is the mistake that kills the product.

---

## 3a. The quality standard — what "world-class" means operationally

"World class" is not a renderer setting. It is a short list of things that are individually
checkable. Weighted by what a buyer actually perceives:

| Lever | Weight | What good looks like | Owned by |
|---|---|---|---|
| Photography | ~55% | one lighting setup, consistent crop, cut-out or shared background, no phone shadows | image pipeline |
| Typography | ~20% | one serif + one grotesque + one mono, four sizes max, real leading, no faux bold | design system |
| Grid & whitespace | ~10% | 12-col grid, 18 mm margins, baseline rhythm, nothing within 8 mm of trim | template |
| Colour discipline | ~8% | 2 brand colours + tints, coded finish chips, proofed CMYK builds | brand kit |
| Copy | ~7% | specific and technical; no adjective that could describe any product | LLM + rules |

The single most important consequence: **a mediocre iPhone photo cannot be rescued by a better
template.** If the photography lever is not solved, nothing else matters. That is where the
budget goes first.

### The gate — nothing publishes without passing it

Deterministic, fail closed:

1. **Geometry** — 216×303 mm page, trim box, 3 mm bleed, 8 mm safety.
2. **Fonts** — embedded, subset, **CID outlines, not Type 3**, no silent substitution.
3. **Images** — ≥ 250 ppi at placed size, converted to the output colour space, no upscales.
4. **Ink** — max 300% total; rich black only where specified.
5. **Colour** — every swatch carries a code; no unlabelled colour anywhere.
6. **Overflow** — no text box overflows, no clipped descenders.
7. **Numbers** — every numeral in generated copy exists in the source data.

Judgement, scored 1–10 by a vision model looking at the rendered page, regenerate below threshold:

8. **Hierarchy** — can a stranger find the product name, the size and the CTA in three seconds?
9. **Whitespace** — is anything crowding the trim or another element?
10. **Photography** — is this product lit and cropped like the rest of the catalogue?

### Because latency is not a constraint, we can afford best-of-N

Generate three candidate compositions per spread, render all three, score each with the critic
plus the deterministic checks, keep the winner. This is exactly what an art director does — we
just do it forty times per catalogue instead of three.

Cost impact: ~3.5× the AI and render spend, i.e. **₹30–45 per catalogue instead of ₹10**. At
internal volume that is noise — and it is the difference between "AI generated" and "designed".

### What building the specimen actually proved (20 Nov 2026)

Two engine-parity failures surfaced in the first hour, both invisible on screen:

- **Type 3 embedding.** A CFF-outline sans (Instrument Sans) came out of Chromium as *Type 3*
  fonts — rejected by many Indian RIPs. Swapping to a TrueType-outline grotesque (Barlow) fixed
  it. The preflight gate must check the font *format*, not just "embedded: yes".
- **`writing-mode` is unsupported in WeasyPrint.** The cover's vertical spine silently rendered
  horizontally and upside-down. Rebuilt with `transform: rotate(-90deg)`, which both engines
  honour.

Both are the argument for render-diffing every template on both engines before it ships, and
for never trusting "it looks right on screen".

### What is still unproven

The specimen is PDF/X-4 by metadata, **not yet by validation**: it carries no output intent
dictionary because no ICC profile is attached. Attaching FOGRA39 and running veraPDF is a
week-one task, before any customer sees the words "print-ready".

---

## 4. Client — Expo / React Native

You asked for React Native; this is the pragmatic 2026 version of that choice.

| Layer | Pick | Note |
|---|---|---|
| Runtime | Expo SDK 58, RN 0.88, React 19.3, New Arch | pin `expo@58.0.26`, upgrade only at `x.1` |
| Navigation | Expo Router 58 | file routes, typed links |
| Server state | TanStack Query 5 | persisted to `expo-sqlite/kv-store` |
| Draft state | Zustand 5 | the brochure being edited |
| Offline DB | `expo-sqlite` + Drizzle ORM | skip WatermelonDB at this stage |
| Lists | FlashList 2 | v2 requires New Arch |
| Images | `expo-image`, `expo-image-manipulator` | downscale to 2048 px JPEG 0.8 **on device** |
| Upload | presigned PUT to R2, SQLite retry queue | survives Android killing the app |
| Preview | server-rendered page images + WebView | `react-native-pdf` is unproven on RN 0.88 — validate wk 1 |
| Share | `expo-sharing` + `wa.me` deep link | the actual distribution channel |
| Auth | magic link or a shared PIN | five known users — no DLT, no OTP, no roles |
| Build | EAS Starter ($19/mo), dev/preview/prod channels | native change → build; JS change → OTA |

**Folder shape**

```
app/                 (auth) (tabs) catalog/[id] project/[id]
src/db/              client.ts schema.ts migrations/
src/api/             supabase.ts queries/ mutations/ uploadQueue.ts
src/features/        catalog/ capture/ project/ share/
src/components/ui/   Button Sheet Field  (own primitives)
src/stores/          draftProject
supabase/functions/  ai-copy render bg-remove
```

**Honest caveat:** with PDF rendering server-side, a PWA would have covered most of this and
saved ~3 developer-weeks. RN earns its place on three India-specific things: uploads that
survive Android task-killing, no iOS storage eviction, and an app icon the dealer tier trusts
more than a URL. Keep it — but do not let native features creep into the MVP.

---

## 5. Backend and AI pipeline

**API:** Hono 4 on Node 24. Web-standard handlers, shares Zod/TypeScript types with the app.
**DB:** Postgres + pgvector ("find the laminate from last year's catalogue").
**Queue:** BullMQ + Redis — an explicit job graph beats a magic workflow engine at this size.
**Storage:** Cloudflare R2 — **zero egress**, which matters when a 8 MB PDF gets opened 20× on
WhatsApp. Use R2 signed URLs for PDFs and photos; skip S3.

### Three prompts, never one mega-prompt

1. **Extract** — supplier PDF / WhatsApp text → JSON. Temperature 0, JSON mode, Zod validate,
   max 2 self-repair retries, then human queue. Returns a `source_quote` per numeric field.
2. **Write copy** — one call per section in parallel, into named slots (headline, 40-word intro,
   3 benefit bullets ≤ 12 words, spec-table labels). Model may rephrase, never introduce.
3. **Translate** — glossary-locked. `BWP`, `IS 303`, model numbers and dimensions are never
   translated.

Static prefix (system + template rules + glossary) goes **first** to hit DeepSeek's cache-hit
rate, which is ~50× cheaper than fresh input.

### Hallucination guardrails (non-negotiable)

This is a compliance-sensitive category. A brochure that prints "BWP, IS 303" on an MR-grade
board is a liability, not a copy bug.

- Every number in generated prose must already exist in the source JSON — regex check, else
  regenerate.
- Extraction output is rejected unless its `source_quote` is a literal substring of the parsed
  input.
- `thickness_mm`, `grade`, `size_mm` are enum-validated against the attribute dictionary.
  Unknown → `null` + `needs_review`, never guessed.
- Persist prompt hash, model, page/span, and reviewer — dealers will dispute MOQ.
- "E0" is not a BIS class. Flag it as a warning, never print it as a standard.

### Vision

DeepSeek flash (vision-capable, ~1,024 tokens/image) for tagging: hero vs detail, finish,
product type, "is this even a handle?". ~$0.0003/image. Put it behind an `LLMProvider`
interface from day one — single-vendor lock-in is an existential risk, not a style preference.

---

## 6. Rendering: the parts that decide whether it survives contact with a printer

**Geometry:** A4 210×297 → 216×303 with bleed. A5 148×210 → 154×216. Art box 8 mm inside trim.
12 mm gutter for perfect binding. 300 ppi at placed size (≈2480 px across A4); warn < 250, fail
< 200. Hairlines 0.25 pt.

**Layout model:** products are **slots** (½, ¼, ⅙ page) that get bin-packed. Not free flow.
That makes pagination deterministic, kills orphan pages, and lets a 500-SKU batch render
without a human.

**Running heads and TOC:** Chromium cannot do `target-counter()` or `string-set()`. If a
template needs page-numbered contents, that page is a WeasyPrint/Prince job — decide per
template, not per product.

**Finish colours that don't lie:** CMYK has no specular. Print a coded chip strip
(`SS`, `MB`, `AB-PVD`, `RG-PVD`) with starting builds, one legend page, plus hero photography.
Starting points: stainless 20/10/5/0 · matt black 40/30/30/100 · antique brass 20/35/65/25 ·
rose gold 15/35/30/10. **Always proof on the shop's actual press** — Indian shop-to-shop
variance dwarfs your ICC discipline.

**Preflight (fail closed):** trim/bleed box, page count, colour spaces, output intent, max
total ink, fonts + embed/subset status, effective ppi per image, min stroke, QR decode match,
PDF/X validation, file hash, PASS/WARN/FAIL per line.

**IDML:** not MVP. If an agency or a dealer-chain brand team needs an editable master, sell it
as a priced escape hatch ("Agency Pack") in month 4+.

---

## 7. Data model — the actual moat

Do not model products as columns. Model an **attribute dictionary**: one versioned row per
attribute per tenant, which simultaneously drives the capture form, the LLM prompt, the print
spec table and the validator. Adding "anti-termite" then needs no migration.

```jsonc
// dictionary row → form field, prompt fragment, spec row
{ key: "thickness_mm", en: "Thickness", print: "Thick", type: "enum", unit: "mm",
  values: [4,6,9,12,16,19], facet: "spec", appliesTo: ["boards"],
  priority: 1, llm_hint: "available 6–19 mm", req: true }

// product family + explicit variant axes
{ id, brand, category: "edgeband",
  attrs: { material: "PVC", width_mm: 22, thickness_mm: 0.8 },
  axes: [{ key: "width_mm", values: [22,44] }],
  variants: [{ sku, attrs: { width_mm: 44 }, moq: { qty: 100, uom: "m" },
               price: { mrp, dealer, gst_pct: 18 } }],
  color: { code: "MER-5124", family: "beige", lab: [78.2, 2.1, 14.6] },
  relations: [
    { type: "matches_color", to: "prd_lam_5124", basis: "code", score: 0.95 },
    { type: "fits_profile",  to: "prd_prof_g25", basis: "groove_mm:6" }
  ] }
```

**Why CIELAB:** "give me the edge band that matches this laminate" becomes a ΔE lookup, not an
LLM guess. Print a cross-sell only above score 0.85 — and label it "closest match", never
"matches".

**Starter taxonomy (18 attributes, 6 categories)**

| Category | Key attributes |
|---|---|
| Boards | grade (MR/BWR/BWP), IS 303:2024 \| IS 710, thickness 4–25 mm, sheet 2440×1220, core, emission E1/E2, warranty, ISI licence |
| Laminates | thickness 0.8/1.0/1.5/2.0, finish (gloss/matt/texture/metallic), design (plain/woodgrain/marble), colour code + L\*a\*b\* |
| Edge bands | material (PVC/ABS/acrylic/veneer/aluminium), width 22/28/35/44/55, thickness 0.4/0.8/1.0/2.0, matching code |
| Profiles | type (G/gola, C, T 22 mm, handle 35/42, skirting, end-cap), finish (natural anodised, black anodised, CP, brushed, PVD) |
| Handles | material (SS304/zinc/aluminium/brass), CTC 96/128/160/192/224/320, load 5–15 kg, finish |
| Hinges & channels | hinge type + 35 mm cup; channel type, length 250–550, load 25–45 kg |

**Variant rule:** axes draw only from dictionary values; cap the cartesian product at ~60 SKUs
or split the family. Thin variants (0.8 vs 1.0 mm laminate) are axes, not families — that is
what stops catalogue bloat.

**Import paths:** CSV/XLSX (column-mapping wizard with saved per-supplier profiles), supplier
PDF (extract → review cards), WhatsApp paste. All three land in a staging table → Zod → human
diff review. **Never a direct catalogue write.**

---

## 8. Cost and latency

24-page catalogue, 50 SKUs, 45 photos, EN + HI.

| | 1k/mo | 10k/mo |
|---|---|---|
| AI tokens (blended) | ~$45 | ~$450 |
| Render compute | ~$0.30 | ~$3 |
| Storage (~98 MB each) | ~$3 | ~$25 |
| Fixed infra | ~$85 | ~$220 |
| **Per catalogue** | **~$0.13 (₹11)** | **~$0.07 (₹6)** |

With best-of-3 composition and a critic pass (§3a), multiply the AI line by ~3.5: about
**$0.35–0.45 (₹30–40) per catalogue**. At ~30 catalogues a month internally, the whole pipeline
runs **well under ₹1,500/month** including infrastructure.

Cost is no longer a design constraint. The only budget that matters is the reviewer's time — so
optimise the review screen, not the token bill.

**Latency is not a constraint.** The brief is quality-first, so the pipeline may take minutes:
three candidate compositions, a critic pass, a preflight round and one repair cycle. What still
matters is *perceived* progress — show the work ("composing page 4 of 12 · attempt 2 of 3"),
never a bare spinner. Budget **3–6 minutes per catalogue, hard ceiling 15**.

---

## 9. Product surface

```
Splash → sign-in (company SSO or a shared PIN)
Home ─┬─ Catalogue (grid │ search │ scan │ filter)
      ├─ [+] new product (camera → 6-field form → AI copy card)
      ├─ Projects (draft │ in review │ approved │ shared)
      ├─ Brand kit (logo, colours, fonts, contact — set once)
      └─ Settings (language)
Product ▸ live preview ▸ template picker
Preview ▸ Download PDF ▸ Share link ▸ WhatsApp
Batch   ▸ select → pagination preview → queue → progress → results
Review  ▸ page-by-page approve / reject-with-note → re-render
```

**Form vs chat: 85/15.** Specs are structured facts; a form is faster and cannot hallucinate.
Chat appears only for "describe it your way", "make it shorter", "fix this".

**Two doors on home** — *Build a catalogue* (batch, 500 SKUs, async, deterministic pagination)
and *Make a one-pager* (single SKU). Same document model, different sampler.

**The capture loop is the whole product.** A rep should see a draft within a minute, then let the
render finish in the background. Optimise capture → draft, not capture → PDF: the file lands
while they are still in the showroom, which is exactly when they need it.

**Maker–checker.** Every catalogue moves draft → review → approved. The checker sees the page
next to the source data, not the PDF alone, so an invented spec is visible at a glance. Cheapest
quality control we can build, and the one that would actually prevent a bad print.

**Share safety:** links are per-recipient and revocable; dealer price and MRP are hidden unless
explicitly included. Even internally, a forwarded link is a leak.

---

## 10. Build plan

| Week | Ship | Exit test |
|---|---|---|
| 1 | Repo, **our real attribute dictionary**, brand kit, **one bespoke template** rendered through WeasyPrint | a 4-page PDF our printer accepts without a phone call |
| 2 | Expo shell: catalogue, camera capture, form, live preview, share; image pipeline (cut-out, crop, shadow) | a rep makes a one-pager from a phone |
| 3 | AI copy + guardrails, spreadsheet batch render, maker–checker review | 20 SKUs from our sheet → 8 pages, zero invented specs |
| 4 | Preflight report, PDF/X-4 output intent, internal distribution build | the team uses it without us in the room |

**Four weeks to useful, six to good.** The gap is the second and third template plus the
photography pipeline — not features.

---

## 11. Risks

| Risk | Why it bites | Mitigation |
|---|---|---|
| **Invented specs** | a brochure is a written claim; a wrong grade or MOQ is a liability | quote-grounding + numeral subset check + maker–checker gate |
| **Print colour drift** | approved on screen, wrong on press | coded chips, one physical proof, "digital only" badge until proven |
| **Bad phone photos** | the single biggest quality lever, ~55% of perceived quality | guided re-shoot, server cut-out, consistent shadow, reject < 200 ppi |
| **Chrome ≠ print** | RGB only, Type 3 fonts, no output intent | WeasyPrint is the print path; render-diff every template on both engines |
| **Template drift** | a small CSS change breaks pagination silently | golden-file tests: fixed JSON → expected page images + hash |
| **Nobody owns the data** | internal tools rot when the spreadsheet owner leaves | one named catalogue owner; specs live in the app, not in a file |
| **"Good enough"** | internal tools stop being improved | one review pass per quarter against a real catalogue |
| **Expo SDK churn** | three releases in 2026 | pin, upgrade at `x.1` |

---

## 12. Open decisions

1. **What is the brand?** Logo, two colours, fonts, and the tone — "architectural and quiet"
   (the specimen) or "loud and commercial". This determines every template, so it is answer one.
2. **Who owns the catalogue data?** One named person who approves specs. Without that, the tool
   becomes a second and wrong source of truth within a month.
3. **What does the output have to do?** Print for dealers, WhatsApp PDFs, trade-show panels? Each
   implies a different format ladder — A4 spec sheet, A5 flyer, 3 × 2 m stand panel.
4. **How many SKUs, really?** Forty changes the UI. Five hundred changes the importer and the
   batch renderer.

---

## 13. Tamil and the Kanyakumari market

**The taste is carried by language and information, not by ornament.** A kolam border and a
temple silhouette read as costume — and, worse, as cheap. What actually signals *this was made
for us*: Tamil first, a real price with GST status, BIS/ISI marks, the dealer's own name and
phone number, local place names, units the trade actually quotes in.

### Two registers, not one

| | **Showroom** | **Counter** |
|---|---|---|
| Reader | architect, designer, showroom walk-in | contractor, dealer, site carpenter |
| Density | airy, one product per page | dense, spec and price in one glance |
| Colour | bone, ink, restrained | maroon, gold, high contrast |
| Language | English with Tamil accents | Tamil first, English for technical values |
| Job | desire | comparison and ordering |

Both are legitimate. They are different products for different rooms. Ship both templates and
let the user choose per document — the same SKU, two audiences.

### Tamil typography — hard rules, not preferences

1. **Never uppercase Tamil.** The script has no case; `text-transform:uppercase` breaks
   conjuncts. Use a separate class for Tamil labels.
2. **Never letterspace Tamil.** Tracking splits vowel signs from their consonants. Latin labels
   may be tracked; Tamil may not.
3. **Add 15–20 % line-height** versus Latin at the same size — Tamil has deeper ascenders and
   descenders, and tight leading collides.
4. **Set `lang="ta"`** on Tamil runs; it drives font selection and line breaking.
5. **Keep technical values in Latin script** — `BWP`, `IS 303`, `22 × 9 mm`, `MOQ`, `GST`.
   Translating them makes the brochure useless to the trade.
6. **Units are category-specific.** Plywood is quoted per square foot (8×4 = 32 sq ft), profiles
   and edge bands per metre, handles per piece. A single generic "price" column is wrong.

### The engine constraint (found while building this, 20 Nov 2026)

Neither free renderer is currently acceptable for **Tamil print**:

- **WeasyPrint 70 mangles mixed Tamil/Latin lines.** It maps Latin digits inside a Tamil run to
  Tamil glyphs instead of falling back — reproduced with five different Tamil families. Pure
  Tamil lines render correctly; anything containing digits does not. That rules it out as the
  print engine for this market.
- **Chromium shapes Tamil correctly** but embeds the Tamil faces as **Type 3**, which PDF/X
  forbids. Visually correct, will print from most local presses, but cannot be called print-ready.

Options, in order of preference:

1. **Prince XML trial** — the only HTML→PDF engine with both proper Indic shaping and clean font
   embedding. Validate in week one against the 14-day trial, before paying.
2. **InDesign handoff** — the app emits layout and content as IDML; a designer finishes the print
   file. Slower, but it is how Indian print shops already work.
3. **Outline the Tamil text** before rendering, so text becomes vector paths. Removes the font
   problem entirely, at the cost of selectable text.

Digital output (WhatsApp PDF, share link) is unaffected — Chromium is correct there.

**Every Tamil string in the specimen needs a native reviewer before it goes to print.** That
review step is not optional politeness; it is a workflow requirement in the app.
