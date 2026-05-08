import fs from 'node:fs';
import path from 'node:path';
import pdfParse from 'pdf-parse';

async function main() {
  const pdfPath = path.resolve(process.argv[2]!);
  const buf = await fs.promises.readFile(pdfPath);
  const parsed = await pdfParse(buf);
  const lines = parsed.text.split('\n').filter((l: string) => l.trim().length > 0);
  const limit = Number(process.argv[3] || 100);
  for (let i = 0; i < Math.min(lines.length, limit); i++) {
    console.log(`${(i + 1).toString().padStart(3)}| ${lines[i]}`);
  }
  console.log(`\n--- Total: ${lines.length} non-empty lines ---`);
}
main();
