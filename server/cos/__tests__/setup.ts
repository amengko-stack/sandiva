// Runs before test files are imported: point sql.js at a throwaway DB file
// so tests never touch the real data.db.
import path from "path";
import os from "os";
import fs from "fs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cos-test-"));
process.env.DATA_DB_PATH = path.join(dir, "test.db");
// Ensure the LLM path is never taken in tests
delete process.env.ANTHROPIC_API_KEY;
