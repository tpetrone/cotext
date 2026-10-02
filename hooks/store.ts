import type { Annotation, ReviewFile } from '../types'

export const REVIEW_PATH = '.review/review.json'

/**
 * The annotations in review.json's text. Throws on a file it cannot read
 * rather than answer empty, so a later save never overwrites it.
 */
export function parseReview(text: string): Annotation[] {
  let parsed: Partial<ReviewFile>
  try {
    parsed = JSON.parse(text) as Partial<ReviewFile>
  } catch {
    throw new Error(`${REVIEW_PATH} is not valid JSON. Fix or move it, then try again.`)
  }
  if (parsed.version !== 1 || !Array.isArray(parsed.annotations)) {
    throw new Error(`${REVIEW_PATH} is not a version 1 review file.`)
  }

  return parsed.annotations
}

export function serializeReview(annotations: Annotation[]): string {
  const file: ReviewFile = { version: 1, annotations }

  return JSON.stringify(file, null, 2) + '\n'
}
