# Vendored wasm-git engine

`lg2_workerfs.js` + `lg2_workerfs.wasm` are the WORKERFS build of
[wasm-git](https://github.com/petersalomonsen/wasm-git) (libgit2 compiled to
WebAssembly). The npm package (0.0.17) does not publish this build yet, so the
artifacts are vendored from the local clone that the WORKERFS approach was
prototyped against (`~/git/wasm-git`, commit `06d07a6`, built via its
`setup.sh` + `emscriptenbuild`).

Reproduce by checking out wasm-git at that commit and copying
`emscriptenbuild/libgit2/examples/lg2_workerfs.{js,wasm}` (the repo's
`preparepublishnpm.sh` does the same for the other builds). The default
console echo of git output is suppressed at runtime by passing capture-only
`print`/`printErr` module options (see git-worker.ts) — no local edits.

`libgit2-COPYING` is libgit2's license (GPLv2 with linking exception); the
upstream project is MIT-licensed overall, see the wasm-git repository.
