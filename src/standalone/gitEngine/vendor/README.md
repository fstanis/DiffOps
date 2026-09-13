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

The worker also instantiates the wasm itself (the `instantiateWasm` module
option) to reach the exports this build keeps off the module object. It wants
one: `__emscripten_stack_alloc`, minified to **`fa`** in these artifacts,
which git-worker.ts uses to hand back the stack Emscripten's `callMain` leaks
on every git command. A rebuild can rename it; the worker verifies the export
behaves like a stack allocator before trusting it and logs an error when it
does not, so re-check that name whenever these artifacts are regenerated.

`libgit2-COPYING` is libgit2's license (GPLv2 with linking exception); the
upstream project is MIT-licensed overall, see the wasm-git repository.
