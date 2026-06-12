import { verifyDocx } from "../lib/docx-verify";
import fs from "fs";
const good = fs.readFileSync("/tmp/local-selftest.docx");
const v = verifyDocx(good);
console.log("good file: bad=", v.bad, "illegal=", v.illegal);
// negative control: flip one byte inside a deflate stream
const corrupt = Buffer.from(good);
corrupt[Math.floor(corrupt.length / 2)] ^= 0xff;
try {
  const v2 = verifyDocx(corrupt);
  console.log("corrupt file: bad=", v2.bad, "illegal=", v2.illegal);
} catch (e) { console.log("corrupt file: threw:", (e as Error).message); }
