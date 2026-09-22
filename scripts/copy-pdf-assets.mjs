import { cp, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const packageRoot = new URL('../node_modules/pdfjs-dist/', import.meta.url);
const destination = new URL('../static/pdf-assets/', import.meta.url);
await mkdir(destination, { recursive: true });
for (const directory of ['cmaps', 'standard_fonts', 'wasm']) {
  await cp(fileURLToPath(new URL(directory, packageRoot)), fileURLToPath(new URL(directory, destination)), { recursive: true });
}
