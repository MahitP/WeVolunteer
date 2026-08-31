# Third-party notices

Components WeVolunteer **copies to the browser**, with the licence each is
supplied under.

**Status: incomplete as shipped.** The obligations below are real and the bundle
does not currently discharge them. What is missing, and why, is in
[Open item](#open-item-the-bundle-ships-no-notices) at the end. This file exists
so the inventory is accurate and reviewable now, not so it can be called done.

---

## Why a hosted web application has notices at all

The folk rule is that hosted software has no attribution obligation. That is
true of code which only ever executes on the server — nothing is copied to
anybody, so no licence condition is triggered.

It is not true of a single-page application. React, Leaflet, pdf.js and the
WebAssembly build of llama.cpp are transferred to every visitor's browser and
executed there. MIT requires its notice "in all copies or substantial portions
of the Software". BSD-2-Clause requires it retained in source redistributions
and reproduced in the materials accompanying binary ones. Neither carries a
hosted-application exception, and a minified bundle served over HTTP is a copy
on either reading.

So the line that matters is **client-shipped versus server-only**, not hosted
versus installed.

Server-only dependencies — Express, `pg`, `sharp`, `multer`, `socket.io`'s
server half, everything in `server/package.json` — are deliberately **not**
listed here. No copy of them reaches a user.

## The one that is not a permissive licence

**`react-leaflet` is under the Hippocratic License 2.1, not MIT.** It is worth
reading before this is signed off on, for three reasons that do not apply to
anything else in the list:

1. **Its notice clause has a termination remedy.** "Licensee must ensure that
   everyone who gets a copy of any part of this Software from Licensee … also
   receives the License and the above copyright notice." If somebody gives
   written notice of non-compliance and it is not cured within 30 days, "Licensee's
   License (and all rights licensed hereunder) shall end immediately." MIT has
   no equivalent. The open item below is therefore sharper for this component
   than for the others.
2. **It carries use conditions, not just attribution.** Use must be consistent
   with the human-rights principles the licence names. For a school district
   volunteering platform this is not a practical constraint, but it is a
   condition on conduct rather than on notices, which is a different kind of
   obligation to accept.
3. **It is not OSI-approved.** Some districts' procurement and some funders
   require OSI-approved licences for software in the stack. That is a question
   for the owner, not an engineering one — but it cannot be answered if nobody
   knows the dependency is there.

`react-leaflet` is a thin binding over Leaflet itself, which is BSD-2-Clause. If
the Hippocratic terms are unacceptable to a district, the practical path is
using Leaflet directly rather than replacing the map.

## The one no tool will find for you

**llama.cpp and ggml are MIT-licensed and are compiled into `@wllama/wllama`'s
`.wasm` upstream.** They are a git submodule of that project, not an npm
dependency, so:

- no entry appears in `package-lock.json`;
- every npm-tree licence scanner reports wllama's MIT and stops;
- no JavaScript banner mentions them, because they are not JavaScript.

The largest single binary this application sends to a browser is compiled
llama.cpp, and it is invisible to the tooling that would otherwise produce this
list. It has to be added by hand, which is why this file is written by hand.

## The model weights are not ours to license

The on-device assistant downloads GGUF weights **directly from Hugging Face** —
`MODEL_BASE_URL` in `src/ai/models.js` is `https://huggingface.co`, and the
browser fetches from there. WeVolunteer publishes a URL; it does not transfer a
copy. Hugging Face is the distributor, so Apache-2.0 § 4's conditions are not
triggered against this project by that download.

All three registered models declare Apache-2.0, and `src/ai/models.js` carries
`license` and `licenseUrl` per entry which the enable screen shows before any
download starts. The claim in
[the AI policy](docs/legal/policies/12-ai-and-on-device-processing.md) that the
models are Apache-2.0 is therefore accurate as registered.

**If that ever changes, this section is void.** Self-hosting, mirroring,
proxying or re-quantizing the weights would make WeVolunteer the distributor and
bring Apache-2.0 § 4 into force — a copy of the licence would have to be served
with them. Not every model in the Qwen2.5 family is Apache-2.0 either: the 3B
and 72B variants are not, so a registry entry pointing at one of those would
make the AI policy's sentence false.

---

## Client-shipped components

Versions are those in `package-lock.json` at the time of writing. Copyright
lines are copied from each package's own `LICENSE` file, not from its
`package.json`.

| Component | Version | Licence | Copyright |
|---|---|---|---|
| `react` | 19.2.8 | MIT | Copyright (c) Meta Platforms, Inc. and affiliates. |
| `react-dom` | 19.2.8 | MIT | Copyright (c) Meta Platforms, Inc. and affiliates. |
| `react-router-dom` | 7.18.2 | MIT | Copyright (c) React Training LLC 2015-2019 · Copyright (c) Remix Software Inc. |
| `leaflet` | 1.9.4 | BSD-2-Clause | Copyright (c) 2010-2023, Volodymyr Agafonkin · Copyright (c) 2010-2011, CloudMade |
| `react-leaflet` | 5.0.0 | **Hippocratic-2.1** | react-leaflet Copyright 2020 Paul Le Cam and contributors |
| `lucide-react` | 1.27.0 | ISC | Copyright (c) 2026 Lucide Icons and Contributors |
| `pdfjs-dist` | 6.2.108 | Apache-2.0 | See the project's `LICENSE`; Mozilla Foundation and contributors |
| `jsqr` | 1.4.0 | Apache-2.0 | See the project's `LICENSE` |
| `@wllama/wllama` | 3.5.1 | MIT | Declared in `package.json`; the package ships **no `LICENSE` file** |
| **llama.cpp / ggml** | via wllama's `.wasm` | MIT | Copyright (c) 2023-2026 The ggml authors |
| `socket.io-client` | 4.8.3 | MIT | Copyright (c) 2014-present Guillermo Rauch and Socket contributors |
| `@amplitude/unified` | 1.1.x | MIT | See the project's `LICENSE`. Loaded only when a user opts in to analytics |

Two notes on that table:

- `@wllama/wllama` declares MIT in `package.json` and ships no `LICENSE` file, so
  the copyright line cannot be quoted from the package. Take it from the
  repository when this becomes a served page.
- `pdfjs-dist` is dynamically imported and is absent from builds with the AI
  flag off (`src/ai/bundleCost.test.js` pins that). It is still listed, because
  the default build includes it.

---

## Open item: the bundle ships no notices

**Measured, not assumed.** `react/cjs/react.production.js` begins with
`@license React` / `Copyright (c) Meta Platforms, Inc. and affiliates.`. After
`npm run build`, `grep -oE "@license|Copyright \(c\)" dist/assets/*.js` returns
**zero matches**. The banners are present upstream and are removed on the way
into the bundle.

Vite's production default drops legal comments. Setting
`esbuild: { legalComments: 'eof' }` in `vite.config.js` **does not fix it** — that
was tried, with a clean `dist/` and no `node_modules/.vite` cache, and produced a
byte-identical bundle with the same content hash. Vite's top-level `esbuild`
options reach the transform step, not the minifier. It is deliberately not left
in the config: an option that reads as compliance and changes nothing is worse
than no option, because the next person to check will believe it works.

Two ways to actually discharge this, both owner decisions because both add
product surface:

1. **A `/licenses` route** rendering this inventory plus the full text of MIT,
   BSD-2-Clause, Apache-2.0, ISC and Hippocratic-2.1. This is the durable fix,
   it is what Apache-2.0 § 4(d) explicitly contemplates ("within a display
   generated by the Derivative Works"), and it is the only option that can cover
   llama.cpp/ggml, since no JS banner ever will.
2. **Restore banners in the bundle**, via a minifier that honours a
   comment-preservation setting. Cheaper, invisible to users, and covers only the
   JavaScript.

Doing (1) makes (2) optional. Recommended: (1), generated from a build-time
dependency scan so it cannot drift, with llama.cpp/ggml appended by hand for the
reason given above.

`server/thirdPartyNotices.test.js` fails the build if a client-shipped
dependency is added and not recorded here. It cannot tell whether the notices
are actually delivered — that is what this section is for.
