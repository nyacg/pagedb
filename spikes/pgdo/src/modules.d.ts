declare module "*.wasm" { const m: WebAssembly.Module; export default m; }
declare module "*.data" { const b: ArrayBuffer; export default b; }
