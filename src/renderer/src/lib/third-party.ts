/**
 * The third-party components MCode redistributes that carry notice obligations,
 * for the 第三方许可 dialog on the update page. MiMo ships these same pieces
 * with no notice at all; MCode lists them because the licences ask for it.
 *
 * Licence texts are kept in their original English and loaded only when the
 * dialog opens. Where a package ships its own licence file, that file is read
 * directly, so the text cannot drift from what was installed.
 */
export interface ThirdPartyNotice {
  id: string
  name: string
  version: string
  license: string
  /** Copyright lines and what the component is for, shown above the licence text. */
  about: string
  /** Where its source code is. */
  source: string
  text: () => Promise<string>
}

const raw = (module: Promise<{ default: string }>) => module.then((loaded) => loaded.default)

export const THIRD_PARTY: ThirdPartyNotice[] = [
  {
    id: "fluidsynth",
    name: "FluidSynth (fluidsynth-emscripten) with libsndfile",
    version: "FluidSynth 2.4.6, libsndfile 1.2.2",
    license: "LGPL-2.1",
    about: [
      "FluidSynth - A Software Synthesizer. Copyright (C) 2003 Peter Hanappe and others.",
      "libsndfile. Copyright (C) Erik de Castro Lopo and contributors.",
      "",
      "Plays a reply's ABC score. MCode ships the WebAssembly build",
      "libfluidsynth-2.4.6-with-libsndfile.js exactly as the js-synthesizer 1.13.0",
      "package distributes it, unmodified, as a separate file outside the app",
      "archive (resources/app.asar.unpacked/out/renderer/vendor/), together with",
      "this licence. You may replace that file with your own build of the same",
      "library; nothing in MCode's terms forbids modifying it, or reverse",
      "engineering MCode to debug such modifications.",
      "",
      "Source code: https://github.com/jet2jet/fluidsynth-emscripten",
      "FluidSynth: https://github.com/FluidSynth/fluidsynth",
      "libsndfile: https://github.com/libsndfile/libsndfile",
    ].join("\n"),
    source: "https://github.com/jet2jet/fluidsynth-emscripten",
    text: () => raw(import("js-synthesizer/externals/LICENSE.fluidsynth.txt?raw")),
  },
  {
    id: "codecs",
    name: "libvorbis, libogg, libFLAC, libopus",
    version: "libvorbis 1.3.7, libFLAC 1.3.2, libopus 1.3.1",
    license: "BSD-3-Clause",
    about: "Linked into the FluidSynth build above, so that it can read the compressed samples of an SF3 soundfont.",
    source: "https://github.com/xiph",
    text: () => raw(import("@resources/licenses/xiph-codecs.txt?raw")),
  },
  {
    id: "js-synthesizer",
    name: "js-synthesizer",
    version: "1.13.0",
    license: "BSD-3-Clause",
    about: "Copyright (C) 2018 jet. The JavaScript interface MCode drives FluidSynth through.",
    source: "https://github.com/jet2jet/js-synthesizer",
    text: () => raw(import("js-synthesizer/LICENSE?raw")),
  },
  {
    id: "abcjs",
    name: "abcjs",
    version: "6.7.0",
    license: "MIT",
    about: "Copyright (c) 2009-2026 Paul Rosen and Gregory Dyke. Draws ABC scores and writes their MIDI.",
    source: "https://github.com/paulrosen/abcjs",
    text: () => raw(import("abcjs/LICENSE.md?raw")),
  },
  {
    id: "musescore-general",
    name: "MuseScore_General soundfont",
    version: "0.2",
    license: "MIT",
    about: "Copyright Frank Wen 2000-02, Michael Cowgill 2014-17, S. Christian Collins 2018-20. The instruments a score plays with.",
    source: "https://ftp.osuosl.org/pub/musescore/soundfont/MuseScore_General/",
    text: () => raw(import("@resources/licenses/musescore-general.txt?raw")),
  },
]
