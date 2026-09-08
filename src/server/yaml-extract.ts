/**
 * Port of `_extract_yaml` from post_daily_threads.py.
 *
 * Reddit wiki pages wrap YAML in one of three ways, tried in this order:
 *   1. ``` fenced block  -> content between the FIRST and LAST fence
 *   2. 4-space indented block (old-Reddit wiki style) -> strip the indent
 *   3. raw YAML -> return unchanged
 *
 * Kept as a standalone pure function so it can be unit tested without Redis,
 * the Reddit client, or a running Devvit environment.
 */
export function extractYaml(text: string): string {
  const lines = text.split('\n')

  const fenceIdxs: number[] = []
  for (let i = 0; i < lines.length; i++) {
    if ((lines[i] ?? '').trim().startsWith('```')) fenceIdxs.push(i)
  }
  if (fenceIdxs.length >= 2) {
    const first = fenceIdxs[0] as number
    const last = fenceIdxs[fenceIdxs.length - 1] as number
    return lines.slice(first + 1, last).join('\n')
  }

  let start: number | undefined
  for (let i = 0; i < lines.length; i++) {
    if ((lines[i] ?? '').startsWith('    ')) {
      start = i
      break
    }
  }
  if (start !== undefined) {
    const out: string[] = []
    for (const line of lines.slice(start)) {
      if (line.startsWith('    ')) out.push(line.slice(4))
      else if (line.trim() === '') out.push('')
      else break
    }
    return out.join('\n')
  }

  return text
}
