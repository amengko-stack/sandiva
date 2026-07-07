// Repair JSON that was cut off mid-generation (stop_reason=max_tokens):
// close the dangling string and every unclosed object/array with the RIGHT
// closer. A naive "append }" repair breaks on array-heavy schemas — `["a","b`
// must become `["a","b"]`, not `["a","b"}`.
export function repairTruncatedJson(jsonStr: string): string {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (const ch of jsonStr) {
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") {
      if (stack.length && stack[stack.length - 1] === ch) stack.pop();
    }
  }

  let repaired = jsonStr;
  if (escaped) repaired = repaired.slice(0, -1); // dangling lone backslash
  if (inString) repaired += '"';

  // A trailing comma or colon would still fail to parse once closed.
  const trimmed = repaired.replace(/\s+$/, "");
  if (trimmed.endsWith(":")) repaired = trimmed + '""';
  else if (trimmed.endsWith(",")) repaired = trimmed.slice(0, -1);

  while (stack.length) repaired += stack.pop();
  return repaired;
}
