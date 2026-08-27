// Cloudflare Pages "Advanced Mode" entrypoint.
//
// This file MUST be named `_worker.js` and live at the root of the Pages
// build output directory (see `pages_build_output_dir` in wrangler.toml).
// Wrangler's Pages dev/deploy tooling looks for exactly this filename in
// that directory to decide whether to bypass the file-based `functions/`
// router entirely ("Advanced Mode"); it does not look inside `functions/`
// for this file, and it does not recognize a `.ts` extension here.
//
// The actual (type-checked) routing logic and Durable Object export live in
// `../functions/_worker.ts` -- this file just re-exports them so Wrangler's
// esbuild-based bundler (which resolves and type-strips `.ts` imports
// automatically) can find the real entrypoint.
export { JobDurableObject } from "../functions/_worker.ts";
export { default } from "../functions/_worker.ts";
