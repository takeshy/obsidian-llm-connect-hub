import { build } from "esbuild";
await build({ entryPoints: ["src/main.ts"], bundle: true, platform: "browser", format: "cjs", target: "es2022", external: ["obsidian"], outfile: "main.js", minify: true });
