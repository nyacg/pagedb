import { build } from "esbuild";
await build({ entryPoints: [new URL("./src/main.ts", import.meta.url).pathname], outfile: new URL("./public/app.js", import.meta.url).pathname, bundle: true, format: "esm", target: "es2022", minify: true, logLevel: "info" });
await build({ entryPoints: [new URL("./src/hn/main.ts", import.meta.url).pathname], outfile: new URL("./public/hn.js", import.meta.url).pathname, bundle: true, format: "esm", target: "es2022", minify: true, logLevel: "info" });
await build({ entryPoints: [new URL("./src/place/main.ts", import.meta.url).pathname], outfile: new URL("./public/place.js", import.meta.url).pathname, bundle: true, format: "esm", target: "es2022", minify: true, logLevel: "info" });
await build({ entryPoints: [new URL("./src/sheet/main.ts", import.meta.url).pathname], outfile: new URL("./public/sheet.js", import.meta.url).pathname, bundle: true, format: "esm", target: "es2022", minify: true, logLevel: "info" });
