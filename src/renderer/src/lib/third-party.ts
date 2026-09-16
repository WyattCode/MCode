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
    version: "libvorbis 1.3.7, libFLAC 1.3.2, libopus 1.3.1, libogg version unknown",
    license: "BSD-3-Clause",
    about: [
      "Copyright Xiph.Org Foundation, Josh Coalson and the other holders named in the notices below.",
      "",
      "Linked into the FluidSynth build above, so that it can read the compressed samples of an SF3",
      "soundfont. The versions are the ones that build reports of itself; it carries no libogg version",
      "string, so none is stated here.",
    ].join("\n"),
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
    about: [
      "Copyright Frank Wen 2000-02, Michael Cowgill 2014-17, S. Christian Collins 2018-20,",
      "with Temple Blocks by Ethan Winer 2002 and Drumline Cymbals by Michael Schorsch 2016.",
      "",
      "The instruments a score plays with. Its licence asks that its acknowledgements and",
      "copyright notices travel with it, so the text below carries them in full.",
    ].join("\n"),
    source: "https://ftp.osuosl.org/pub/musescore/soundfont/MuseScore_General/",
    text: () => raw(import("@resources/licenses/musescore-general.txt?raw")),
  },
  /*
   * The bundled runtimes (Windows package): official builds, unmodified, in
   * resources/runtimes. scripts/runtimes.mjs writes these four texts from the
   * very files it ships and fails a package build when they differ.
   */
  {
    id: "node",
    name: "Node.js",
    version: "24.18.1",
    license: "MIT, with the licences of the libraries it includes",
    about: [
      "Copyright Node.js contributors and the other holders named in the notice below.",
      "",
      "The JavaScript runtime MCode's agent can run scripts and tools with (MCODE_NODE),",
      "shipped as the official Windows build with its npm.",
    ].join("\n"),
    source: "https://github.com/nodejs/node",
    text: () => raw(import("@resources/licenses/node.txt?raw")),
  },
  {
    id: "python",
    name: "Python (python-build-standalone)",
    version: "3.12.13, build 20260807",
    license: "PSF-2.0, with the licences of the libraries it links",
    about: [
      "Copyright Python Software Foundation and the other holders named in the notices below.",
      "",
      "The Python interpreter MCode's agent and its built-in skills use (MCODE_PYTHON), as the",
      "python-build-standalone project builds it; OpenSSL, libffi, SQLite, Tcl/Tk and the other",
      "libraries it links carry their own notices, which follow CPython's.",
    ].join("\n"),
    source: "https://github.com/astral-sh/python-build-standalone",
    text: () => raw(import("@resources/licenses/python.txt?raw")),
  },
  {
    id: "python-packages",
    name: "Python packages in the bundled Python",
    version:
      "chardet 7.6.0, defusedxml 0.7.1, et_xmlfile 2.0.0, lxml 5.3.0, numpy 2.5.2, openpyxl 3.1.5, pandas 2.2.3, pillow 11.1.0, pip 26.1.2, pypdf 5.1.0, pypdfium2 5.12.1, python-dateutil 2.9.0.post0, python-docx 1.1.2, python-pptx 1.0.2, pytz 2026.3.post1, reportlab 4.2.5, six 1.17.0, typing_extensions 4.16.0, tzdata 2026.3, XlsxWriter 3.2.0",
    license: "Each package's own (BSD, MIT, Apache-2.0, PSF and others)",
    about: [
      "The document and data libraries the built-in skills read and write Office files, PDFs",
      "and tables with, installed from the wheels their projects publish on PyPI. Each",
      "package's licence files follow, as its wheel installed them.",
    ].join("\n"),
    source: "https://pypi.org",
    text: () => raw(import("@resources/licenses/python-packages.txt?raw")),
  },
  {
    id: "ripgrep",
    name: "ripgrep",
    version: "15.1.0",
    license: "MIT or Unlicense",
    about: "Copyright (c) 2015 Andrew Gallant. The fast text search tool named to the agent's shell (MCODE_RIPGREP_PATH).",
    source: "https://github.com/BurntSushi/ripgrep",
    text: () => raw(import("@resources/licenses/ripgrep.txt?raw")),
  },
]
